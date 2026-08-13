/**
 * THE ADDRESS HALF OF THE SSRF BOUNDARY — "is this destination somewhere on the public internet, or
 * is it us / the LAN / the metadata service?" — ported from the guard container/server.py has had
 * since it was written (`_safe_url`: `ip.is_private or ip.is_loopback or ip.is_link_local or
 * ip.is_reserved or ip.is_multicast or ip.is_unspecified`).
 *
 * WHY THE WORKER NEEDS ITS OWN COPY NOW. On Cloudflare the Worker half has never had one, and
 * docs/SELF-HOSTING.md records why that survived: a fediverse host arrives from a path segment, and
 * the three clauses around it (no credential is attached, the body is capped, the response must be
 * the right SHAPE) bound the worst case to a blind GET from Cloudflare's egress. OFF Cloudflare the
 * same blind GET leaves a box that is usually INSIDE something: `fetch()` reaches 127.0.0.1, the
 * LAN, and the link-local metadata endpoint on 169.254.169.254 that hands out cloud credentials.
 * The bound that made the gap survivable is the exact thing self-hosting removes.
 *
 * WHAT THIS FILE IS NOT. It does not resolve DNS — a Worker cannot. `blockedHost` reads the
 * hostname TEXT, which catches every literal spelling of a private address; `blockedResolvedHost`
 * is the seam a self-hosted runtime plugs its resolver into, which is what closes "a public name
 * with a private A record". Both are needed and neither is sufficient: on Workers only the first
 * one runs, exactly as much as the platform allows.
 *
 * =============================================================================================
 * THE RULE THIS PROJECT ALREADY LEARNED THE HARD WAY, and the reason the parser below is written
 * the long way instead of as a list of string prefixes:
 *
 *   A PREFIX-BASED BLOCKLIST ON THE TEXT OF AN IPv6 ADDRESS IS NOT A GUARD.
 *
 * `::ffff:127.0.0.1` is loopback and starts with neither `fc` nor `fe80` nor `::1`. So is
 * `::ffff:7f00:1`, which is the SAME address with the embedded v4 written in hex, so a blocklist
 * that grew an `::ffff:127.` entry still misses it. So is `0:0:0:0:0:ffff:7f00:1` fully expanded,
 * `[::ffff:169.254.169.254]` bracketed as a URL host, `64:ff9b::7f00:1` through the NAT64
 * well-known prefix, and `2002:7f00:1::` through 6to4. Every one of those is a different STRING
 * naming the same unreachable-from-the-internet destination.
 *
 * So: parse the address to BYTES, extract any embedded IPv4, and range-check the numbers. That is
 * the only form of this check that does not have to be re-audited every time somebody invents
 * another spelling. test/netguard.test.mjs feeds it the spellings a prefix guard passes.
 * =============================================================================================
 *
 * TOTAL AND PURE. Every function here returns a verdict for any input, including junk, and does no
 * I/O — so a fetcher may call it before spending a request, and the whole thing tests offline.
 *
 * WHERE IT IS APPLIED, AND WHY NOT EVERYWHERE, since "one guard, one boundary" is the obvious next
 * question. The fediverse clients are the only place a user's bytes decide the ORIGIN of a fetch, so
 * they are the only place this runs (src/platforms/fedihost.ts, clause 7). The other egress sites do
 * not need it and would not be improved by it:
 *
 *   - src/mediaproxy.ts fetches only hosts under a suffix ALLOWLIST (Meta's two CDNs, plus Twitch's
 *     clip fleet by shape). An allowlist is strictly stronger than a blocklist; nothing private
 *     matches `cdninstagram.com`.
 *   - Every other platform fetcher builds a FIXED origin (api.x.com, bsky.app, reddit.com …) with the
 *     user's part confined to a path segment or a query parameter.
 *   - The container guards itself, at the point where it has a resolver: container/server.py resolves
 *     each host and refuses the same ranges before ffmpeg or yt-dlp ever sees the url.
 *
 * A NEW route that fetches a user-supplied host belongs behind this file, and adding one without it
 * is the regression this paragraph exists to make obvious.
 */

/**
 * A HOST RESOLVER, the one seam this file cannot fill itself.
 *
 * Returns every address the name maps to, as text (`['93.184.216.34', '2606:2800:220:1::248']`) —
 * the shape `dns.promises.lookup(host, { all: true })` and `getaddrinfo` both already produce, so a
 * Node adapter supplies about three lines and nothing here has to know about Node.
 *
 * EVERY address, not the first: a name with one public A record and one private one is the whole
 * attack, and container/server.py loops over the full `getaddrinfo` result for that reason.
 */
export type HostResolver = (host: string) => Promise<string[]>

/**
 * Parse a decimal / octal / hex integer the way `inet_aton` does, because that is what the callers
 * downstream of us do.
 *
 * DELIBERATELY PERMISSIVE, and it is the safe direction. `new URL('http://0177.0.0.1/')` normalizes
 * its host to `127.0.0.1`, and so does every C resolver — so a guard that only understood strict
 * dotted-quad would call `0177.0.0.1` "not an address", fall through to the hostname rules, and pass
 * loopback. Reading MORE strings as addresses can only block more; it cannot admit anything, because
 * a real hostname's labels are not all numeric (a numeric TLD does not exist).
 */
function intOf(part: string): number | null {
  if (!part) return null
  if (/^0[xX][0-9a-fA-F]{1,8}$/.test(part)) return parseInt(part.slice(2), 16)
  if (/^0[0-7]{0,10}$/.test(part)) return parseInt(part, 8)
  if (/^[1-9][0-9]{0,9}$/.test(part)) return Number(part)
  return null
}

/**
 * IPv4 text -> 4 bytes, or null when the text is not an IPv4 address in any spelling.
 *
 * The 1-, 2- and 3-part forms are here for the same reason the octal/hex digits are: `2130706433`
 * and `127.1` are both loopback to `new URL` and to `connect(2)`, and both are what somebody reaches
 * for the moment a dotted-quad blocklist appears.
 */
function ipv4Bytes(text: string): Uint8Array | null {
  const parts = text.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const nums: number[] = []
  for (const p of parts) {
    const n = intOf(p)
    if (n === null) return null
    nums.push(n)
  }
  let last = nums.pop() as number
  // The final part absorbs every byte the earlier parts did not name: `127.1` is 127.0.0.1.
  if (last >= 256 ** (4 - nums.length)) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] > 255) return null
    out[i] = nums[i]
  }
  for (let i = 3; i >= nums.length; i--) {
    out[i] = last % 256
    last = Math.floor(last / 256)
  }
  return out
}

/**
 * IPv6 text -> 16 bytes, or null. Handles `::` elision, a zone id (`fe80::1%eth0`), and the dotted
 * tail of an embedded IPv4 (`::ffff:127.0.0.1`) by folding it into the last two groups — after which
 * the mapped, NAT64, 6to4 and IPv4-compatible forms are all just byte patterns, which is the point.
 */
function ipv6Bytes(text: string): Uint8Array | null {
  let s = text.trim().toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s.includes(':')) return null
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = ipv4Bytes(tail)
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tailGroups = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null
  let groups: string[]
  if (tailGroups === null) {
    groups = head
    if (groups.length !== 8) return null
  } else {
    const gap = 8 - head.length - tailGroups.length
    // `::` stands for AT LEAST one zero group; a "gap" of zero or less is a malformed address, not a
    // long one, and Array(-1) throws rather than returning null if this is not checked first.
    if (gap < 1) return null
    groups = [...head, ...new Array(gap).fill('0'), ...tailGroups]
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null
    const n = parseInt(groups[i], 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 255
  }
  return out
}

/**
 * The IPv4 ranges that are not the public internet, as a reason string or null.
 *
 * THE LIST IS LONGER THAN THE FOUR RANGES ANYBODY REMEMBERS, on purpose. 100.64/10 (carrier NAT) and
 * 198.18/15 (benchmarking) are inside somebody's network in exactly the way 10/8 is; 240/4 and 224/4
 * are what `ip.is_reserved` and `ip.is_multicast` cover in the container guard this is ported from. Dropping
 * any of them makes this file's verdict differ from the container's for the same URL, and a guard
 * that answers two ways depending on which half of the service is asking is the kind of gap that
 * gets found from the outside.
 */
function blockedV4(b: Uint8Array): string | null {
  const [a, c, d] = [b[0], b[1], b[2]]
  if (a === 0) return 'unspecified'                                   // 0.0.0.0/8, "this network"
  if (a === 10) return 'private'                                      // 10/8
  if (a === 127) return 'loopback'                                    // 127/8
  if (a === 100 && c >= 64 && c <= 127) return 'cgnat'                // 100.64/10
  if (a === 169 && c === 254) return 'link-local'                     // 169.254/16 — the metadata endpoint
  if (a === 172 && c >= 16 && c <= 31) return 'private'               // 172.16/12
  if (a === 192 && c === 0 && d === 0) return 'reserved'              // 192.0.0/24, IETF protocol assignments
  if (a === 192 && c === 0 && d === 2) return 'documentation'         // 192.0.2/24
  if (a === 192 && c === 88 && d === 99) return 'reserved'            // 192.88.99/24, deprecated 6to4 relay anycast
  if (a === 192 && c === 168) return 'private'                        // 192.168/16
  if (a === 198 && (c === 18 || c === 19)) return 'benchmark'         // 198.18/15
  if (a === 198 && c === 51 && d === 100) return 'documentation'      // 198.51.100/24
  if (a === 203 && c === 0 && d === 113) return 'documentation'       // 203.0.113/24
  if (a >= 224 && a <= 239) return 'multicast'                        // 224/4
  if (a >= 240) return 'reserved'                                     // 240/4, including 255.255.255.255
  return null
}

/** True when every byte in [from, to) is zero. */
const zeros = (b: Uint8Array, from: number, to: number): boolean => b.slice(from, to).every(x => x === 0)

/**
 * The IPv6 ranges, INCLUDING the four ways an IPv4 address hides inside one.
 *
 * The embedded-v4 arms are the ones a prefix blocklist misses, and each carries the reason from the
 * v4 check so a refusal names the actual destination rather than the wrapper it arrived in.
 *
 * NAT64 AND 6to4 ARE REFUSED WHOLE, not only when the address they carry is private. Both prefixes
 * mean "this packet is going through somebody's translator on the way in", which is never how a
 * fediverse instance is addressed and is a plausible way into a network from outside it. There is no
 * legitimate paste this costs.
 */
function blockedV6(b: Uint8Array): string | null {
  if (zeros(b, 0, 16)) return 'unspecified'                                          // ::
  if (zeros(b, 0, 15) && b[15] === 1) return 'loopback'                              // ::1
  // ::ffff:0:0/96 — IPv4-mapped. THE bypass this project has already been bitten by.
  if (zeros(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return `ipv4-mapped ${blockedV4(b.slice(12)) ?? 'address'}`
  }
  // ::/96 — the deprecated IPv4-compatible form, still parsed by most stacks.
  if (zeros(b, 0, 12)) return `ipv4-compatible ${blockedV4(b.slice(12)) ?? 'address'}`
  // 64:ff9b::/96 (RFC 6052 well-known) and 64:ff9b:1::/48 (RFC 8215 local-use) — NAT64.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return `nat64 ${blockedV4(b.slice(12)) ?? 'address'}`
  }
  if (b[0] === 0x20 && b[1] === 0x02) return `6to4 ${blockedV4(b.slice(2, 6)) ?? 'address'}`  // 2002::/16
  if (b[0] === 0x01 && zeros(b, 1, 8)) return 'discard'                              // 100::/64
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation'  // 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] < 0x02) return 'reserved'               // 2001::/23, incl. Teredo
  if ((b[0] & 0xfe) === 0xfc) return 'unique-local'                                  // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local'                    // fe80::/10
  if (b[0] === 0xff) return 'multicast'                                              // ff00::/8
  return null
}

/**
 * "Is this text an address we must not fetch?" — the reason, or null.
 *
 * NULL IS NOT "SAFE", and the name of this function is deliberately about the blocked case: null
 * means "not a blocked literal", which covers both a public literal and a hostname. `blockedHost` is
 * the total one; call that from a boundary, not this.
 */
export function blockedAddress(text: string): string | null {
  const t = text.trim().replace(/^\[|\]$/g, '')
  const v4 = ipv4Bytes(t)
  if (v4) return blockedV4(v4)
  const v6 = ipv6Bytes(t)
  if (v6) return blockedV6(v6)
  return null
}

/**
 * Names that are never a public host, so a literal check alone would miss them.
 *
 * `localhost` is the obvious one and the reason the list exists at all; the rest are the resolver
 * suffixes that mean "ask the LAN": mDNS (.local), the RFC 8375 home network zone, the name AWS and
 * others hand out inside a VPC (.internal), and the reverse-DNS trees (a name under .arpa is
 * infrastructure, never a fediverse instance).
 *
 * FEDI_HOST in refkey.ts already refuses most of these syntactically for the fediverse routes, and
 * that is not a reason to leave them out. This file is the boundary any FUTURE user-supplied fetch
 * imports, and the syntactic check is one regex edit away from admitting them.
 */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'arpa']

/**
 * THE TOTAL VERDICT for a hostname taken from user input: a reason string, or null when nothing is
 * known against it. Accepts what a URL host looks like — bracketed IPv6, a trailing root dot, mixed
 * case — because normalising here is what stops a caller from doing it three different ways.
 */
export function blockedHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return 'empty'
  // userinfo, a port, a path, whitespace: not a hostname, and whatever produced it is confused.
  if (/[\s/@?#]/.test(h)) return 'malformed'
  const addr = blockedAddress(h)
  if (addr) return addr
  for (const s of PRIVATE_SUFFIXES) if (h === s || h.endsWith(`.${s}`)) return `private-name (${s})`
  return null
}

/**
 * THE DNS HALF, and the ONLY part of the container's guard a Worker cannot do for itself.
 *
 * `resolve` absent -> null, i.e. no verdict: that is the Cloudflare deployment, where there is no
 * resolver to call and `blockedHost` above is the whole check. Say it out loud rather than pretend
 * otherwise — docs/SELF-HOSTING.md carries the same statement for operators.
 *
 * FAILS CLOSED on a resolver that throws or answers with nothing. A name that will not resolve is a
 * name the fetch would fail on anyway, so refusing costs a request nobody could have made, while
 * treating "I could not check" as "it is fine" is how a guard gets bypassed by making DNS flap.
 *
 * IT IS NOT TOCTOU-FREE AND CANNOT BE. Between this resolution and the fetch's own, a record with a
 * one-second TTL can change (DNS rebinding); closing that needs pinning the connection to the
 * address we checked, which neither `fetch()` nor Workers exposes. What remains is bounded by the
 * clauses fedihost.ts documents — no credential is attached, the body is capped, and the response
 * must be the right shape — so the residual is a blind GET, not an exfiltration channel.
 */
export async function blockedResolvedHost(host: string, resolve?: HostResolver): Promise<string | null> {
  const named = blockedHost(host)
  if (named) return named
  if (!resolve) return null
  let addrs: string[]
  try {
    addrs = await resolve(host)
  } catch {
    return 'unresolvable'
  }
  if (!Array.isArray(addrs) || addrs.length === 0) return 'unresolvable'
  for (const a of addrs) {
    if (typeof a !== 'string') return 'unresolvable'
    // A resolver answering with something that is not an address at all is a broken resolver, and
    // "not a blocked literal" would be the wrong reading of that.
    if (ipv4Bytes(a) === null && ipv6Bytes(a) === null) return 'unresolvable'
    const bad = blockedAddress(a)
    if (bad) return bad
  }
  return null
}
