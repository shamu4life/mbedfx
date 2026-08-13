import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { blockedAddress, blockedHost, blockedResolvedHost } from '../src/netguard.ts'

/**
 * THE SSRF ADDRESS GUARD, tested the way it will be attacked rather than the way it was written.
 *
 * WHY THIS FILE IS ADVERSARIAL BY DEFAULT. The guard's whole job is to survive the NEXT person, who
 * will read a byte-level parser guarding four obvious ranges and reasonably ask why it is not four
 * string comparisons. Every block below states the spelling that answer misses, so "simplify it"
 * turns red instead of quiet. The canonical example is IPv4-mapped IPv6 (`::ffff:127.0.0.1`), which
 * a prefix blocklist on the v6 text form passes without a fight.
 *
 * NO INCIDENT IN THIS REPO IS BEING CITED, and an earlier draft of this file claimed one. It said a
 * previous guard here had been bypassed that way. Nothing in the history supports that — there is no
 * such fix in `git log`, the only prior private-address guard is `container/server.py`'s `_safe_url`
 * (which uses Python's `ipaddress` and catches the mapped form), and this repo's own design spec
 * says the opposite: "It never parses IPs, so the IPv4-mapped-IPv6 SSRF class has no surface here."
 * The lesson is real and general; the provenance was invented, and under this project's own
 * do-not-guess rule a fabricated incident cited as the reason for a security design is worse than no
 * reason at all. What justifies the byte parser is the measurement below, not a story.
 *
 * WHERE THE STAKES CHANGE. On Cloudflare a bypass buys a blind GET from Cloudflare's egress. Off
 * Cloudflare — the point of issue #27 — the same GET reaches 127.0.0.1, the LAN, and the cloud
 * metadata endpoint on 169.254.169.254 that hands out instance credentials.
 */

// ── The literal parser: one address, many spellings, one verdict.

test('the four spellings of loopback that a prefix blocklist passes are all refused', () => {
  // 127.0.0.1 written five ways. A guard built as `host.startsWith('127.')` catches exactly the
  // first one, which is the version of this guard that keeps getting written.
  for (const spelling of [
    '127.0.0.1',            // the one everybody blocks
    '127.1',                // inet_aton short form — `new URL` normalizes it to 127.0.0.1
    '2130706433',           // the whole address as one decimal integer
    '0177.0.0.1',           // octal first octet
    '0x7f.0.0.1',           // hex first octet
    '0x7f000001',           // hex, whole
  ]) {
    assert.equal(blockedAddress(spelling), 'loopback', `${spelling} is 127.0.0.1`)
  }
})

test('IPv4-mapped IPv6 is refused in every spelling, including the hex one', () => {
  // THE CANONICAL BYPASS OF A TEXT-PREFIX GUARD. None of these starts with '127', '::1', 'fc' or
  // 'fe80', so a text-prefix guard admits all four; the second one additionally defeats the
  // half-fix (`::ffff:127.`) somebody reaches for after seeing the first.
  for (const spelling of [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',                  // the same address with the embedded v4 in hex
    '0:0:0:0:0:ffff:7f00:1',          // fully expanded, no '::' to match on at all
    '[::ffff:127.0.0.1]',             // bracketed, i.e. how it appears as a URL host
  ]) {
    assert.equal(blockedAddress(spelling), 'ipv4-mapped loopback', spelling)
  }
})

test('the cloud metadata endpoint is refused through every wrapper an attacker can wrap it in', () => {
  // 169.254.169.254 is the single most valuable destination on this list: on AWS, GCP and Azure it
  // answers with instance credentials to anything that can make a plain GET from the host. It is
  // link-local, so it never needs to appear as itself.
  assert.equal(blockedAddress('169.254.169.254'), 'link-local')
  assert.equal(blockedAddress('::ffff:169.254.169.254'), 'ipv4-mapped link-local')
  assert.equal(blockedAddress('::ffff:a9fe:a9fe'), 'ipv4-mapped link-local')
  assert.equal(blockedAddress('2852039166'), 'link-local', 'the decimal integer form')
  assert.equal(blockedAddress('0251.0376.0251.0376'), 'link-local', 'all-octal')
  assert.equal(blockedAddress('64:ff9b::169.254.169.254'), 'nat64 link-local', 'through NAT64')
  assert.equal(blockedAddress('2002:a9fe:a9fe::'), '6to4 link-local', 'through 6to4')
})

test('NAT64 and 6to4 are refused WHOLE, not only when they carry a private address', () => {
  // Both prefixes mean "this is going through somebody's translator on the way into a network", and
  // no fediverse instance is ever addressed that way. Refusing only the private-carrying ones would
  // leave the translator itself reachable, which is the interesting half.
  assert.ok(blockedAddress('64:ff9b::1.2.3.4'), 'well-known NAT64 prefix, public embedded v4')
  assert.ok(blockedAddress('64:ff9b:1::1.2.3.4'), 'the RFC 8215 local-use NAT64 prefix')
  assert.ok(blockedAddress('2002:0102:0304::'), '6to4 carrying a public v4')
})

test('every range the container guard refuses is refused here too', () => {
  // container/server.py's `_safe_url` refuses is_private / is_loopback / is_link_local / is_reserved
  // / is_multicast / is_unspecified. Two halves of one service answering differently for one URL is
  // a gap that gets found from outside, so this list is that list.
  for (const [addr, why] of [
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.0.1', 'link-local'],
    ['127.255.255.254', 'loopback'],
    ['100.64.0.1', 'cgnat'],
    ['198.18.0.1', 'benchmark'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
  ]) {
    assert.equal(blockedAddress(addr), why, addr)
  }
})

test('a boundary is a boundary: the addresses just outside each range stay fetchable', () => {
  // A guard that refuses everything is not a guard, it is an outage, and the ranges below have real
  // instances in them. 172.32/16 and 172.15/16 sit either side of 172.16/12, which is the range
  // most often written as `172.*` by accident.
  for (const ok of [
    '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.1', '172.15.255.255', '172.32.0.1',
    '192.167.255.255', '192.169.0.1', '169.253.255.255', '169.255.0.0', '100.63.255.255',
    '100.128.0.1', '223.255.255.255', '2606:4700::1111', '2a00:1450::1',
  ]) {
    assert.equal(blockedAddress(ok), null, `${ok} is on the public internet`)
  }
})

test('the zone id, the trailing dot and the case of an address change nothing', () => {
  // Normalisation belongs in the guard, because a caller that has to do it is a caller that will do
  // it three different ways.
  assert.equal(blockedAddress('FE80::1'), 'link-local')
  assert.equal(blockedAddress('fe80::1%eth0'), 'link-local', 'a scoped link-local address')
  assert.equal(blockedHost('127.0.0.1.'), 'loopback', 'the FQDN root dot')
  assert.equal(blockedHost('  ::1  '), 'loopback')
  assert.equal(blockedHost('[::FFFF:10.0.0.1]'), 'ipv4-mapped private')
})

test('a hostname is not an address, and is not mistaken for one', () => {
  // The permissive integer parsing (octal, hex, short forms) exists to catch address spellings, and
  // it must not start reading ordinary domains as addresses — a false positive here is a fediverse
  // instance that silently stops resolving.
  for (const host of ['lemmy.world', 'mstdn.social', 'a.b.c.d.example', '1.2.3.4.example.com', 'x0x.dev']) {
    assert.equal(blockedAddress(host), null, host)
    assert.equal(blockedHost(host), null, host)
  }
})

test('junk gets a verdict rather than a throw — the guard is total', () => {
  // It is called on unvalidated path segments, so an input it cannot parse must be an ANSWER. A
  // throw here becomes a 500 on a route that is supposed to render a failure card.
  for (const junk of ['', '   ', ':::', '1.2.3.4.5', '99999999999999', 'not a host', '::ffff:999.0.0.1']) {
    assert.doesNotThrow(() => blockedAddress(junk), junk)
    assert.doesNotThrow(() => blockedHost(junk), junk)
  }
  assert.equal(blockedHost(''), 'empty')
  assert.equal(blockedHost('example.com/../secret'), 'malformed')
  assert.equal(blockedHost('user@example.com'), 'malformed')
})

test('the names that mean "ask the LAN" are refused even though they parse as no address at all', () => {
  for (const [host, hint] of [
    ['localhost', 'localhost'],
    ['api.localhost', 'localhost'],
    ['printer.local', 'local'],
    ['db.internal', 'internal'],
    ['host.home.arpa', 'home.arpa'],
    ['1.0.0.127.in-addr.arpa', 'arpa'],
  ]) {
    const why = blockedHost(host)
    assert.ok(why?.includes(hint), `${host} -> ${why}`)
  }
})

// ── The DNS seam: the half a Worker cannot do, and the half self-hosting needs.

test('a public hostname that RESOLVES into the network is refused once a resolver is wired', () => {
  // The attack the literal check cannot see: `evil.example.com IN A 127.0.0.1`. On Cloudflare there
  // is no resolver and this is the documented residual; off it, this is the whole point.
  return blockedResolvedHost('evil.example.com', async () => ['127.0.0.1'])
    .then(why => assert.equal(why, 'loopback'))
})

test('ONE private address among several public ones is still a refusal', async () => {
  // container/server.py loops over the entire getaddrinfo result for this reason: a name with one
  // real A record and one poisoned one would otherwise pass on whichever came back first.
  assert.equal(await blockedResolvedHost('mixed.example', async () => ['93.184.216.34', '10.0.0.5']), 'private')
  assert.equal(await blockedResolvedHost('mixed.example', async () => ['93.184.216.34', '::ffff:127.0.0.1']),
    'ipv4-mapped loopback', 'and the mapped form counts in a resolver answer too')
})

test('a resolver that fails or answers with nothing FAILS CLOSED', async () => {
  // "I could not check" must not read as "it is fine", or the bypass is to make DNS flap. The cost
  // of being wrong is nil: a name that will not resolve is a name the fetch would fail on anyway.
  assert.equal(await blockedResolvedHost('x.example', async () => { throw new Error('SERVFAIL') }), 'unresolvable')
  assert.equal(await blockedResolvedHost('x.example', async () => []), 'unresolvable')
  assert.equal(await blockedResolvedHost('x.example', async () => ['not-an-address']), 'unresolvable')
})

test('with NO resolver the seam is silent, which is exactly what Cloudflare gets', async () => {
  // Stated as a test rather than left to the docstring: the Workers deployment has no DNS, so the
  // literal check is the whole guard there and this function must not start refusing every host on
  // a runtime that cannot answer the question.
  assert.equal(await blockedResolvedHost('lemmy.world'), null)
  assert.equal(await blockedResolvedHost('127.0.0.1'), 'loopback', 'the literal half still runs')
})

// ── The shape of the guard itself, so the next simplification is a red test rather than a silent one.

test('the guard range-checks BYTES — a text-prefix rewrite of it cannot pass this file', () => {
  // A structural assertion, deliberately: every test above is satisfiable by a long enough list of
  // string prefixes, and the argument for the parser is that such a list is unmaintainable rather
  // than impossible. This pins the property that makes the list unnecessary — the guard must give
  // the SAME verdict to two spellings it has never seen, which only byte-level parsing does.
  const pairs = [
    ['192.168.0.7', '::ffff:c0a8:7'],
    ['10.11.12.13', '::ffff:a0b:c0d'],
    ['172.20.30.40', '::ffff:ac14:1e28'],
  ]
  for (const [dotted, mapped] of pairs) {
    assert.equal(blockedAddress(dotted), 'private', dotted)
    assert.equal(blockedAddress(mapped), 'ipv4-mapped private', `${mapped} is ${dotted}`)
  }
  // And the source must not have quietly become a prefix list underneath: no comparison of the raw
  // host text against an address prefix. `startsWith` on an ADDRESS is the shape being forbidden.
  const src = readFileSync('src/netguard.ts', 'utf8')
  assert.equal(src.match(/startsWith\(\s*['"`][0-9a-f:.]+['"`]/g), null,
    'netguard.ts must range-check parsed bytes, never string-prefix the address text')
})


/* ═══════════════ THE THREE HOLES REVIEW FOUND IN THE FIRST VERSION OF THIS GUARD ═══════════════
 *
 * All three were reproduced on Node v26.5.0 before the fix and are pinned here so the fix cannot be
 * undone by a tidy-up. None was reachable through the fediverse routes at the time, because
 * FEDI_HOST's letters-only final label refuses numeric hosts and ports — but this module is
 * advertised as the boundary every FUTURE user-supplied fetch imports, and a guard whose thesis is
 * "no spelling-shaped holes" does not get to have spelling-shaped holes.
 */

test('A FULL-WIDTH OCTAL OR PADDED HEX HOST IS STILL AN ADDRESS — the length caps admitted the metadata endpoint', () => {
  /**
   * The first version bounded the patterns by DIGIT COUNT: `/^0[0-7]{0,10}$/` and
   * `/^0[xX][0-9a-fA-F]{1,8}$/`. A full 32-bit octal needs ELEVEN digits after the leading zero, so
   * the octal cap rejected every value at or above 2^30 — which is all of 127/8, 169.254/16,
   * 172.16/12 and 192.168/16, i.e. exactly the ranges this file exists to block. The hex cap
   * rejected zero-padding, which costs an attacker nothing to add.
   *
   * A rejected parse returns null, meaning "not an address", and null falls through to the hostname
   * rules, which pass. So the caps did not merely fail to classify these — they ADMITTED them.
   */
  for (const [spelling, expected] of [
    ['025177524776', 'link-local'],      // 169.254.169.254, the cloud metadata endpoint
    ['0x00A9FEA9FE', 'link-local'],      // the same address, zero-padded hex
    ['017700000001', 'loopback'],        // 127.0.0.1 in full-width octal
    ['0x0000007f000001', 'loopback'],    // 127.0.0.1, zero-padded hex
  ]) {
    const verdict = blockedHost(spelling)
    assert.ok(verdict, `${spelling} resolves to ${new URL(`http://${spelling}/`).hostname} and must be refused`)
    assert.match(verdict, new RegExp(expected), `${spelling} is ${expected}`)
  }
})

test('PADDING DOES NOT CHANGE THE VERDICT — the property the whole file rests on', () => {
  // The sharpest symptom of the length caps: the SAME address got two answers depending on how many
  // leading zeros it wore. `0x0a000001` was refused as private and `0x00a000001` sailed through, and
  // both are 10.0.0.1. Any future rewrite that reintroduces a length bound fails here first.
  for (const [a, b] of [
    ['0x0a000001', '0x00a000001'],
    ['0xa000001', '0x000000000a000001'],
    ['0177.0.0.1', '00177.0.0.1'],
  ]) {
    assert.equal(blockedHost(a), blockedHost(b),
      `${a} and ${b} are one address and must get one verdict`)
  }
})

test('AN ADDRESS WEARING A PORT IS STILL THAT ADDRESS — the port rode straight through', () => {
  /**
   * `blockedHost` stripped brackets and then refused the class `[\s/@?#]`, which contains no colon,
   * so a port reached `blockedAddress` — which cannot parse one and answered null. The comment above
   * that line claimed a port was refused. Measured before the fix: `blockedHost('127.0.0.1:8080')`
   * -> null, and `blockedHost('[::ffff:127.0.0.1]:8080')` -> null.
   *
   * Adding ':' to that character class is NOT the fix, and this asserts the other half so nobody
   * tries: an IPv6 literal is nothing but colons and must survive.
   */
  assert.match(String(blockedHost('127.0.0.1:8080')), /loopback/)
  assert.match(String(blockedHost('[::ffff:127.0.0.1]:8080')), /loopback/)
  assert.match(String(blockedHost('[::1]:443')), /loopback/)
  assert.match(String(blockedHost('[::1]')), /loopback/, 'the bracketed literal still works')
  assert.match(String(blockedHost('::ffff:127.0.0.1')), /loopback/, 'and the bare one does too')
  assert.equal(blockedHost('example.com:443'), null, 'a real host with a port is still a real host')
  assert.equal(blockedHost('example.com'), null)
})

test('A STRING THAT IS NEITHER A HOSTNAME NOR AN ADDRESS FAILS CLOSED', () => {
  // A DNS hostname cannot contain a colon. If one survives the port/bracket split and the address
  // parser could not read it either, the string is neither — and "I could not classify it" must not
  // read as "nothing known against it" at a security boundary. `::ffff:127.0.0.1:8080` is the shape
  // that motivates it: not a legal URL authority, not a hostname, and loopback to anything lenient.
  for (const junk of ['::ffff:127.0.0.1:8080', '[::1]junk', '[::1', 'a:b:c:d']) {
    assert.ok(blockedHost(junk), `${junk} is not classifiable and must not pass`)
  }
})


/* ══════ THE THREE FAMILIES FOUR INDEPENDENT ATTACKERS FOUND AGAINST THE HAND-ROLLED VERSION ══════
 *
 * All three had ONE root cause: `blockedHost` reimplemented PART of a URL host parser (case,
 * brackets, port, trailing dot) and not the rest. Everything it skipped was an opening, and the
 * three below are just the openings somebody looked for. The fix is not three more special cases —
 * it is asking `new URL` what the string means first, because that is the parser the fetch itself
 * will use, so our opinion and the client's cannot differ.
 *
 * These stay as tests rather than as a comment because the tempting simplification is to delete the
 * `canonicalHost` call ("we already parse addresses"), and that is precisely what reopens all three.
 */

test('0x IS A ZERO OCTET TO EVERY WHATWG CLIENT, and one of them disarmed the whole address', () => {
  /**
   * `intOf` required /^0[xX][0-9a-fA-F]+$/ — one or MORE hex digits. WHATWG's IPv4 number parser
   * strips the `0x` prefix and, when the remainder is empty, yields 0. So `0x` is a legal zero
   * octet to Node, undici, browsers and workerd, and was "not a number" to us — which made
   * `ipv4Bytes` return null for the ENTIRE address, which read as "not an address", which passed.
   *
   * Measured: new URL('http://127.0x.0.1/').hostname === '127.0.0.1'.
   */
  for (const spelling of ['127.0x.0.1', '127.0x', '10.0x.0.1', '192.168.0x.1', '0x7f.0x.0x.0x']) {
    const routed = new URL(`http://${spelling}/`).hostname
    assert.ok(blockedHost(spelling), `${spelling} routes to ${routed} and must be refused`)
  }
  // A bare `0x` is 0.0.0.0, which connect(2) treats as localhost.
  assert.ok(blockedHost('0x'), '0x is 0.0.0.0')
  assert.ok(blockedHost('0X'), 'and the case does not save it')
})

test('UNICODE DIGITS ARE DIGITS after IDNA mapping, so an ASCII-only guard never sees the address', () => {
  /**
   * The URL host parser runs UTS-46 mapping BEFORE anything else. A sweep of U+0080..U+1FFFF found
   * 11 codepoints mapping to each ASCII digit (superscripts, subscripts, circled, fullwidth, and
   * four mathematical families) and 3 mapping to '.', so one address has on the order of 11^12
   * spellings — none of which an ASCII `split('.')` and `[0-9]` character class can see.
   *
   * The same mapping walks straight through PRIVATE_SUFFIXES, which is the second assertion here.
   */
  const fullwidth = '\uFF11\uFF16\uFF19\uFF0E\uFF12\uFF15\uFF14\uFF0E\uFF11\uFF16\uFF19\uFF0E\uFF12\uFF15\uFF14'
  assert.equal(new URL(`http://${fullwidth}/`).hostname, '169.254.169.254', 'the premise')
  assert.ok(blockedHost(fullwidth), 'the metadata endpoint in fullwidth digits must be refused')

  const circled = '\u2460\u2461\u2466.0.0.1'   // ①②⑦.0.0.1 -> 127.0.0.1
  assert.ok(blockedHost(circled), `${circled} routes to ${new URL(`http://${circled}/`).hostname}`)

  const localhost = '\u24C1\u24C4\u24B8\u24B6\u24C1\u24BD\u24C4\u24C8\u24C9'  // ⓁⓄⒸⒶⓁⒽⓄⓈⓉ
  assert.ok(blockedHost(localhost), 'a circled-capital localhost is still localhost')
})

test('A PERCENT-ENCODED HOST IS DECODED BEFORE IT IS RESOLVED, and % was not even refused', () => {
  // WHATWG percent-decodes the host of a special scheme before IDNA and IPv4 parsing. The old
  // reject class was /[\s/@?#\[\]]/ — no '%' in it — so the string sailed past as an ordinary
  // hostname and no address parse was ever attempted on what it actually meant.
  for (const spelling of ['169.254.169.%32%35%34', '%31%32%37.0.0.1', '127%2e0%2e0%2e1']) {
    const routed = new URL(`http://${spelling}/`).hostname
    assert.ok(blockedHost(spelling), `${spelling} routes to ${routed} and must be refused`)
  }
  // And the suffix list is defeated the same way.
  assert.ok(blockedHost('%6c%6f%63%61%6c%68%6f%73%74'), 'percent-encoded localhost')
})

test('THE GUARD AND THE CLIENT AGREE ON EVERY STRING — the property, not another spelling', () => {
  /**
   * The three families above were three symptoms of one thing, so the durable assertion is the
   * INVARIANT rather than the cases. For any string the client can parse into a private, loopback,
   * link-local or CGNAT address, the guard must refuse it. A differential of 178,746 generated
   * candidates found zero divergences after the fix; this is a fast standing sample of it, so a
   * future edit that reintroduces a hand-rolled shortcut fails here rather than in production.
   */
  const isPrivate = text => {
    const h = text.replace(/^\[|\]$/g, '')
    const parts = h.split('.')
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
      const b = parts.map(Number)
      if (b.some(n => n > 255)) return false
      return b[0] === 127 || b[0] === 10 || b[0] === 0
        || (b[0] === 169 && b[1] === 254)
        || (b[0] === 172 && b[1] >= 16 && b[1] <= 31)
        || (b[0] === 192 && b[1] === 168)
        || (b[0] === 100 && b[1] >= 64 && b[1] <= 127)
    }
    const l = h.toLowerCase()
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd')
      || l.startsWith('fe80') || l.includes('::ffff:') || l.startsWith('64:ff9b') || l.startsWith('2002:')
  }
  const toks = ['0', '00', '0x', '0X', '0x7f', '0177', '127', '169', '254', '10', '192', '168',
    '172', '16', '1', '0x1', '%31', '%2e', '2130706433', '025177524776', '']
  let checked = 0
  for (const a of toks) {
    for (const b of toks) {
      for (const shape of [`${a}.${b}`, `127.${a}.0.1`, `169.254.${a}.254`, `${a}.0.0.1`, a]) {
        let routed
        try { routed = new URL(`http://${shape}/`).hostname } catch { continue }
        checked++
        if (isPrivate(routed)) {
          assert.ok(blockedHost(shape),
            `"${shape}" routes to ${routed} and the guard let it through`)
        }
      }
    }
  }
  assert.ok(checked > 1000, `the sweep must actually run; only ${checked} parsed`)
})

test('REAL FEDIVERSE HOSTS ARE NOT COLLATERAL — a guard that refuses everything is an outage', () => {
  // Canonicalising through `new URL` could plausibly start refusing legitimate names; it must not.
  // The punycode entry matters: IDN hosts are real, and the fix must map them rather than reject them.
  for (const ok of ['lemmy.world', 'mstdn.social', 'misskey.io', 'framatube.org', 'tube.tchncs.de',
    'example.com', 'example.com:443', 'xn--80ak6aa92e.com', 'sub.domain.co.uk', 'a-b.example', 'x0x.dev']) {
    assert.equal(blockedHost(ok), null, `${ok} is a real instance host and must stay fetchable`)
  }
})
