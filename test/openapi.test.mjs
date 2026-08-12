import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { route } from '../src/router.ts'
import { RESP_TTL } from '../src/cache.ts'

/**
 * public/openapi.json — THE PUBLISHED SPEC, HELD AGAINST THE CODE IT DESCRIBES.
 *
 * A specification is a second description of a thing that already has one, which makes it the most
 * drift-prone file in the repository: nothing breaks when it goes stale, and the people who find out
 * are the consumers it was written for. docs/API.md is the same class of document and had drifted
 * within a week of shipping — the Threads media proxy landed 2026-08-10 and the table still said two
 * platforms, and every line reference into src/worker.ts pointed at the wrong line.
 *
 * SO NOTHING HERE IS A SNAPSHOT OF THE SPEC. Every assertion derives its expected value from the
 * code — the Platform union, the API_COUNTS list, the error codes and statuses read out of the api
 * arm, the router's own answer for the documented path, RESP_TTL imported from the cache module —
 * and then compares. A test that re-stated the spec's contents would pass forever and prove nothing.
 *
 * THE STRONGEST CHECK IS THE LAST ONE: real answers, driven offline through handle(), validated
 * against the spec's schemas with additionalProperties:false. A field added to toApiPost fails it, a
 * field removed fails it, a field that changes type fails it, and a field that starts arriving null
 * fails it. That is the whole reason the schemas are strict rather than permissive.
 *
 * WHAT REMAINS UNGUARDED, stated plainly rather than implied:
 *   - Every `description` string. Prose cannot be derived; a wrong sentence still passes.
 *   - The examples' plausibility (`likes: 183000` is illustrative, not measured).
 *   - The timing figures in the endpoint description, which live in docs/API.md too.
 *   - Which platform actually emits which count, and which platforms carry a `title`.
 *   - Anything about the LIVE service: this suite never touches the network, so "mbedfx.app answers
 *     this" is out of reach here. The servers block is checked against wrangler.jsonc's routes,
 *     which is the desired state rather than an observation.
 *
 * NO NETWORK ANYWHERE. Every post is injected through deps.fetchPost, like test/api.test.mjs.
 * EVERY TEST GETS ITS OWN ID: muxInflight and metaInflight are module-level and isolate-lifetime.
 */

const SPEC = JSON.parse(readFileSync('public/openapi.json', 'utf8'))
const ORIGIN = 'https://mbedfx.app'
const WORKER = readFileSync('src/worker.ts', 'utf8')

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return {
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}
const fakeR2 = () => {
  const store = new Map()
  return {
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) {
      const v = store.get(k)
      return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null
    },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}
// TRANSLATE_GOOGLE off for the reason test/api.test.mjs gives: Google is tried first and it is the
// live internet. Nothing in this file is about the translation engine.
const envWith = (over = {}) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch(req) { return new Response(`asset:${new URL(req.url).pathname}`) } },
  MEDIA_CACHE: fakeR2(),
  TRANSLATE_GOOGLE: 'off',
  ...over,
})
const depsFor = post => ({
  cache: fakeCache(),
  fetchPost: async (...args) => (typeof post === 'function' ? post(...args) : post),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
  resolveMetaShare: async () => null,
})
const apiReq = url => new Request(`${ORIGIN}/_api/v1?url=${encodeURIComponent(url)}`)
const get = async (url, post, env = envWith()) => {
  const res = await handle(apiReq(url), env, ctx, depsFor(post))
  return { res, body: await res.json() }
}

/* -------------------------------------------------------------------------------------------------
 * A MINIMAL JSON SCHEMA VALIDATOR — deliberately, rather than a dependency.
 *
 * The suite has no test framework and the worker has one runtime dependency; pulling in ajv to check
 * a 400-line document would be the largest dependency decision in the repo, made for a test. What is
 * needed is the subset OpenAPI 3.1 schemas actually use here — $ref, const, enum, type (including
 * the ["string","null"] spelling this document leans on), properties/required/additionalProperties,
 * items, oneOf, minimum — and refusing anything it does not understand, so a schema keyword added
 * later cannot be silently ignored.
 * ---------------------------------------------------------------------------------------------- */
const KNOWN = new Set([
  '$ref', 'const', 'enum', 'type', 'properties', 'required', 'additionalProperties', 'items',
  'oneOf', 'minimum', 'minLength', 'description', 'format', 'example', 'examples', 'summary',
  'x-mbedfx-codes', 'x-mbedfx-sites',
])

const typeOf = v =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v

/** Errors as strings, plus the set of `Schema.property` pairs actually observed holding null. */
function validate(schema, value, where, seenNull, refName = null) {
  const errs = []
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) errs.push(`${where}: the validator does not understand schema keyword "${k}" — teach it or stop using it`)
  }
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '')
    const target = SPEC.components.schemas[name]
    if (!target) return [`${where}: unresolvable $ref ${schema.$ref}`]
    return validate(target, value, where, seenNull, name)
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map(s => validate(s, value, where, new Set(), refName))
    const ok = branches.filter(b => b.length === 0)
    if (ok.length !== 1) {
      return [`${where}: ${ok.length} of ${branches.length} oneOf branches matched ${JSON.stringify(value)}`]
    }
    // Re-run the winning branch so its null observations reach the caller's set.
    const winner = schema.oneOf[branches.findIndex(b => b.length === 0)]
    return validate(winner, value, where, seenNull, refName)
  }
  if ('const' in schema && value !== schema.const) {
    errs.push(`${where}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${where}: ${JSON.stringify(value)} is not one of the declared enum values`)
  }
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    const fits = allowed.some(t => t === actual || (t === 'integer' && Number.isInteger(value)))
    if (!fits) errs.push(`${where}: expected ${allowed.join('|')}, got ${actual} (${JSON.stringify(value)})`)
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errs.push(`${where}: ${value} is below the declared minimum ${schema.minimum}`)
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!(req in value)) errs.push(`${where}: required property "${req}" is absent from the answer`)
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties[k]
      if (!sub) {
        if (schema.additionalProperties === false) {
          errs.push(`${where}.${k}: the answer carries a key the spec does not document`)
        }
        continue
      }
      if (v === null && refName) seenNull.add(`${refName}.${k}`)
      errs.push(...validate(sub, v, `${where}.${k}`, seenNull, refName))
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((v, i) => errs.push(...validate(schema.items, v, `${where}[${i}]`, seenNull)))
  }
  return errs
}

const check = (name, value, seenNull = new Set()) => {
  const errs = validate({ $ref: `#/components/schemas/${name}` }, value, name, seenNull)
  assert.deepEqual(errs, [], errs.join('\n'))
  return seenNull
}

/* ------------------------------------------------------------------------------------------------- */

const post = (id, over = {}) => ({
  ref: { p: 'x', id },
  canonical: `https://x.com/specwatch/status/${id}`,
  author: {
    name: 'spec watch', handle: 'specwatch', url: 'https://x.com/specwatch',
    avatar: 'https://example.invalid/a.jpg',
  },
  text: 'a post that has to match its own specification',
  title: 'a title',
  createdAt: new Date('2026-08-05T09:00:00Z'),
  counts: { likes: 12, reposts: 4, replies: 3, views: 900 },
  sensitive: false,
  media: [{
    kind: 'video', url: 'https://example.invalid/v.mp4', w: 1280, h: 720,
    poster: 'https://example.invalid/p.jpg',
  }],
  quote: {
    ref: { p: 'x', id: '3000000000000000999' },
    canonical: 'https://x.com/quoted/status/3000000000000000999',
    author: { name: 'quoted', handle: 'quoted', url: 'https://x.com/quoted' },
    text: 'the quoted post', createdAt: new Date('2026-08-04T09:00:00Z'),
    counts: {}, sensitive: false, media: [],
  },
  ...over,
})

test('THE SPEC IS SERVED FROM A PATH THE ROUTER ANSWERS — a document nothing routes to is a file, not an endpoint', async () => {
  /**
   * SITE_PATHS is a closed allowlist and the asset binding answers for nothing else, so publishing
   * the document without adding the path serves a 404 to every consumer who follows the link — the
   * same failure test/landing-convert.test.mjs pins for the site's own og:image, and it looks
   * identical to not having published a spec at all.
   *
   * Driven through handle() rather than asserted on the route kind alone: the kind is what the
   * ROUTER says, and what matters is that the worker hands the request to the asset binding.
   */
  const path = Object.keys(SPEC.paths).find(p => p.endsWith('openapi.json'))
  assert.ok(path, 'the spec must document where it is served')
  assert.equal(route(new URL(`${ORIGIN}${path}`)).kind, 'site',
    `${path} must be an allowlisted asset path, or the published url 404s`)

  const res = await handle(new Request(`${ORIGIN}${path}`), envWith(), ctx, depsFor(null))
  assert.equal(await res.text(), `asset:${path}`, 'the worker must forward it to the asset binding')

  // And the file the binding serves is this one: public/ is the asset directory in wrangler.jsonc.
  assert.equal(SPEC.openapi.startsWith('3.1'), true, `OpenAPI 3.1 is what the ["string","null"] type spelling needs, got ${SPEC.openapi}`)
  assert.ok(SPEC.info.title && SPEC.info.version, 'info.title and info.version are required by the OpenAPI schema')
})

test('THE DOCUMENTED ENDPOINT AND ITS PARAMETER ARE THE ROUTER\'S OWN, not a second spelling of them', async () => {
  /**
   * The spec names a path and a query parameter. Both are decisions made in src/router.ts — `_api`,
   * `v1`, and `url` rather than the `p` the internal endpoints take — and a spec that spells either
   * differently sends every generated client somewhere the worker does not answer.
   *
   * Derived by ROUTING the spec's own strings: whatever the document says the endpoint is, route()
   * has to mint kind 'api' for it and carry the target through the parameter the document names.
   */
  const path = Object.keys(SPEC.paths).find(p => p !== '/openapi.json')
  assert.equal(path, '/_api/v1', 'v1 is the only version this document describes')

  const param = SPEC.paths[path].get.parameters[0]
  assert.equal(param.in, 'query')
  assert.equal(param.required, true, 'a missing url is a 400, so the parameter is required')

  const target = 'https://x.com/jack/status/20'
  const r = route(new URL(`${ORIGIN}${path}?${param.name}=${encodeURIComponent(target)}`))
  assert.deepEqual(r, { kind: 'api', target },
    `the router must read the parameter the spec names (${param.name})`)

  // The version lives in the path, which is the reason info.version is the contract version rather
  // than the release number: /_api/v2 is never answered with v1.
  assert.equal(SPEC.info.version, 'v1')
  assert.equal(route(new URL(`${ORIGIN}/_api/v2?url=${encodeURIComponent(target)}`)).kind, 'notfound')

  // The methods the spec documents are the ones the arm serves. POST is deliberately NOT an
  // operation — documenting it would make generators emit a POST client for an endpoint that reads.
  assert.deepEqual(Object.keys(SPEC.paths[path]).filter(k => !['summary', 'description'].includes(k)).sort(),
    ['get', 'head', 'options'])
})

test('EVERY PUBLISHED ERROR CODE AND ITS STATUS IS READ OUT OF THE WORKER, never listed by hand', () => {
  /**
   * The failure vocabulary is the half of this contract a consumer branches on, and it is assembled
   * in two places: apiFailure maps a route/gate outcome onto a code, and the api arm itself emits the
   * three request-level ones directly. A code added to either without reaching the spec is a value
   * appearing in the wild that no schema admits; a code REMOVED from the code while the spec still
   * advertises it is worse, because a consumer will have written a branch for it.
   *
   * Both directions fail here. The statuses are derived too — an answer about a POST is always 200,
   * and only the request-level failures are 4xx, which is the rule the whole endpoint is built on.
   */
  const from = WORKER.indexOf('function apiFailure(')
  assert.ok(from > 0, 'src/worker.ts still declares apiFailure — if it was renamed, rename it here too')
  const end = WORKER.indexOf('\n}\n', from)
  const fromFailure = [...WORKER.slice(from, end).matchAll(/code: '([a-z_]+)'/g)].map(m => m[1])

  // The direct emissions: apiError(<status>, '<code>', …). The failure arm passes a variable, so its
  // status is read from that call site instead and applies to every code apiFailure can return.
  const direct = [...WORKER.matchAll(/apiError\((\d{3}), '([a-z_]+)'/g)].map(m => ({ status: +m[1], code: m[2] }))
  assert.ok(WORKER.includes('apiError(200, code, message'),
    'the failure arm still answers 200 for every post-level code — if that changed, this derivation is wrong')

  const derived = new Map()
  for (const code of fromFailure) derived.set(code, 200)
  for (const { status, code } of direct) derived.set(code, status)

  const schema = SPEC.components.schemas.ApiError.properties.code
  assert.deepEqual([...schema.enum].sort(), [...derived.keys()].sort(),
    'the spec\'s error enum and the codes src/worker.ts can emit have diverged')
  assert.deepEqual(Object.keys(schema['x-mbedfx-codes']).sort(), [...derived.keys()].sort(),
    'every enum value needs its row explaining what produces it')
  for (const [code, status] of derived) {
    assert.equal(schema['x-mbedfx-codes'][code].status, status,
      `${code} is emitted with HTTP ${status}`)
  }

  // And the responses the operation declares are exactly the statuses that exist.
  assert.deepEqual(Object.keys(SPEC.paths['/_api/v1'].get.responses).sort(),
    [...new Set([...derived.values()])].map(String).sort())
})

test('THE PLATFORM ENUM IS THE Platform UNION, and the counts keys are API_COUNTS', () => {
  /**
   * Two lists the code owns. A platform added to src/types.ts and not here publishes a `platform`
   * value no generated type admits, which in a typed language is a parse failure rather than an
   * unknown string. A count key added to API_COUNTS and not here is the same shape, one level down.
   *
   * Parsed out of the source the same way test/types.test.mjs parses the union, rather than imported,
   * because a type is erased at runtime and API_COUNTS is not exported.
   */
  const types = readFileSync('src/types.ts', 'utf8')
  const m = types.match(/export type Platform =([^\n]+)/)
  assert.ok(m, 'src/types.ts must declare Platform on one line')
  const platforms = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1])
  assert.deepEqual([...SPEC.components.schemas.Platform.enum].sort(), [...platforms].sort())
  assert.deepEqual(Object.keys(SPEC.components.schemas.Platform['x-mbedfx-sites']).sort(), [...platforms].sort(),
    'every code needs the site name a reader can recognise')

  const counts = WORKER.match(/const API_COUNTS = \[([^\]]+)\]/)
  assert.ok(counts, 'src/worker.ts must declare API_COUNTS as a literal array')
  assert.deepEqual(
    Object.keys(SPEC.components.schemas.Counts.properties).sort(),
    [...counts[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort())
})

test('A REAL ANSWER VALIDATES AGAINST THE SPEC — every key documented, every documented key present', async () => {
  /**
   * THE CHECK THAT CATCHES THE DRIFT NOBODY MEANS TO CAUSE. toApiPost is edited to add a field, the
   * spec is not, and the document quietly starts describing a payload that no longer exists. The
   * schemas carry additionalProperties:false so an undocumented key FAILS rather than passing
   * unnoticed, which is the only way a specification stays worth reading.
   *
   * Three posts, because one cannot exercise both ends: everything present, everything hollow, and a
   * plain post with no quote and no media at all.
   */
  const full = await get('https://x.com/specwatch/status/3000000000000000001', post('3000000000000000001'))
  assert.equal(full.body.ok, true)
  check('PostEnvelope', full.body)

  /**
   * THE HOLLOW POST, which is not a hypothetical: post.counts, post.text and every author field come
   * out of the POST CACHE, and deserializePost validates the ref, the canonical and the date and
   * nothing else. The serialiser answers a wrong-typed value with null or "" rather than publishing
   * it, and the spec has to admit exactly those nulls.
   */
  const hollow = await get('https://x.com/specwatch/status/3000000000000000002',
    post('3000000000000000002', {
      author: {},
      title: undefined,
      text: 42,
      createdAt: new Date(0),
      counts: {},
      media: [{ kind: 'image', url: 'https://example.invalid/one.jpg', w: '800' }],
      quote: {
        ref: { p: 'x', id: '3000000000000000998' },
        canonical: '',
        author: {},
        text: {}, createdAt: new Date('2026-08-04T09:00:00Z'), counts: {}, sensitive: false, media: [],
      },
    }))
  const seenNull = check('PostEnvelope', hollow.body)

  const plain = await get('https://x.com/specwatch/status/3000000000000000003',
    post('3000000000000000003', { quote: undefined, media: [] }))
  check('PostEnvelope', plain.body, seenNull)

  /**
   * A STILL STANDING IN FOR A VIDEO, the shape a consumer most needs the spec to be right about: it
   * is published as `kind: "image"` and only `still` says a video is behind it. The muxing half of
   * that pair costs a nine-second deadline and is already pinned in test/api.test.mjs; this is the
   * permanent case, which is free.
   */
  const overCeiling = await get('https://x.com/specwatch/status/3000000000000000004',
    post('3000000000000000004', {
      media: [{
        kind: 'image', url: 'https://example.invalid/p.jpg', poster: 'https://example.invalid/p.jpg',
        w: 480, h: 360, posterOnly: true,
      }],
    }))
  check('PostEnvelope', overCeiling.body, seenNull)
  assert.equal(overCeiling.body.post.media[0].still, true)
  assert.equal(overCeiling.body.muxing, false)

  // The failure envelopes, one of each shape: candidates present, platform/canonical real, and null.
  const ambiguous = await get('https://x.com/jack', null)
  assert.equal(ambiguous.body.error.code, 'ambiguous')
  check('ErrorEnvelope', ambiguous.body, seenNull)

  const walled = await handle(apiReq('https://x.com/specwatch/status/3000000000000000005'), envWith(), ctx,
    depsFor(async (_ref, _env, _client, report) => { if (report) report.reason = 'private'; return null }))
  const walledBody = await walled.json()
  assert.equal(walledBody.error.code, 'private')
  assert.equal(walledBody.error.platform, 'x', 'a gate knows which site it is on')
  check('ErrorEnvelope', walledBody, seenNull)

  const noUrl = await handle(new Request(`${ORIGIN}/_api/v1`), envWith(), ctx, depsFor(null))
  check('ErrorEnvelope', await noUrl.json(), seenNull)

  /**
   * THE CONVERSE, and it is the half a schema author gets wrong in the safe-looking direction:
   * marking a field nullable that the code never nulls. It costs every consumer a branch they will
   * never take, and it is invisible until somebody reads the source. Every `null` the spec admits
   * must have been produced by one of the answers above.
   */
  const declared = []
  for (const [name, schema] of Object.entries(SPEC.components.schemas)) {
    for (const [prop, sub] of Object.entries(schema.properties || {})) {
      const nullable = (Array.isArray(sub.type) && sub.type.includes('null'))
        || (sub.oneOf || []).some(b => b.type === 'null')
      if (nullable) declared.push(`${name}.${prop}`)
    }
  }
  assert.deepEqual(declared.filter(d => !seenNull.has(d)), [],
    'the spec calls these nullable and no answer above produced null there — either the code cannot '
    + 'null them, or this test needs the case that does')
})

test('THE HEADERS THE SPEC EXAMPLES SHOW ARE THE HEADERS THE WORKER SENDS', async () => {
  /**
   * Cache-control is a contract too, and the one an intermediary acts on without asking. The complete
   * answer's max-age is RESP_TTL, imported rather than copied — a change there has to reach the
   * document, because a spec promising a fifteen-minute cache for a value that moved is worse than
   * one that says nothing.
   *
   * The `no-store` example is checked against a FAILURE envelope, which carries it for the same
   * reason an incomplete answer does. The incomplete case itself costs a nine-second mux deadline and
   * is pinned in test/api.test.mjs rather than paid for twice.
   */
  const headers = SPEC.paths['/_api/v1'].get.responses['200'].headers
  assert.equal(headers['cache-control'].examples.complete.value, `public, max-age=${RESP_TTL}`,
    'the documented max-age is RESP_TTL')

  const { res } = await get('https://x.com/specwatch/status/3000000000000000010', post('3000000000000000010'))
  assert.equal(res.headers.get('cache-control'), headers['cache-control'].examples.complete.value)
  assert.equal(res.headers.get('access-control-allow-origin'), headers['access-control-allow-origin'].example)
  assert.equal(res.headers.get('x-content-type-options'), headers['x-content-type-options'].example)

  const failed = await handle(new Request(`${ORIGIN}/_api/v1`), envWith(), ctx, depsFor(null))
  assert.equal(failed.headers.get('cache-control'), headers['cache-control'].examples.incomplete.value)
  assert.equal(failed.status, 400)

  // The preflight, whose whole value is the header set — a missing allow-methods and the browser
  // never sends the real request.
  const pre = SPEC.paths['/_api/v1'].options.responses['204'].headers
  const opt = await handle(new Request(`${ORIGIN}/_api/v1?url=x`, { method: 'OPTIONS' }), envWith(), ctx, depsFor(null))
  assert.equal(opt.status, 204)
  for (const [name, decl] of Object.entries(pre)) {
    assert.equal(opt.headers.get(name), decl.example, `the preflight's ${name}`)
  }
})

test('EVERY SOURCE CITATION IN docs/API.md STILL NAMES SOMETHING THAT EXISTS', () => {
  /**
   * THE DRIFT THAT ACTUALLY HAPPENED, and the reason this test exists beside the spec's. docs/API.md
   * shipped with 1.9.0 on 2026-08-04 citing about thirty line numbers in src/worker.ts. By
   * 2026-08-11 the file had grown roughly 140 lines and EVERY ONE of them pointed at unrelated code:
   * `apiHeaders` at :3008 landed in a comment about the pipeline, `toApiPost` at :3105-3171 in the
   * YouTube warm. Nothing failed, because nothing was checking.
   *
   * So the document cites NAMES now, and this is what makes that hold: each cited symbol must still
   * exist in the file it is cited from. A rename fails here rather than in a reader's afternoon.
   * Where a citation still carries a line number — the short, stable modules where one is genuinely
   * useful — that exact line has to contain the symbol, which is the strictest form available and
   * the reason those numbers can be trusted while the others could not.
   */
  const doc = readFileSync('docs/API.md', 'utf8')
  // The two spellings the document uses: "(`name`, `file`)" and "`name` (`file`)". Both are matched
  // rather than one being imposed, because a citation that reads naturally in its sentence is the
  // one that gets written; a test should not decide the prose.
  const cited = [
    ...doc.matchAll(/\(`([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?`,\s+`(src\/[A-Za-z0-9_./-]+?)(?::(\d+)(?:-\d+)?)?`/g),
    ...doc.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?`\s+\(`(src\/[A-Za-z0-9_./-]+?)(?::(\d+)(?:-\d+)?)?[`,]/g),
  ]
  assert.ok(cited.length >= 15, `expected the doc to cite the code it describes, found ${cited.length}`)

  const cache = new Map()
  const linesOf = f => {
    if (!cache.has(f)) cache.set(f, readFileSync(f, 'utf8').split('\n'))
    return cache.get(f)
  }
  for (const [, symbol, file, line] of cited) {
    const lines = linesOf(file)
    assert.ok(lines.some(l => l.includes(symbol)),
      `docs/API.md cites \`${symbol}\` in ${file}, which no longer contains it`)
    if (line) {
      assert.ok((lines[+line - 1] || '').includes(symbol),
        `docs/API.md cites \`${symbol}\` at ${file}:${line}, and that line reads: ${lines[+line - 1]}`)
    }
  }

  // And the numbers that rotted are gone rather than merely corrected: correcting them would put the
  // same file back on the same trajectory, one merge behind again.
  assert.equal(/src\/worker\.ts:\d/.test(doc), false,
    'docs/API.md cites symbols in src/worker.ts, not lines — that file moves every merge')
})

test('THE SERVERS ARE HOSTS THIS WORKER IS ROUTED TO', () => {
  /**
   * A servers block is where a consumer points a generated client, so a host listed here that the
   * worker does not answer on is a spec that hands somebody a dead base url. wrangler.jsonc's routes
   * array is the DESIRED STATE — every deploy reconciles Cloudflare to it — which makes it the right
   * thing to check against; that it is not an observation of the live edge is the limit of this test.
   */
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const routed = cfg.routes.map(r => r.pattern)
  for (const s of SPEC.servers) {
    assert.ok(routed.includes(new URL(s.url).hostname),
      `${s.url} is not in wrangler.jsonc's routes — a base url nothing serves`)
    assert.ok(s.description, 'each server needs a line saying what it is')
  }
})
