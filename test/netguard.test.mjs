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
 * turns red instead of quiet. This project has already been bitten by exactly that class of bug: a
 * previous private-address guard here was bypassed with IPv4-mapped IPv6 (`::ffff:127.0.0.1`), which
 * a prefix blocklist on the v6 text form passes without a fight.
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
  // THE BYPASS THIS PROJECT ALREADY PAID FOR. None of these starts with '127', '::1', 'fc' or
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
