import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * MEDIA_CACHE AS A DIRECTORY. It stands in for the R2 bucket, one file per key.
 *
 * WHAT IT REPLACES: the `mbedfx-media` R2 bucket (wrangler.production.jsonc). The worker keeps six kinds of thing
 * there: muxed mp4s (`mux/…`), container metadata records (`meta/…`), translations (`xlate/…`), the
 * Reddit archive copy (`rd-archive/…`), the alarm's give-up marks (`muxfail/…`) and the scheduled
 * check's week (`health/smoke.json`).
 *
 * WHAT DEGRADES: nothing the worker reads. It calls `head`, `get` (whole or one range), `put`,
 * `delete` and the optional `putStream`, and every one of them is here. What is missing is R2's own
 * surface that nothing in `src/` touches: `list`, multipart uploads, `httpMetadata` (accepted and
 * dropped: no read site exists), conditional gets and checksums. There is no expiry either. The R2
 * bucket has a 60-day lifecycle rule (expire-60d, wrangler.production.jsonc) and nothing here does that
 * job, so the directory grows without bound. Every kind is regenerable cache, so delete files older
 * than 60 days to match the bucket, for example
 * `find "$MEDIA_CACHE_DIR" -maxdepth 1 -type f -mtime +60 -delete` (under compose, /data/media in the
 * adapter container). The `mux%2f` files are the large ones.
 *
 * THREE PROPERTIES THE WORKER DEPENDS ON, each of which a naive "write the file" gets wrong:
 *
 *   1. `uploaded` IS A Date. `gaveUpIsFresh` (src/muxpolicy.ts) checks `instanceof Date` and
 *      readCachedMeta calls `.getTime()` on it. The test fakes in this repo leave it out and both
 *      paths then fail silently: a give-up mark that is never fresh, a record that always reads as a
 *      miss. Here it is the file's mtime, which a write-then-rename sets to the moment of the write.
 *   2. A READER NEVER SEES HALF A FILE. pollHead (src/worker.ts) polls `head` every 250 ms while
 *      another request is writing the same key, and the first non-null head is served. Writing in
 *      place would hand that poller a file that is still growing. Every write goes to `#tmp/` and is
 *      renamed into place, which is atomic on one filesystem, so a key is absent or complete.
 *   3. A ZERO-BYTE OBJECT EXISTS. The give-up mark is `put(key, '')`, and `head` must answer it with
 *      an object rather than null, or the alarm's verdict is forgotten on the next render.
 */

/** Temp files and hashed long keys live under names no encoded key can produce: see keyFile. */
const TMP_DIR = '#tmp'

/**
 * A key's file name. ONE FLAT DIRECTORY, because R2 keys are flat: mapping `/` to directories would
 * make `a/b` and `a` unable to coexist, which R2 allows.
 *
 * `encodeURIComponent` turns every `/` into `%2f`, so no key can climb out of the root (`..` and `.`
 * are the only names it leaves alone, and a key that is exactly one of them gets the hashed name).
 * Then two rewrites, both reversible:
 *   - percent escapes are lowercased, and
 *   - every remaining capital becomes `^` plus its lowercase.
 * Together they leave no capital letter in the name. That matters because YouTube ids are
 * case-sensitive and macOS and Windows filesystems are not: `jNQXAC9IVRw` and `jnqxac9ivrw` are two
 * videos, and on a case-folding disk they would share one file and serve each other's bytes. A raw
 * `^` in a key is encoded as `%5e` first, so the marker cannot be forged.
 *
 * `#` is always encoded too (`%23`), which is why `#tmp` and the `#<sha256>` fallback for a name past
 * 240 bytes (NAME_MAX is 255 on every common filesystem) can never collide with a real key.
 */
export function keyFile(key: string): string {
  const enc = encodeURIComponent(key)
    .replace(/%[0-9A-F]{2}/g, m => m.toLowerCase())
    .replace(/[A-Z]/g, c => '^' + c.toLowerCase())
  if (enc === '' || enc === '.' || enc === '..' || Buffer.byteLength(enc) > 240) {
    return '#' + createHash('sha256').update(key).digest('hex')
  }
  return enc
}

type Range = { offset?: number; length?: number; suffix?: number }
type PutValue = string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null

/** The R2Object fields the worker reads: `size` and `uploaded` (head), plus the body readers (get). */
export type DirObject = {
  key: string
  size: number
  uploaded: Date
  range?: { offset: number; length: number }
  readonly body: ReadableStream
  readonly bodyUsed: boolean
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  arrayBuffer(): Promise<ArrayBuffer>
}

const isMissing = (err: unknown) => (err as { code?: string })?.code === 'ENOENT'

/** R2's range semantics on a file of `size` bytes: [start, end), clamped to the file. */
function span(size: number, r?: Range): { start: number; end: number } {
  if (!r) return { start: 0, end: size }
  if (typeof r.suffix === 'number') return { start: Math.max(0, size - r.suffix), end: size }
  const start = Math.min(Math.max(0, r.offset ?? 0), size)
  const end = typeof r.length === 'number' ? Math.min(size, start + Math.max(0, r.length)) : size
  return { start, end }
}

export class DirBucket {
  readonly root: string
  #ready: Promise<void>

  constructor(root: string) {
    this.root = root
    // Created once, up front, so a first write does not race a second one into mkdir. A temp file
    // older than an hour is a write that died with its process; one that is newer may belong to a
    // second adapter sharing this directory, so it is left alone.
    this.#ready = mkdir(join(root, TMP_DIR), { recursive: true }).then(() => this.#sweep(60 * 60_000))
  }

  #path(key: string): string {
    return join(this.root, keyFile(key))
  }

  async #sweep(olderThanMs: number): Promise<void> {
    try {
      const dir = join(this.root, TMP_DIR)
      for (const name of await readdir(dir)) {
        const p = join(dir, name)
        const st = await stat(p).catch(() => null)
        if (st && Date.now() - st.mtimeMs > olderThanMs) await unlink(p).catch(() => undefined)
      }
    } catch { /* a sweep that fails leaves litter, never a wrong answer */ }
  }

  async head(key: string): Promise<{ key: string; size: number; uploaded: Date } | null> {
    try {
      const st = await stat(this.#path(key))
      return { key, size: st.size, uploaded: st.mtime }
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  /**
   * The body is LAZY and the text readers go straight to the file. Opening a stream here would hold a
   * file descriptor for every caller that only wants `.json()` (readCachedMeta, the translation cache,
   * the health week), and a descriptor nobody reads leaks until the process runs out.
   *
   * Size and `uploaded` come from the stat taken now; the bytes are read when asked for. If the key is
   * rewritten in between, the reader gets the newer complete file (property 2 above). The only keys
   * that are ever rewritten are small JSON records read whole; an mp4 is written once per key, because
   * ensureMuxed heads before it muxes.
   */
  async get(key: string, options?: { range?: Range }): Promise<DirObject | null> {
    const path = this.#path(key)
    let st
    try {
      st = await stat(path)
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
    const { start, end } = span(st.size, options?.range)
    let used = false
    const take = () => {
      if (used) throw new TypeError('body already used')
      used = true
    }
    const bytes = async (): Promise<Buffer> => {
      take()
      const all = await readFile(path)
      return start === 0 && end === all.length ? all : all.subarray(start, end)
    }
    let body: ReadableStream | null = null
    return {
      key,
      size: st.size,
      uploaded: st.mtime,
      ...(options?.range ? { range: { offset: start, length: end - start } } : {}),
      get body() {
        if (!body) {
          take()
          // createReadStream's `end` is INCLUSIVE, and an empty span has no inclusive end at all.
          body = end > start
            ? Readable.toWeb(createReadStream(path, { start, end: end - 1 })) as unknown as ReadableStream
            : new Response('').body!
        }
        return body
      },
      get bodyUsed() { return used },
      async text() { return (await bytes()).toString('utf8') },
      async json<T>() { return JSON.parse((await bytes()).toString('utf8')) as T },
      async arrayBuffer() {
        const b = await bytes()
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
      },
    }
  }

  async put(key: string, value: PutValue, _options?: unknown): Promise<{ key: string; size: number; uploaded: Date }> {
    const source = value instanceof ReadableStream ? value : await toBytes(value)
    return this.#write(key, source, null)
  }

  /**
   * THE STREAMING SEAM putMuxed looks for (src/worker.ts, StreamingBucket), so a muxed mp4 goes from the
   * container's socket to disk without sitting in memory. Without it every mux would be buffered whole
   * and refused above MUX_BUFFER_MAX (64 MB by default).
   *
   * A STREAM THAT ENDS SHORT IS NOT STORED. The container always sends content-length; a transfer that
   * delivers fewer bytes was cut off, and keeping it would serve a truncated video under this key
   * forever, because nothing re-muxes a key that heads. It rejects instead, as an R2 put does when an
   * upload fails.
   */
  async putStream(key: string, stream: ReadableStream, length: number | null): Promise<void> {
    await this.#write(key, stream, length)
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      try {
        await unlink(this.#path(key))
      } catch (err) {
        if (!isMissing(err)) throw err
      }
    }
  }

  async #write(key: string, source: Uint8Array | ReadableStream, length: number | null) {
    await this.#ready
    const tmp = join(this.root, TMP_DIR, `${randomBytes(8).toString('hex')}.part`)
    try {
      if (source instanceof Uint8Array) {
        await pipeline(Readable.from([source]), createWriteStream(tmp))
      } else {
        await pipeline(Readable.fromWeb(source as never), createWriteStream(tmp))
      }
      const st = await stat(tmp)
      if (length !== null && st.size !== length) {
        throw new Error(`short write: ${st.size} of ${length} bytes`)
      }
      await rename(tmp, this.#path(key))
      const done = await stat(this.#path(key))
      return { key, size: done.size, uploaded: done.mtime }
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
  }
}

async function toBytes(value: Exclude<PutValue, ReadableStream>): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array(0)
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(await (value as Blob).arrayBuffer())
}
