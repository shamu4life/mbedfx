import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../src/render/index.ts'
import { renderTelegram } from '../src/render/telegram.ts'
import { route } from '../src/router.ts'
import { refKey } from '../src/refkey.ts'
import { decodeStatusId } from '../src/statusid.ts'
import { toMastodonStatus, toOEmbed } from '../src/render/mastodon.ts'
import { dimTags } from '../src/render/embed.ts'

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'

const base = {
  ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
  canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social', avatar: 'https://cdn.bsky.app/avatar.jpg' },
  text: 'hello <world> & "friends"',
  createdAt: new Date('2026-07-01T12:00:00Z'),
  media: [
    { kind: 'image', url: 'https://cdn.bsky.app/a.jpg', w: 800, h: 600 },
    { kind: 'image', url: 'https://cdn.bsky.app/b.jpg', w: 800, h: 600 },
  ],
  counts: { likes: 5, reposts: 2, replies: 1 },
  sensitive: false,
}
const body = (r) => r.text()
const tagsOf = (html, prop) =>
  [...html.matchAll(new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'g'))].map(m => m[1])
const namedOf = (html, name) =>
  [...html.matchAll(new RegExp(`<meta name="${name}" content="([^"]*)"`, 'g'))].map(m => m[1])

// Matched generically and filtered in JS rather than interpolated into the pattern: both
// media types contain a '+', which is a regex quantifier, so the interpolating form would
// silently match the wrong thing ('application/activity+json' would also match
// 'application/activityjson') instead of failing loudly.
const ACTIVITY = 'application/activity+json'
const OEMBED = 'application/json+oembed'
const linksOf = (html, type) =>
  [...html.matchAll(/<link rel="alternate" type="([^"]*)" href="([^"]*)"/g)]
    .filter(m => m[1] === type)
    .map(m => m[2])

test('humans are redirected to the original post, never rendered', () => {
  const r = render({ kind: 'post', post: base }, 'human', ORIGIN)
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), base.canonical)
})

test('media URLs use the REQUEST origin, never a hardcoded one', async () => {
  // The guard is "the emitted origin equals the origin passed to render()", not a
  // substring blacklist — staging is a subdomain of the prod domain, so a substring
  // check would false-positive. Render with a deliberately foreign origin and confirm
  // every /_media/ URL carries THAT origin and no other.
  //
  // Asks 'other-bot' rather than 'discord' since Task 5: the plain-og path, which is the
  // only path that emits a /_media/ URL in the head, moved client classes when the spoof
  // gate landed. Same path, same assertion, different door — the coverage is preserved
  // rather than deleted. The spoof path's own two callback hrefs get the mirror of this
  // test below ('spoof callback URLs use the REQUEST origin'), because a hardcoded origin
  // is exactly as dangerous there.
  const FOREIGN = 'https://some-other-host.example'
  const html = await body(render({ kind: 'post', post: base }, 'other-bot', FOREIGN))
  assert.ok(html.includes(`${FOREIGN}/_media/`), 'must use the origin it was called with')
  const mediaHosts = [...html.matchAll(/https?:\/\/([^/"]+)\/_media\//g)].map(m => m[1])
  assert.ok(mediaHosts.length > 0, 'expected at least one /_media/ URL')
  for (const h of mediaHosts) {
    assert.equal(h, 'some-other-host.example', `every media host must be the passed origin, got ${h}`)
  }
})

test('raw CDN URLs never reach the client — they expire and bypass /_media/', async () => {
  // Every client class AND both sides of the media gate, not one sample. A discord-only
  // check stopped covering the plain-og path the moment the spoof gate landed, and the
  // avatar (base.author.avatar is a raw CDN url) is only reachable on the no-media branch —
  // so the two loops together are what make "no raw CDN url in ANY output" a real claim.
  for (const client of ['discord', 'telegram', 'other-bot']) {
    for (const post of [base, { ...base, media: [] }]) {
      const html = await body(render({ kind: 'post', post }, client, ORIGIN))
      assert.ok(!html.includes('cdn.bsky.app'), `raw CDN url leaked to ${client}`)
    }
  }
  // The media key is encodeURIComponent(refKey(ref)) — '%3A' for the ':' delimiters,
  // never a bare colon — so the wire format survives an edge/proxy percent-normalizing
  // path segments (I-2). A bare-colon match here would silently tolerate a regression
  // back to the fragile raw-refKey wire format.
  const plain = await body(render({ kind: 'post', post: base }, 'other-bot', ORIGIN))
  assert.match(plain, /\/_media\/bs%3Aalice\.bsky\.social%3A3k2a\/0/)
  assert.ok(!plain.includes('/_media/bs:alice'), 'the media URL must not contain a bare, unencoded colon')
})

test('EXACTLY ONE og:image — a second one wins and shows the wrong picture', async () => {
  // OGP takes the first occurrence. Emitting the avatar AND the post image means
  // Discord renders the avatar as the embed image, and og:image:width/height
  // (computed from the post image) attach to the wrong one.
  //
  // Asks 'other-bot' since Task 5. This asserts a property of the PLAIN-OG path, which is now
  // what every non-Discord bot gets and NOTHING else — the C1 gate took Discord off it entirely,
  // text-only posts included. Re-pointed rather than deleted: the defect it pins (two og:image
  // tags, avatar wins) is a property of the renderer's media branch, which is untouched and
  // still shipping to every other bot.
  const html = await body(render({ kind: 'post', post: base }, 'other-bot', ORIGIN))
  const imgs = tagsOf(html, 'og:image')
  assert.equal(imgs.length, 1, `expected exactly 1 og:image, got ${imgs.length}: ${imgs}`)
  assert.match(imgs[0], /\/_media\/bs%3Aalice\.bsky\.social%3A3k2a\/0$/, 'must be the post image, not the avatar')
})

test('avatar becomes og:image only when the post has no media', async () => {
  // 'other-bot' for the media case, same reason as the test above. The DISCORD side of this
  // exact property is covered twice over now and deliberately from both ends, on the SPOOF head
  // since the C1 gate: with media it must be ZERO og:image ('discord + media takes the spoof
  // path'), without media it must be exactly the avatar ('a text-only post to discord takes the
  // SPOOF head'). Same rule, two heads, four assertions — because the two heads reach it by
  // separate lines of code.
  const noMedia = { ...base, media: [] }
  const imgs = tagsOf(await body(render({ kind: 'post', post: noMedia }, 'other-bot', ORIGIN)), 'og:image')
  assert.equal(imgs.length, 1)
  assert.match(imgs[0], /\/avatar$/)
})

test('EXACTLY ONE og:description, and sensitive actually marks it — on BOTH heads', async () => {
  // Both clients, deliberately. This test used to render `base` (which has media) as 'discord'
  // only, which silently became a spoof-path-only test the moment the Task 5 gate landed —
  // proven by mutation: rewriting the PLAIN path's description tag to `esc(post.text)`, i.e.
  // dropping the marker entirely, left all 189 tests green. Since the C1 gate the plain path is
  // what every non-Discord bot gets and nothing more, but the hazard is unchanged — the two heads
  // build this tag on separate lines, so each needs its own assertion rather than a shared one
  // that quietly migrates to whichever branch the fixture happens to take.
  for (const client of ['discord', 'other-bot']) {
    const plain = tagsOf(await body(render({ kind: 'post', post: base }, client, ORIGIN)), 'og:description')
    assert.equal(plain.length, 1, `${client}: expected exactly one og:description`)
    assert.ok(!plain[0].includes('[sensitive]'))

    const sens = tagsOf(await body(render({ kind: 'post', post: { ...base, sensitive: true } }, client, ORIGIN)), 'og:description')
    assert.equal(sens.length, 1, 'a second og:description would be ignored and the marker lost')
    assert.match(sens[0], /\[sensitive\]/, `${client}: the sensitive marker must survive`)
  }
})

test('post text is HTML-escaped — on BOTH heads', async () => {
  // Same migration hazard as the test above, same proof: removing esc() from the plain path's
  // og:description left the whole suite green, because `base` has media and this test asked
  // for 'discord'. post.text is attacker-controlled — anyone can post one — so the branch that
  // serves every non-Discord bot cannot be covered by inference from the other branch.
  for (const client of ['discord', 'other-bot']) {
    const html = await body(render({ kind: 'post', post: base }, client, ORIGIN))
    assert.ok(!html.includes('<world>'), `${client}: raw markup escaped into the head`)
    assert.match(html, /&lt;world&gt;/)
    assert.match(html, /&amp;/)
    assert.match(html, /&quot;friends&quot;/)
  }
})

test('Telegram gets og tags and never a meta refresh — it hangs on them', async () => {
  const html = await body(render({ kind: 'post', post: base }, 'telegram', ORIGIN))
  assert.ok(!/http-equiv=["']?refresh/i.test(html))
  assert.equal(tagsOf(html, 'og:title').length, 1)
})

// A video-only post. Telegram is the only client whose head is now built by a module that
// gets to disagree with discord.ts about video, so it needs a fixture of its own.
const tgVideo = { ...base, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 1280, h: 720 }] }

test('render() routes every telegram post to telegram.ts, byte for byte', async () => {
  // The split is only real if index.ts honours it, and "is routed there" is otherwise
  // unobservable: two renderers that emit the same string are indistinguishable from the
  // outside. Byte equality is the strongest available statement — an edit to either module
  // that does not move the other breaks HERE rather than in a Telegram client.
  //
  // The video post is in the loop on purpose: it is the one input where telegram.ts and
  // discord.ts's plain-og path deliberately DISAGREE (no /_alt/0 twitter:image — see below),
  // so it is the case that catches index.ts quietly falling back to renderPost.
  for (const post of [base, { ...base, media: [] }, tgVideo]) {
    const viaIndex = await body(render({ kind: 'post', post }, 'telegram', ORIGIN))
    assert.equal(viaIndex, await body(renderTelegram(post, ORIGIN)))
  }
})

test('the telegram head is EXACTLY these eight tags', async () => {
  // A whitelist, for the same reason the spoof head has one: every other assertion in this
  // file is a blacklist, and no blacklist can catch a tag nobody thought to forbid. The two
  // this is really guarding are an activity+json or json+oembed <link> drifting over from
  // discord.ts (Telegram must get neither — plan §10) and a second og:image, which OGP
  // resolves by taking the FIRST tag, so the wrong picture wins silently.
  const html = await body(render({ kind: 'post', post: base }, 'telegram', ORIGIN))
  const tags = [...html.matchAll(/<(?:meta|link)\b[^>]*>/g)].map(m => m[0])
  assert.deepEqual(tags, [
    '<meta property="og:title" content="Alice (@alice.bsky.social)"/>',
    '<meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/>',
    `<meta property="og:url" content="${base.canonical}"/>`,
    '<meta property="og:site_name" content="mbedfx"/>',
    `<meta property="og:image" content="${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/0"/>`,
    '<meta property="og:image:width" content="800"/>',
    '<meta property="og:image:height" content="600"/>',
    '<meta name="twitter:card" content="summary_large_image"/>',
  ])
})

test('telegram: exactly one og:image — the first media, or the avatar when there is none', async () => {
  // Telegram shows ONE picture (plan §10); the mosaic composite FxEmbed serves it needs a
  // service we do not have, and Instant View is out of scope. So the interesting property is
  // not "which picture" but "exactly one" — with two og:image tags the avatar, emitted first,
  // would win over the post's own image on every media post.
  const one = { ...base, media: [base.media[0]] }
  for (const [post, tail] of [[base, '/0'], [one, '/0'], [{ ...base, media: [] }, '/avatar']]) {
    const imgs = tagsOf(await body(render({ kind: 'post', post }, 'telegram', ORIGIN)), 'og:image')
    assert.equal(imgs.length, 1, `expected exactly 1 og:image, got ${imgs.length}: ${imgs}`)
    assert.ok(imgs[0].endsWith(tail), `${imgs[0]} should end with ${tail}`)
  }
})

test('telegram gets no callback link and no meta refresh, whatever the media', async () => {
  // Swept over the media gate rather than sampled. The activity+json link is a bet placed on
  // DISCORD's behaviour specifically and the oEmbed document we serve is spec-invalid (type
  // 'rich', no `html`) — Discord tolerates it, and we have no evidence at all about Telegram,
  // so neither link goes out. The meta refresh is the older and harder rule: Telegram HANGS
  // on <meta http-equiv="refresh">, which is why redirect() is a 302 (fail.ts).
  for (const post of [base, { ...base, media: [] }, tgVideo]) {
    const html = await body(render({ kind: 'post', post }, 'telegram', ORIGIN))
    assert.deepEqual(linksOf(html, ACTIVITY), [], 'telegram must get no activity link')
    assert.deepEqual(linksOf(html, OEMBED), [], 'telegram must get no oembed link')
    assert.ok(!/http-equiv=["']?refresh/i.test(html), 'telegram hangs on a meta refresh')
  }
})

test('telegram og:description carries reply and quote context as REAL newlines, never <br>', async () => {
  // The plan's Task 5 says to put <br> in this attribute (a Telegram Instant-View template
  // quirk). Doing that is a defect however it is spelled on the wire — and NOT for the reason
  // an earlier version of this comment gave. It claimed esc() would make the tag visible as
  // '&lt;br&gt;'; character references are in fact DECODED inside attribute values, so the
  // consumer would see `<br>`. (Internal proof: the escaping test below asserts `&amp;` on the
  // wire precisely because Telegram decodes it back to '&'.) The real reason is the field:
  // og:description is plain text, nothing parses it as HTML, and Instant View — the one
  // consumer that would template a <br> — is out of scope. So it is visible junk either way,
  // and a real \n is legal inside a double-quoted attribute value.
  const quoting = {
    ...base, text: 'hello world',
    quote: { canonical: 'https://bsky.app/q', text: 'quoted body',
             author: { name: 'Carol', handle: 'carol.example', url: 'https://bsky.app/profile/carol.example' } },
    replyTo: { author: { name: 'Bob', handle: 'bob.bsky.social', url: 'https://bsky.app/profile/bob.bsky.social' } },
  }
  const html = await body(render({ kind: 'post', post: quoting }, 'telegram', ORIGIN))
  const desc = tagsOf(html, 'og:description')
  assert.equal(desc.length, 1)
  assert.match(desc[0], /↩ Bob \(@bob\.bsky\.social\)/, 'reply context vanished')
  assert.match(desc[0], /Quoting Carol \(@carol\.example\)/, 'quote context vanished')
  assert.match(desc[0], /quoted body/, 'the quoted text itself vanished')
  assert.ok(desc[0].includes('\n'), 'the parts must stay separated by real newlines')
  // BOTH spellings, because the two plausible implementations of the plan's instruction produce
  // different bytes: inserting <br> before esc() lands '&lt;br&gt;' on the wire, inserting it
  // after esc() lands a literal '<br>'. The old assertion pinned only the first, so the more
  // direct way of following the plan would have sailed straight through it.
  assert.ok(!/&lt;br&gt;|<br/i.test(desc[0]), `a <br> in this plain-text attribute is visible junk: ${desc[0]}`)
  // COUNTS-FREE (§3), same trap as both other heads: og:description and oEmbed author_name
  // share a consumer, so a count here can print the stats twice inside one embed. `base`
  // carries nonzero likes/reposts/replies, so a leak shows up as the heart.
  assert.ok(!desc[0].includes('❤'), `counts leaked into og:description: ${desc[0]}`)
  // The sensitive marker is the renderer's job (text.ts deliberately does not apply it), and
  // this renderer is new — so it gets its own assertion rather than inheriting discord.ts's.
  const sens = tagsOf(await body(render({ kind: 'post', post: { ...base, sensitive: true } }, 'telegram', ORIGIN)), 'og:description')
  assert.equal(sens.length, 1)
  assert.match(sens[0], /^\[sensitive\]/, 'the sensitive marker must survive the split')
})

test('telegram video keeps og:video and drops the /_alt/0 trick — a DISCORD-only device', async () => {
  // twitter:image="{origin}/_alt/0" exists to stop DISCORD promoting a still over the video
  // player; the design spec files it under "Discord rendering", and /_alt/0 is a route we
  // reserve to 404 with no body. Shipping a URL we guarantee is dead to a client whose
  // handling of it we have never measured buys nothing, so telegram.ts does not emit it.
  // This is the deliberate divergence from discord.ts's plain path that the byte-equality
  // test above depends on.
  const html = await body(render({ kind: 'post', post: tgVideo }, 'telegram', ORIGIN))
  assert.deepEqual(namedOf(html, 'twitter:image'), [], 'no dead-end URL for a client we have not measured')
  assert.ok(!html.includes('/_alt/'), '/_alt/0 is a Discord device')
  assert.deepEqual(tagsOf(html, 'og:video'), [`${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/0`])
  assert.deepEqual(tagsOf(html, 'og:type'), ['video.other'])
  // No og:image alongside it: with no still frame of our own the only candidate is the mp4
  // itself, which promises Telegram a picture that can never decode.
  assert.deepEqual(tagsOf(html, 'og:image'), [], 'an mp4 under og:image is a broken picture')
})

// A corrupted cache record, in the shapes deserializePost actually lets through: it validates
// ref, canonical and createdAt and NOTHING else, so media[] arrives unchecked.
const CORRUPT_MEDIA = [[null], ['nope'], [{ kind: 'poll', url: '' }], [{ kind: 'image', url: null, w: 0, h: 0 }], 'abc', undefined]

test('telegram degrades on a corrupt media list instead of throwing a 500', async () => {
  // telegram.ts holds its OWN copy of the mediaOf()/usable() totality guards since the split,
  // and until this test nothing exercised the copy. Proven by mutation on the shipped module:
  // deleting `usable(m) &&` from both finds AND `mediaOf(post)` -> `post.media` left the FULL
  // suite green at 199/199, while driving the mutant directly gave
  //   media:[null]     -> TypeError: Cannot read properties of null (reading 'kind')
  //   media:'abc'      -> TypeError: media.find is not a function
  //   media:undefined  -> TypeError: Cannot read properties of undefined (reading 'find')
  // i.e. an uncaught 500 out of the one module whose entire contract is to degrade — and
  // worker.ts does NOT wrap render() in a try/catch (only d.fetchPost), so it reaches the edge.
  //
  // Before the split this was covered transitively: 'discord' + a corrupt list failed the spoof
  // gate and fell into renderPost's plain path, which Telegram shared. The split copied the
  // guards into new code and left the copy untested — so the coverage moved here explicitly.
  for (const media of CORRUPT_MEDIA) {
    const label = JSON.stringify(media) ?? 'undefined'
    const html = await body(render({ kind: 'post', post: { ...base, media } }, 'telegram', ORIGIN))
    const imgs = tagsOf(html, 'og:image')
    assert.equal(imgs.length, 1, `${label}: expected the avatar as the fallback picture, got ${imgs.length}`)
    assert.match(imgs[0], /\/avatar$/, `${label}: nothing usable in the list, so the avatar is the picture`)
    // The url clause of usable() is a promise, not just crash insurance: an entry with no url
    // resolves through pickMedia to null, so advertising it would hand Telegram an image
    // guaranteed to 404 — worse than the avatar, because a broken picture beats no picture.
    assert.ok(!imgs[0].endsWith('/0'), `${label}: must not advertise a media index that cannot resolve`)
  }
})

test('telegram og:image and og:video carry the RAW media index, never a compacted one', async () => {
  // /_media/{key}/{i} is resolved by pickMedia against the raw post.media array, so a corrupt
  // leading entry must NOT shift the index of the entry we point at. Proven necessary by
  // mutation: rewriting `media.indexOf(img)` to a literal 0 left the whole suite green,
  // because every other telegram fixture happens to have its first usable image at index 0.
  const img = await body(render({ kind: 'post', post: { ...base, media: [null, base.media[0]] } }, 'telegram', ORIGIN))
  assert.deepEqual(tagsOf(img, 'og:image'), [`${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/1`])
  const vid = await body(render({ kind: 'post', post: { ...base, media: [null, tgVideo.media[0]] } }, 'telegram', ORIGIN))
  assert.deepEqual(tagsOf(vid, 'og:video'), [`${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/1`])
})

test('no head throws on a record with no author — deserializePost lets one through', async () => {
  // deserializePost validates ref, canonical and createdAt only, so `author` can be absent
  // entirely; confirmed by round-tripping an author-less record through it (it returns a Post).
  // A raw `post.author.name` on that record is `Cannot read properties of undefined`, and
  // worker.ts calls render() OUTSIDE any try/catch — an uncaught 500 on the degrade path.
  //
  // Measured before the fix: telegram 200, discord THREW, other-bot THREW. telegram.ts got the
  // guard at the split and discord.ts's plain path did not, which is the whole reason this
  // sweeps every bot class rather than trusting one. The spoof path (discord.ts:90/94) and
  // mastodon.ts already read through `str(post.author?.…)`; the plain path was the last raw one.
  const { author, ...authorless } = base
  for (const client of ['telegram', 'discord', 'other-bot']) {
    const html = await body(render({ kind: 'post', post: authorless }, client, ORIGIN))
    // Content, not status: a thrown render is the failure this pins, but a head that "survives"
    // by printing the string "undefined" at the viewer is the degradation we rejected.
    // ' (@)' -> '' on 2026-07-30. What this test PINS is unchanged and is the line below: the literal
    // string "undefined" must never reach the wire. The old expectation spelled the degrade as the
    // punctuation left over from `${name} (@${handle})` with both halves empty — junk that survived
    // only because nothing rendered it deliberately. byline() now omits the parenthetical when there
    // is no handle, so an author-less record degrades to an EMPTY title instead of visible debris.
    assert.deepEqual(tagsOf(html, 'og:title'), [''], `${client}: author fields degrade to empty, never "undefined"`)
    assert.ok(!html.includes('undefined'), `${client}: the literal string "undefined" reached the wire`)
  }
})

test('a dimensionless media entry drops the dimension tags, it does not ship "undefined"', async () => {
  // usable() blesses an entry on its `url` ALONE, and w/h are never validated by
  // deserializePost — so {kind:'image', url:'…'} with no dimensions is a shape the cache can
  // hand a renderer. fudge()'s comparisons are then all false against undefined, so it returned
  // the pair untouched and the template literal shipped `content="undefined"` to a crawler.
  // Measured on the shipped renderers before the fix, identically for telegram and other-bot:
  //   <meta property="og:image:width" content="undefined"/>
  //
  // Swept over both OpenGraph heads and both media branches, since the defect lives in the
  // shared helper rather than in either renderer.
  const noDims = [
    ['telegram', { kind: 'image', url: 'https://cdn/1.jpg' }, 'og:image'],
    ['other-bot', { kind: 'image', url: 'https://cdn/1.jpg' }, 'og:image'],
    ['telegram', { kind: 'video', url: 'https://cdn/v.mp4' }, 'og:video'],
    ['other-bot', { kind: 'video', url: 'https://cdn/v.mp4' }, 'og:video'],
  ]
  for (const [client, m, prefix] of noDims) {
    const html = await body(render({ kind: 'post', post: { ...base, media: [m] } }, client, ORIGIN))
    const label = `${client}/${prefix}`
    // The picture itself must SURVIVE — the entry has a url, so it resolves; only the
    // dimensions are unknown. Dropping the media tag too would be a worse cure than the bug.
    assert.equal(tagsOf(html, prefix).length, 1, `${label}: the media tag itself must still ship`)
    assert.deepEqual(tagsOf(html, `${prefix}:width`), [], `${label}: unknown width must be omitted, not guessed`)
    assert.deepEqual(tagsOf(html, `${prefix}:height`), [], `${label}: unknown height must be omitted, not guessed`)
    assert.ok(!html.includes('"undefined"'), `${label}: the literal string "undefined" reached the wire`)
  }
  // Real dimensions still ship, and still lied about per fudge() — the guard must not have
  // quietly turned the dimension tags off for everyone.
  const ok = await body(render({ kind: 'post', post: base }, 'telegram', ORIGIN))
  assert.deepEqual(tagsOf(ok, 'og:image:width'), ['800'])
  assert.deepEqual(tagsOf(ok, 'og:image:height'), ['600'])
})

test('a media URL cannot break out of its content="…" attribute', async () => {
  // Every /_media/ URL interpolates `origin`, which worker.ts takes from the REQUEST
  // (url.origin — the Host header once at the edge), so it is not a constant we control. These
  // were the only unescaped interpolations left in either head; everything else goes through
  // esc(). Node's URL parser preserves a '"' inside a host verbatim (checked directly:
  // new URL('https://evil"…').origin keeps the quote), so the raw form emitted
  //   <meta property="og:image" content="https://evil"onerror=alert(1)x.example/_media/…"/>
  // — an attribute broken open by the origin.
  //
  // Reachability through Cloudflare is UNPROVEN (whether a Host header with a '"' survives the
  // edge, and whether workerd's URL parser preserves it as Node's does, are both unmeasured),
  // so this pins defence in depth rather than a demonstrated exploit. esc() is right for a URL
  // in an attribute regardless — '&' belongs there as '&amp;' — and it costs one call.
  const HOSTILE = new URL('https://evil"onerror=alert(1)x.example/p').origin
  for (const client of ['telegram', 'other-bot']) {
    for (const post of [base, { ...base, media: [] }, tgVideo]) {
      const html = await body(render({ kind: 'post', post }, client, HOSTILE))
      // The quote must arrive ENCODED, never raw. Asserting on the escaped spelling rather than
      // just counting attributes is what makes this fail if esc() is dropped again.
      assert.ok(html.includes('&quot;onerror'), `${client}: the origin's quote must be escaped`)
      assert.ok(!html.includes('content="https://evil"'), `${client}: the origin broke out of the attribute`)
    }
  }
})

test('failure: crawler gets an honest error embed, human gets the real post', async () => {
  const f = { kind: 'failure', canonical: 'https://bsky.app/x', platform: 'bs', reason: 'fetch failed' }
  const h = render(f, 'human', ORIGIN)
  assert.equal(h.status, 302)
  assert.equal(h.headers.get('location'), 'https://bsky.app/x')
  const d = await body(render(f, 'discord', ORIGIN))
  // LOUD DEFAULT: a platform-known failure is the neutral "couldn't load" card, not outcome.reason.
  assert.match(d, /Couldn't load this Bluesky post/)
})

test('a failure with no canonical is a 404, not a redirect to null', () => {
  const r = render({ kind: 'failure', canonical: null, platform: null, reason: 'not found' }, 'human', ORIGIN)
  assert.equal(r.status, 404)
})

// ── A gated post is a DISTINCT, calmer failure — a known limit, not a fetch error — and `gate` names
// WHICH limit ('age' | 'private'). worker.ts threads the fetcher's reason onto outcome.gate; every
// other failure leaves gate undefined and falls to the neutral "couldn't load" card. Owner-chosen copy;
// the glyphs are U+1F51E (🔞) and U+1F512 (🔒).
const ageFail = { kind: 'failure', canonical: 'https://x.com/jack/status/1', platform: 'x',
                  reason: 'could not fetch post', gate: 'age' }

test('an age-restricted failure renders the distinct calm embed, not the red extraction-failed card', async () => {
  const html = await body(render(ageFail, 'discord', ORIGIN))
  // A valid, complete HTML document (single head, empty body) — the same envelope every embed uses.
  assert.match(html, /^<!doctype html><html><head>.*<\/head><body><\/body><\/html>$/s)
  // EXACTLY ONE og:title and og:description — a second of either is silently ignored by OGP, so the
  // wrong line would win. The copy is the owner's, verbatim.
  assert.deepEqual(tagsOf(html, 'og:title'), ['🔞 This post is age-restricted'])
  assert.deepEqual(tagsOf(html, 'og:description'), ["Can't preview age-restricted posts."])
  // DISTINCT from a genuine failure: never the generic title.
  assert.ok(!/couldn't load/i.test(html), 'an age-gate is not the generic couldn-t-load card')
  // Calmer than errorEmbed's alarm red — a known limit, not an error — but still exactly one valid hex.
  const theme = namedOf(html, 'theme-color')
  assert.equal(theme.length, 1, 'exactly one theme-color')
  assert.notEqual(theme[0], '#d33', 'no alarm red for a known limit')
  assert.match(theme[0], /^#[0-9a-fA-F]{3,6}$/, 'still a valid hex')
})

test('a HUMAN on an age-restricted post is 302d to the canonical, never shown the age embed', () => {
  // The human path is unchanged: they 302 to x.com (where they can log in) — the age embed is a
  // crawler-only surface, and the ageRestricted flag must be read AFTER the human short-circuit.
  const r = render(ageFail, 'human', ORIGIN)
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://x.com/jack/status/1')
})

test('a GENERIC failure renders the neutral couldn-t-load card, calm not red', async () => {
  // LOUD DEFAULT: same platform, same reason, gate absent -> NOT the 🔞/🔒 cards, but no longer the
  // alarm-red "extraction failed" either. A recognized post we could not load gets the calm neutral
  // card with honest hedged copy, so a wall we did not classify stops reading as a tool error.
  const html = await body(render({ ...ageFail, gate: undefined }, 'discord', ORIGIN))
  assert.match(html, /og:title" content="Couldn't load this Twitter post"/)
  assert.match(html, /og:description" content="It may be private, removed, or unavailable\."/)
  assert.equal(namedOf(html, 'theme-color')[0], '#657786', 'the calm neutral, not alarm red')
  assert.ok(!/age-restricted/i.test(html), 'no age concept leaks into a generic failure')
  assert.ok(!/extraction failed/i.test(html), 'and never the old alarm-red copy')
})

// ── gated-post scheme: PRIVATE is a THIRD case — its own calm 🔒 embed, distinct from the age 🔞 and
// from the red generic failure. Same calm neutral (#657786), owner's copy. Owner-decided.
const privateFail = { kind: 'failure', canonical: 'https://x.com/jack/status/1', platform: 'x',
                      reason: 'could not fetch post', gate: 'private' }

test('gated-post scheme: a private failure renders the distinct 🔒 embed, calm not red', async () => {
  const html = await body(render(privateFail, 'discord', ORIGIN))
  // A valid, complete HTML document (single head, empty body) — the same envelope every embed uses.
  assert.match(html, /^<!doctype html><html><head>.*<\/head><body><\/body><\/html>$/s)
  // EXACTLY ONE og:title and og:description — a second of either is silently ignored by OGP.
  assert.deepEqual(tagsOf(html, 'og:title'), ['🔒 This post is private'])
  assert.deepEqual(tagsOf(html, 'og:description'), ["Can't preview posts from a private account."])
  assert.ok(!/couldn't load/i.test(html), 'a private gate is not the generic couldn-t-load card')
  assert.ok(!/age-restricted/i.test(html), 'and it is NOT the age embed — the two gates are distinct')
  const theme = namedOf(html, 'theme-color')
  assert.equal(theme.length, 1, 'exactly one theme-color')
  assert.equal(theme[0], '#657786', 'the calm neutral, not alarm red')
})

test('gated-post scheme: a HUMAN on a private post is 302d to the canonical, never shown the 🔒 embed', () => {
  const r = render(privateFail, 'human', ORIGIN)
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://x.com/jack/status/1')
})

test('gated-post scheme: the 🔞 age embed is UNCHANGED by the gate generalization', async () => {
  // The existing age copy/color is preserved verbatim through the boolean -> enum move.
  const html = await body(render(ageFail, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(html, 'og:title'), ['🔞 This post is age-restricted'])
  assert.deepEqual(tagsOf(html, 'og:description'), ["Can't preview age-restricted posts."])
  assert.equal(namedOf(html, 'theme-color')[0], '#657786', 'the same calm neutral as private')
})

test('ambiguous: human gets a chooser; crawler is told plainly and given no dead advice', async () => {
  const a = { kind: 'ambiguous', path: '/mrbeast', candidates: ['x', 'ig'] }
  const h = await body(render(a, 'human', ORIGIN))
  assert.match(h, /x\.com\/mrbeast/)
  assert.match(h, /instagram\.com\/mrbeast/)

  const d = await body(render(a, 'discord', ORIGIN))
  assert.match(d, /ambiguous/i)
  /**
   * Must NOT advise "/x/mrbeast", and the reason CHANGED on 2026-08-11 without the assertion
   * changing. It used to be that no profile was a route at all; now one is — Bluesky's
   * /profile/{handle} — but X's is still not, because a bare handle is Instagram's shape too and
   * claiming it for either would serve a card from a site the reader never pasted (router.ts's
   * profile() carries the measurement). So the prefix would still 404, and advice that does not
   * work is worse than none.
   */
  assert.ok(!/\/x\/mrbeast/.test(d), 'must not advise a prefix that 404s')
  // And the copy no longer claims profiles are impossible, which stopped being true the same day.
  assert.ok(!/bare profile links cannot/.test(d), 'the old absolute claim is gone')
  assert.match(d, /names an account on both/, 'it says what is true of THIS row instead')
})

test('video dimensions are lied about on the plain-og path', async () => {
  // Asks 'other-bot' since Task 5, and the title lost its "for Discord" with it: a video is
  // media, so a discord client now takes the spoof path, which emits no og:video at all.
  // The lie itself is unchanged and still ships — fudge() is why Discord neither drops a 4K
  // video nor postage-stamps a low-res one — so the assertions are re-pointed, not relaxed.
  const big = { ...base, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 3840, h: 2160 }] }
  const h1 = await body(render({ kind: 'post', post: big }, 'other-bot', ORIGIN))
  assert.match(h1, /og:video:width" content="1920"/) // halved: Discord drops 4K
  assert.match(h1, /og:video:height" content="1080"/)

  const small = { ...base, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 200, h: 300 }] }
  const h2 = await body(render({ kind: 'post', post: small }, 'other-bot', ORIGIN))
  assert.match(h2, /og:video:width" content="400"/) // doubled: Discord postage-stamps low-res
  assert.match(h2, /og:video:height" content="600"/)
})

test('video: twitter:image is absolute and there is no og:image to outrank it', async () => {
  // 'other-bot' since Task 5 — see the note on the test above. The /_alt/0 suppression trick
  // is a plain-og-path device (the spoof path suppresses images by emitting none at all), so
  // this is where it has to keep being exercised.
  const vid = { ...base, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 1280, h: 720 }] }
  const html = await body(render({ kind: 'post', post: vid }, 'other-bot', ORIGIN))
  // A bare "0" resolves to /0 on our origin — the bare-username shape — which would
  // serve a chooser and a bogus ambiguous datapoint on every video embed.
  assert.ok(!/twitter:image" content="0"/.test(html))
  assert.match(html, new RegExp(`twitter:image" content="${ORIGIN}/_alt/0"`))
  // An og:image (e.g. the avatar) would defeat the suppression the /_alt/0 trick exists for.
  assert.equal(tagsOf(html, 'og:image').length, 0, 'video embeds must not carry an og:image')
})

test('discord + media takes the spoof path: no og:image and no og:video at all', async () => {
  // The suppression IS the mechanism (wire spec §6a), not an omission: FxEmbed's
  // src/embed/status.ts:449 skips its whole media block on this path. Any image tag here
  // hands Discord a single-image OpenGraph card to prefer over the gallery the activity
  // JSON describes, and og:image outranks everything else on that card — so the spoof would
  // silently degrade to "one picture", which is what Phase 1 already did.
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(html, 'og:image'), [], 'an og:image defeats the entire spoof')
  assert.deepEqual(tagsOf(html, 'og:video'), [])
  assert.deepEqual(namedOf(html, 'twitter:image'), [])
  // twitter:card is the ONE image-ish tag that stays. §6a said "no twitter:card", correction
  // C1 measured it live on both branches and overturned that — and corrections win over
  // anything earlier in the document. It names a card layout, not an image source, so with
  // zero og:image there is nothing for it to promote over the activity gallery.
  assert.deepEqual(namedOf(html, 'twitter:card'), ['summary_large_image'], 'C1: media >= 1 => summary_large_image')
  // Stronger than counting tags: no media URL of ANY shape reaches this head. The spoof
  // advertises media exclusively through media_attachments in the activity JSON.
  assert.ok(!html.includes('/_media/'), 'the spoof head must advertise no media directly')
})

const spoofTags = html =>
  [...html.matchAll(/<(?:meta|link)\b[^>]*>/g)].map(m => m[0].replace(/\/(statuses|_oembed)\/\d+/, '/$1/{id}'))

test('the spoof head is EXACTLY the ten tags the corrections specify, in order', async () => {
  // §6a says "Emit ONLY" — a blacklist of absent tags cannot express that, so an added
  // og:type or a stray al:android:app_name would pass every other test in this file. This is
  // the whitelist, and it is the only place that pins the presence of rel="canonical".
  //
  // TEN SINCE 2026-08-01, AND THE SECOND theme-color IS DELIBERATE. This comment used to name
  // "a second theme-color" as an example of what the whitelist existed to CATCH, and that is
  // exactly what it caught — so the list was amended on purpose rather than re-baselined past.
  //
  // The reason is that property= was found to be the WRONG spelling and the one we shipped alone:
  // theme-color is a standard HTML meta taking name=, Discord reads name=, and our cards were
  // therefore uncoloured. name= leads now, property= ships beside it for consumers that copied
  // fxtwitter's spelling, and BOTH COME FROM ONE themeColor() CALL — see discord.ts, and see the
  // equality assertion in the name=/property= test below, which is what makes the duplication safe
  // rather than merely tolerated.
  //
  // NINE is now the WITH-MEDIA count specifically; the no-media head has a tenth tag (og:image)
  // and gets its own whitelist below. Two whitelists rather than one parametrised over the media
  // branch, because "emit only" is a claim about a literal list of bytes and the two lists
  // genuinely differ.
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.deepEqual(spoofTags(html), [
    '<meta property="og:title" content="Alice (@alice.bsky.social)"/>',
    '<meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/>',
    `<meta property="og:url" content="${base.canonical}"/>`,
    '<meta property="og:site_name" content="mbedfx"/>',
    '<meta name="theme-color" content="#0085ff"/>',
    '<meta property="theme-color" content="#0085ff"/>',
    '<meta name="twitter:card" content="summary_large_image"/>',
    `<link rel="canonical" href="${base.canonical}"/>`,
    `<link rel="alternate" type="application/activity+json" href="${ORIGIN}/users/alice.bsky.social/statuses/{id}"/>`,
    `<link rel="alternate" type="application/json+oembed" href="${ORIGIN}/_oembed/{id}"/>`,
  ])
})

test('the no-media spoof head is those ten tags PLUS one avatar og:image, and nothing else', async () => {
  // The whitelist for C1's 0-media branch. It is the one that has to be a whitelist rather than a
  // count: the failure this catches is a SECOND image tag (og:image:width guessed from nothing,
  // an og:type, a twitter:image) creeping in beside the avatar, which no "exactly one og:image"
  // assertion elsewhere in this file would notice.
  //
  // og:image sits with the other og: tags, before theme-color, matching the plain-og head's
  // order. POSITION IS UNVERIFIED — the live evidence measured that the tag is present, not
  // where — and OGP is order-insensitive except for duplicates, so this pins our choice rather
  // than a fact about Discord. A future reader with real evidence about ordering should move it
  // and update this list; do not move it on aesthetics alone.
  const html = await body(render({ kind: 'post', post: { ...base, media: [] } }, 'discord', ORIGIN))
  assert.deepEqual(spoofTags(html), [
    '<meta property="og:title" content="Alice (@alice.bsky.social)"/>',
    '<meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/>',
    `<meta property="og:url" content="${base.canonical}"/>`,
    '<meta property="og:site_name" content="mbedfx"/>',
    `<meta property="og:image" content="${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/avatar"/>`,
    '<meta name="theme-color" content="#0085ff"/>',
    '<meta property="theme-color" content="#0085ff"/>',
    '<meta name="twitter:card" content="summary"/>',
    `<link rel="canonical" href="${base.canonical}"/>`,
    `<link rel="alternate" type="application/activity+json" href="${ORIGIN}/users/alice.bsky.social/statuses/{id}"/>`,
    `<link rel="alternate" type="application/json+oembed" href="${ORIGIN}/_oembed/{id}"/>`,
  ])
})

test('the spoof head carries both callback links, in the shapes router.ts matches', async () => {
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  const activity = linksOf(html, ACTIVITY)
  const oembed = linksOf(html, OEMBED)
  assert.equal(activity.length, 1, `expected exactly one ${ACTIVITY} link, got ${activity.length}`)
  assert.equal(oembed.length, 1, `expected exactly one ${OEMBED} link, got ${oembed.length}`)
  assert.ok(activity[0].startsWith(`${ORIGIN}/users/alice.bsky.social/statuses/`), activity[0])
  assert.ok(oembed[0].startsWith(`${ORIGIN}/_oembed/`), oembed[0])
  // PURE DIGITS, both of them. This is the asymmetric bet of wire spec §1: real Mastodon ids
  // are numeric snowflakes, so if Discord requires a numeric-looking id and we ship
  // 'bs%3Aalice…' the spoof does nothing — and because this path emits zero og:image, the
  // result is worse than the plain-og head Phase 1 ships. A letter here is that regression.
  for (const href of [activity[0], oembed[0]]) {
    assert.match(href.split('/').pop(), /^[0-9]+$/, `status id must look like a snowflake: ${href}`)
  }
})

test('the activity href round-trips: its last segment decodes back to the post refKey', async () => {
  // Shape alone ("pure digits") would pass on an id that names a DIFFERENT post, so this
  // closes the loop through the real decoder. encodeStatusId and decodeStatusId agreeing
  // with each other is a claim statusid.test.mjs already owns; what is unproven until here
  // is that the RENDERER and the ROUTER agree — that what this head advertises is what
  // route() will hand back to the worker when Discord calls it.
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  for (const href of [linksOf(html, ACTIVITY)[0], linksOf(html, OEMBED)[0]]) {
    assert.equal(decodeStatusId(href.split('/').pop()), refKey(base.ref))
  }
})

test('the spoof callbacks route back to the post they advertise, handle or no handle', async () => {
  // The end-to-end version of the round trip: feed our own hrefs to route(). The empty-handle
  // case is the one that bites — {handle} is decoration (the id carries the whole ref and
  // router.ts never parses that segment), but '/users//statuses/{id}' loses the empty segment
  // to route()'s filter(Boolean), leaving three segments, which matches NO spoof shape. A
  // cache record with no author.handle would therefore 404 its own callback, invisibly.
  //
  // '.' and '..' are the same defect wearing a different hat, and worse: encodeURIComponent
  // does NOT escape them, so they reach the wire intact and RFC 3986 dot-segment removal —
  // applied by `new URL`, undici and curl, i.e. by whatever Discord fetches with — collapses
  // the path BEFORE route() ever sees it. '/users/./statuses/{id}' arrives as three segments
  // and '/users/../statuses/{id}' as two. Neither matches a spoof shape, and neither is caught
  // by the badid branch, which keys on spoofShape() still matching. Measured through this
  // exact loop before the fix: handle '.' -> notfound, handle '..' -> notfound.
  //
  // '%2e%2e' is the control and it is here on purpose: it routes fine, which proves the hole
  // is specifically BARE dot segments and not percent-encoding in general.
  for (const handle of ['alice.bsky.social', '', '.', '..', '%2e%2e', 'did:plc:z72i', 'a/b', 'é']) {
    const post = { ...base, author: { ...base.author, handle } }
    const html = await body(render({ kind: 'post', post }, 'discord', ORIGIN))
    const href = linksOf(html, ACTIVITY)[0]
    // Through `new URL`, not the raw href: normalization is the whole hazard, and reading the
    // string straight into route() would skip the step that breaks it.
    const activity = route(new URL(href))
    const oembed = route(new URL(linksOf(html, OEMBED)[0]))
    assert.equal(activity.kind, 'activity', `handle ${JSON.stringify(handle)}: activity href did not route: ${href}`)
    assert.equal(oembed.kind, 'oembed', `handle ${JSON.stringify(handle)}: oembed href did not route`)
    assert.deepEqual(activity.ref, base.ref)
    assert.deepEqual(oembed.ref, base.ref)
  }
})

test('a lone surrogate in the handle degrades, it does not throw', async () => {
  // encodeURIComponent throws URIError on an unpaired surrogate, and str() blesses such a
  // value as a string, so nothing upstream stops it. worker.ts's 'post' case wraps only
  // d.fetchPost in a try/catch — a throw out of render() is an uncaught 500 from the one
  // module whose entire contract is to degrade. Measured before the fix: rendering this post
  // to 'discord' threw `URIError: URI malformed`, while the byte-identical post with no media
  // (the plain-og path, which never encodes the handle) returned 200.
  //
  // Only reachable through a corrupted or hostile cache record — normalize.ts takes the handle
  // from the Bluesky API, which validates domain-shaped handles — but that is precisely the
  // threat model str(), mediaOf() and attachment()'s defensive reads all exist for.
  const post = { ...base, author: { ...base.author, handle: 'a\uD800b' } }
  const html = await body(render({ kind: 'post', post }, 'discord', ORIGIN))
  const activity = route(new URL(linksOf(html, ACTIVITY)[0]))
  assert.equal(activity.kind, 'activity', 'the callback must still name the post')
  assert.deepEqual(activity.ref, base.ref)
})

test('the gate and the Mastodon attachment list agree about "has media"', async () => {
  // discord.ts's gate and mastodon.ts's attachments() must apply the SAME predicate. The gate
  // decides "suppress every image tag"; attachments() decides what the gallery contains. When
  // they disagree, a post takes the image-suppressing path and then describes zero attachments
  // — an embed with no picture in it by either route, strictly worse than Phase 1, which would
  // at least have shown the avatar.
  //
  // Measured before the fix with each of these media lists: 'discord' rendered a spoof head
  // with zero og:image while toMastodonStatus(...).media_attachments was []. The [null] entry
  // additionally threw `Cannot read properties of null (reading 'kind')` out of the plain path,
  // where the raw `media.find(m => m.kind === ...)` reads it — a 500, again on the degrade path.
  //
  // The SHAPE of the agreement changed with C1: since the spoof head is now what every Discord
  // response gets, "they disagree" no longer means "took the wrong head" — it means the head
  // suppressed og:image while media_attachments came out empty, leaving no picture by EITHER
  // route. So the assertion moved from the activity link to og:image. The property it pins is
  // the same one and it is still the property that matters.
  for (const media of [[null], ['nope'], [{ kind: 'poll', url: '' }], [{ kind: 'image', url: null, w: 0, h: 0 }]]) {
    const post = { ...base, media }
    assert.deepEqual(toMastodonStatus(post, ORIGIN).media_attachments, [], 'precondition: nothing to show')
    const html = await body(render({ kind: 'post', post }, 'discord', ORIGIN))
    const label = JSON.stringify(media)
    assert.equal(linksOf(html, ACTIVITY).length, 1, `${label}: C1 emits the links regardless of media`)
    const imgs = tagsOf(html, 'og:image')
    assert.equal(imgs.length, 1, `${label}: an empty gallery must fall back to the avatar, got ${imgs.length}`)
    assert.match(imgs[0], /\/avatar$/)
    assert.deepEqual(namedOf(html, 'twitter:card'), ['summary'], `${label}: nothing usable is the 0-media branch`)
  }
})

test('the spoof head keeps og:title and og:description as fallback insurance', async () => {
  // Documented insurance (§6a): if Discord ever stops following the activity+json link, the
  // embed degrades to a titled, described card instead of to nothing at all.
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  // Proves this head is the SPOOF head. Without it the test passes on the plain-og path too
  // (which also carries a title and a description), so it would keep passing if the gate
  // silently stopped firing — asserting a property both branches share while believing you
  // are testing one of them.
  assert.equal(linksOf(html, ACTIVITY).length, 1, 'this must be the spoof head, not the plain one')
  assert.deepEqual(tagsOf(html, 'og:title'), ['Alice (@alice.bsky.social)'])
  assert.deepEqual(tagsOf(html, 'og:url'), [base.canonical])
  const desc = tagsOf(html, 'og:description')
  assert.equal(desc.length, 1)
  assert.match(desc[0], /hello/)
  // COUNTS-FREE (§3), and this is the subtle one. Counts legitimately render on two surfaces
  // at once because those surfaces have disjoint consumers — but og:description and oEmbed
  // author_name are NOT disjoint: the OpenGraph path reads the body from one and the author
  // line from the other, so a count here prints the stats twice in a single embed. `base`
  // has nonzero likes/reposts/replies, so a leak would show up as the heart.
  assert.ok(!desc[0].includes('❤'), `og:description must not carry counts: ${desc[0]}`)
})

test('a text-only post to discord takes the SPOOF head, with the avatar as its ONE og:image', async () => {
  // CHANGED BY EVIDENCE, not by preference. This test previously asserted the opposite — that a
  // text-only Discord post stayed on the plain-og head — because the gate shipped wire-spec §5
  // (`discord && has media`) over correction C1 (`discord`, with only og:image gated on media).
  // §5's argument was a risk argument: the spoof was unverified, and a text-only post had a
  // human-verified Phase 1 embed to lose. On 2026-07-18 the spoof was verified in a REAL Discord
  // client (Android): a 4-image Bluesky post drew a correct 2x2 gallery with author row, full
  // text and engagement counts, hoisted quote media rendered, blank lines survived, and the
  // counts rendered exactly ONCE (C4's feared double-render did not happen). The risk argument
  // is spent, and the same session showed the cost of keeping it: reply and text-only posts fell
  // back to the plain head and rendered visibly worse next to the spoof — a blue link title, the
  // avatar shoved into a corner as a small thumbnail, no proper author row.
  //
  // So this is C1's table, now the shipped behaviour: 0 usable media -> exactly ONE og:image (the
  // avatar) and twitter:card=summary, links out regardless.
  const textOnly = { ...base, media: [] }
  const html = await body(render({ kind: 'post', post: textOnly }, 'discord', ORIGIN))
  // Proves this is the SPOOF head and not the plain one. og:image alone cannot: BOTH heads emit
  // exactly one avatar og:image on a text-only post, so without this the test would keep passing
  // if the gate silently reverted — asserting a property both branches share while believing you
  // are testing one of them.
  assert.equal(linksOf(html, ACTIVITY).length, 1, 'C1: the activity link goes out for every discord response')
  assert.equal(linksOf(html, OEMBED).length, 1, 'C1: the oembed link goes out for every discord response')
  const imgs = tagsOf(html, 'og:image')
  assert.equal(imgs.length, 1, `C1: 0 media => exactly one og:image, got ${imgs.length}: ${imgs}`)
  assert.equal(imgs[0], `${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/avatar`, 'it must be the avatar')
  assert.deepEqual(namedOf(html, 'twitter:card'), ['summary'], 'C1: 0 media => summary')
  // No dimension tags to go with it: we have no width/height for an avatar, and dimTags would
  // have to guess. Same call the plain head makes.
  assert.deepEqual(tagsOf(html, 'og:image:width'), [])
  assert.deepEqual(tagsOf(html, 'og:image:height'), [])
})

test('a text-only discord post with NO avatar emits no og:image — never a /avatar URL that 404s', async () => {
  // The repo has a scar here: a corrupt ref once shipped og:image=".../_media/undefined/avatar".
  // An avatar-less author is not hypothetical — deserializePost validates ref, canonical and
  // createdAt and NOTHING else, so `author` can be absent from a cache record entirely, and
  // normalize.ts omits `avatar` for an account that has none. Pointing og:image at
  // /_media/{key}/avatar there advertises an image guaranteed to 404 (pickMedia returns null),
  // and a broken picture is worse than no picture — which is the same rule usable()'s url clause
  // states for post media.
  //
  // The links still go out (C1 gates only og:image on media), and the head must not THROW:
  // worker.ts calls render() outside any try/catch, so a throw here is an uncaught 500 out of
  // the one module whose entire contract is to degrade.
  const { avatar, ...noAvatar } = base.author
  for (const author of [noAvatar, undefined]) {
    const post = { ...base, media: [], author }
    const label = author ? 'author with no avatar' : 'no author at all'
    const html = await body(render({ kind: 'post', post }, 'discord', ORIGIN))
    assert.deepEqual(tagsOf(html, 'og:image'), [], `${label}: an og:image we cannot serve is worse than none`)
    assert.ok(!html.includes('/avatar'), `${label}: no /avatar URL may reach the wire`)
    assert.ok(!html.includes('undefined'), `${label}: the literal string "undefined" reached the wire`)
    assert.equal(linksOf(html, ACTIVITY).length, 1, `${label}: the links are NOT gated on the avatar`)
    assert.equal(linksOf(html, OEMBED).length, 1, `${label}: the links are NOT gated on the avatar`)
    // twitter:card still reports the media branch honestly — it names a card LAYOUT, not an
    // image source, so "summary with no image" is a coherent thing to say.
    assert.deepEqual(namedOf(html, 'twitter:card'), ['summary'], `${label}: 0 media => summary`)
  }
})

test('a QUOTE-ONLY discord post takes the spoof head with ZERO og:image', async () => {
  // "Has media" is the HOISTED question (mediaList), not the post's own array — a quote-only post
  // has a picture to show, it just lives one level down. If this asked post.media it would fall
  // into C1's 0-media branch and emit the author's AVATAR as og:image while the activity JSON
  // described a gallery containing the picture the post is actually about: a face where the
  // content is, and og:image outranks everything else on the card. C1 names that exact state
  // ("a quote-only post gets both an avatar og:image and a populated media_attachments") as the
  // thing §7 must not leave behind.
  const quoteOnly = {
    ...base, media: [],
    quote: { ref: { p: 'bs', handle: 'carol.example', rkey: '3p1p' },
             canonical: 'https://bsky.app/q', text: 'quoted body',
             author: { name: 'Carol', handle: 'carol.example', url: 'https://bsky.app/profile/carol.example' },
             media: [{ kind: 'image', url: 'https://cdn.bsky.app/q.jpg', w: 1000, h: 500 }] },
  }
  const html = await body(render({ kind: 'post', post: quoteOnly }, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(html, 'og:image'), [], 'an og:image outranks the gallery and defeats the spoof')
  assert.ok(!html.includes('/avatar'), 'the avatar must not sneak in on a post that HAS a picture')
  assert.deepEqual(namedOf(html, 'twitter:card'), ['summary_large_image'], 'C1: media >= 1 => summary_large_image')
  assert.equal(linksOf(html, ACTIVITY).length, 1)
})

test('other-bot and telegram are BYTE-IDENTICAL across the C1 gate change', async () => {
  // C1 moved a gate that reads `client === 'discord'`, and the risk of such a change is that it
  // leaks: a tag added for Discord, or a branch re-shaped around it, reaching a client that never
  // opted into the bet. Every other test in this file inspects tags; this one pins whole
  // documents, so ANY drift breaks here.
  //
  // The expected strings are written out concretely rather than captured from HEAD at runtime,
  // for the same reason quote-media.test.mjs pastes its golden bytes: a self-comparing test
  // proves only that the code equals itself. Both sides of the media gate, because the no-media
  // branch is the one C1 touched on the Discord side.
  const OG = '<meta property="og:title" content="Alice (@alice.bsky.social)"/><meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/>' +
    `<meta property="og:url" content="${base.canonical}"/><meta property="og:site_name" content="mbedfx"/>`
  //
  // THESE TWO CLIENTS ARE NO LONGER BYTE-IDENTICAL TO EACH OTHER, and that is a deliberate
  // Phase 3a change rather than the leak this test hunts. theme-color was added to the PLAIN
  // head (discord.ts's renderPost) because the video carve-out then sent TikTok videos there and
  // that head had no accent colour at all — 'other-bot' shares that head, so it gains the tag.
  // The carve-out was removed on 2026-07-19 and the tag stays: 'other-bot' still reaches this
  // head with a tt post, and the defect was "a head with no accent", not a Discord-scoped one.
  // 'telegram' does NOT: telegram.ts is a separate renderer with its own head, which happened
  // to be byte-identical to the plain one, and no measurement exists that Telegram reads
  // theme-color. The divergence is recorded here rather than papered over by adding the tag to
  // a third head on no evidence. If Telegram is ever measured to honour it, THIS is the line
  // that says why it does not today.
  // Both spellings, one value — see discord.ts. Written as the pair here so a future change that
  // drops one of them fails on THIS line rather than only on a byte count somewhere else.
  const THEME = '<meta name="theme-color" content="#0085ff"/><meta property="theme-color" content="#0085ff"/>'
  const head = client => (client === 'telegram' ? OG : `${OG}${THEME}`)
  const WITH_MEDIA = `<meta property="og:image" content="${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/0"/>` +
    '<meta property="og:image:width" content="800"/><meta property="og:image:height" content="600"/>' +
    '<meta name="twitter:card" content="summary_large_image"/>'
  const NO_MEDIA = `<meta property="og:image" content="${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/avatar"/>` +
    '<meta name="twitter:card" content="summary"/>'
  const doc = tags => `<!doctype html><html><head>${tags}</head><body></body></html>`
  for (const client of ['other-bot', 'telegram']) {
    assert.equal(await body(render({ kind: 'post', post: base }, client, ORIGIN)), doc(head(client) + WITH_MEDIA), `${client} with media`)
    assert.equal(await body(render({ kind: 'post', post: { ...base, media: [] } }, client, ORIGIN)), doc(head(client) + NO_MEDIA), `${client} text-only`)
  }
})

test('BOTH heads carry reply and quote context in og:description, counts-free', async () => {
  // §5 justifies leaving text-only posts on the plain path with "quote context still reaches
  // those posts through og:description". That was FALSE as shipped: the plain path interpolated
  // raw post.text, so a text-only Discord post lost reply context and quote context to every
  // surface at once — measured before the fix, og:description was "hello world" for a post
  // carrying a quote, and toOEmbed(post).author_name was "❤️ 7" for a reply, because §3's
  // priority puts counts above reply context. Correction C1 predicted exactly this ("would
  // silently drop rich text, reply context, quote blockquotes and counts from every text-only
  // post"). buildPlainText is what makes §5's own defence true.
  //
  // Swept across BOTH heads — both clients AND both sides of the media gate. The two heads
  // build this tag on separate lines, so covering one proves nothing about the other: proven by
  // mutation, reverting only the plain path's line to raw post.text left every spoof-head
  // assertion green, and reverting only the spoof head's line left the plain ones green.
  const quoting = {
    ...base, text: 'hello world',
    quote: { canonical: 'https://bsky.app/q', text: 'quoted body',
             author: { name: 'Carol', handle: 'carol.example', url: 'https://bsky.app/profile/carol.example' } },
  }
  const replying = {
    ...base, text: 'my reply',
    replyTo: { author: { name: 'Bob', handle: 'bob.bsky.social', url: 'https://bsky.app/profile/bob.bsky.social' } },
  }
  for (const client of ['discord', 'other-bot']) {
    for (const media of [[], base.media]) {
      const at = `${client}/${media.length ? 'media' : 'text-only'}`
      const q = tagsOf(await body(render({ kind: 'post', post: { ...quoting, media } }, client, ORIGIN)), 'og:description')[0]
      assert.match(q, /Quoting Carol \(@carol\.example\)/, `${at}: quote context vanished`)
      assert.match(q, /quoted body/, `${at}: the quoted text itself vanished`)
      const r = tagsOf(await body(render({ kind: 'post', post: { ...replying, media } }, client, ORIGIN)), 'og:description')[0]
      assert.match(r, /↩ Bob \(@bob\.bsky\.social\)/, `${at}: reply context vanished`)
      // Still COUNTS-FREE (§3). base carries nonzero likes/reposts/replies, and og:description
      // shares a consumer with oEmbed author_name — the OpenGraph path reads the body from one
      // and the author line from the other — so a count here prints the stats twice in one embed.
      for (const desc of [q, r]) assert.ok(!desc.includes('❤'), `${at}: counts leaked into og:description: ${desc}`)
    }
  }
})

test('non-Discord bots never get a callback link, with or without media', async () => {
  // An oEmbed document with type:'rich' and no `html` violates the oEmbed spec. Discord
  // demonstrably tolerates it (FxEmbed ships exactly that to 100% of its Discord traffic),
  // but we have NO evidence how Slack or Facebook react — and a bot that follows the link
  // and rejects the document could end up worse off than one that never saw it. No evidence,
  // no link. The activity link is Discord-only for the same reason plus a stronger one: the
  // Mastodon spoof is a bet placed specifically on Discord's behaviour.
  for (const client of ['telegram', 'other-bot']) {
    for (const post of [base, { ...base, media: [] }]) {
      const html = await body(render({ kind: 'post', post }, client, ORIGIN))
      assert.deepEqual(linksOf(html, ACTIVITY), [], `${client} must get no activity link`)
      assert.deepEqual(linksOf(html, OEMBED), [], `${client} must get no oembed link`)
      assert.equal(tagsOf(html, 'og:image').length, 1, `${client} keeps the Phase 1 plain-og head`)
    }
  }
})

test('spoof callback URLs use the REQUEST origin, never a hardcoded one', async () => {
  // The mirror of the /_media/ origin test above, and it needs its own test because the spoof
  // path emits no /_media/ URL for that one to inspect. A hardcoded origin here is worse than
  // in a media URL: a staging embed would send Discord's callback to PROD, where it resolves
  // successfully and serves a real post, so nothing looks broken while staging is silently
  // rendering prod's data.
  const FOREIGN = 'https://some-other-host.example'
  const html = await body(render({ kind: 'post', post: base }, 'discord', FOREIGN))
  const hrefs = [...linksOf(html, ACTIVITY), ...linksOf(html, OEMBED)]
  assert.equal(hrefs.length, 2)
  for (const h of hrefs) assert.equal(new URL(h).origin, FOREIGN, `must use the passed origin: ${h}`)
})

const ttVideo = {
  ref: { p: 'tt', id: '777' },
  canonical: 'https://www.tiktok.com/@u/video/777',
  author: { name: 'U', handle: 'u', url: 'https://www.tiktok.com/@u', avatar: 'https://cdn/a.jpg' },
  text: 'a beluga', createdAt: new Date('2026-07-01T00:00:00Z'),
  // `poster` is the video's cover frame, and a real TikTok video ALWAYS has one — the normalizer
  // reads video.cover off the same payload as the play url. It is on the fixture because
  // media_attachments[].preview_url is built from it (see mastodon.ts): a posterless fixture
  // would quietly exercise only the degraded branch.
  media: [{
    kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280, duration: 10,
    poster: 'https://p16-common-sign.tiktokcdn-us.com/tos-useast8/cover~tplv-tiktokx-origin.image',
  }],
  counts: { likes: 5 }, sensitive: false,
}
const ttSlides = {
  ...ttVideo,
  canonical: 'https://www.tiktok.com/@u/photo/778',
  ref: { p: 'tt', id: '778' },
  media: [
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1080, h: 1920 },
    { kind: 'image', url: 'https://cdn/2.jpg', w: 1080, h: 1920 },
    { kind: 'image', url: 'https://cdn/3.jpg', w: 1080, h: 1920 },
  ],
}

// ONE counts object for the video and the slideshow, so the two surfaces below are comparable
// by construction. The values are chosen to exercise both abbreviation tiers and the untouched
// units at once: 3 -> '3', 21100 -> '21.1K', 4000 -> '4K'.
const COUNTS = { replies: 3, reposts: 21100, likes: 4000 }
const ttVideoCounted = { ...ttVideo, counts: COUNTS }
const ttSlidesCounted = { ...ttSlides, counts: COUNTS }

// ---------------------------------------------------------------------------
// THE VIDEO CARVE-OUT IS GONE (2026-07-19). A tt VIDEO takes the SPOOF head like
// everything else on Discord, and og:video rides along as a FALLBACK.
//
// The carve-out's premise was that the activity+json link COMPETES with og:video, so a post
// with a playable mp4 had to be routed to the plain-og head or lose its player. That premise
// was measured FALSE against production fxtiktok on 2026-07-19:
//
//   $ curl -A '<Discordbot UA>' https://tnktok.com/@mysticaquariumct/video/7660566211100511518
//   ...og:video, og:video:type, og:video:width/height, og:type=video.other,
//      twitter:player*, <link ... application/json+oembed>,
//      <link ... application/activity+json>   <- ALL ON ONE HEAD, no og:image, no twitter:card
//
//   $ curl -A '<Discordbot UA>' https://offload.tnktok.com/api/v1/statuses/7660566211100511518
//   {"content":"<b>❤️ 20.9K 💬 82 🔁 4.1K</b>",
//    "media_attachments":[{"type":"video","url":".../generate/video/7660566211100511518",...}],
//    "account":{...,"avatar":".../generate/pfp/6963676439493821446"}}
//
// Production ships the activity link and og:video TOGETHER, and the owner's screenshot of a real
// Discord client shows the ACTIVITY card winning: avatar row, counts in the BODY (Discord's own
// emoji artwork), a working inline player driven by media_attachments[].type === 'video', and a
// footer. Emitting both is therefore proven-safe, not a conflict.
//
// WHAT THE CARVE-OUT COST, all three reported from real Discord clients: no caption (a
// player-type card renders no og:description at all), counts in the viewer's system emoji font
// instead of Discord's artwork, and no avatar/author row. All three are recovered by simply
// letting video take the spoof path.
// ---------------------------------------------------------------------------

test('A tt VIDEO ON DISCORD TAKES THE SPOOF HEAD, with og:video riding along as a fallback', async () => {
  // The headline reversal. Both links go out, the player tags go out beside them, and og:image
  // stays at ZERO — that last one is the C1 suppression and it is the only rule the removal does
  // NOT relax: an og:image hands Discord a single-image card to prefer over the card we want.
  const html = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.equal(linksOf(html, ACTIVITY).length, 1, 'a video post keeps the spoof bet like every other Discord post')
  assert.equal(linksOf(html, OEMBED).length, 1, 'and the oEmbed link production ships beside it')
  // The FALLBACK, and the one place the "spoof head emits no og:*media*" rule is relaxed. It
  // exists so that a Discord that ever stops following the activity link still gets a player
  // rather than a bare titled card — which is exactly the shape production ships today.
  //
  // TWO ASSERTIONS MOVED with the production-parity change later on 2026-07-19, and both moved
  // to MATCH PRODUCTION rather than because anything here was wrong (see the PARITY block at the
  // end of this file):
  //  - the url gained a '.mp4' suffix, because production's has one;
  //  - og:video:secure_url is GONE, because production emits none. Its absence has its own
  //    dedicated assertion in 'PARITY: a tt VIDEO head drops og:video:secure_url…', so deleting
  //    the line here loses no coverage — it is pinned harder there than it ever was here.
  assert.match(html, /property="og:video" content="[^"]*\/_media\/tt%3A777\/0\.mp4"/)
  assert.match(html, /property="og:video:type" content="video\/mp4"/)
  assert.match(html, /property="og:type" content="video\.other"/)
  assert.match(html, /property="og:video:width" content="720"/)
  assert.match(html, /property="og:video:height" content="1280"/)
  // NOT RELAXED. Production emits no og:image on this head either.
  assert.deepEqual(tagsOf(html, 'og:image'), [], 'an og:image would outrank the card we want')
  // And no raw CDN url reaches the wire, on any tag.
  assert.ok(!html.includes('aweme/v1/play'), 'a raw CDN url must never reach a client')
})

test('a tt VIDEO head emits NO twitter:card — paired with og:video it costs us the activity card', async () => {
  // Measured in a real Discord client on 2026-07-19, after the carve-out removal shipped and the
  // video STILL rendered as an OpenGraph card (no avatar, counts in the author line in the
  // viewer's system emoji font, no footer) while the slideshow rendered the activity card.
  //
  // Three heads isolate the cause, and only the PAIR is fatal:
  //   our slideshow  twitter:card, no og:video  -> activity card
  //   our video      twitter:card +  og:video   -> OpenGraph card   <- the regression
  //   production     no twitter:card, og:video  -> activity card
  //
  // Diffing our own two heads narrows it to the og:video block, and production proves og:video
  // alone is harmless — so the combination is what tips Discord. Production omits twitter:card on
  // video posts, and this test pins that we do too.
  //
  // This asserts an ABSENCE, which is the weaker kind of test, so state what makes it non-vacuous:
  // the sibling assertions below prove the tag is still emitted on every OTHER branch, so a
  // regression that dropped it everywhere would turn those red rather than leave this green.
  const html = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.deepEqual(namedOf(html, 'twitter:card'), [], 'og:video + twitter:card loses the activity card')
  // The tag it would have displaced is still there, so this is a swap of card model, not a loss.
  assert.equal(linksOf(html, ACTIVITY).length, 1)
  assert.match(html, /property="og:video"/)
})

test('every NON-video Discord head still emits twitter:card — the omission is scoped to og:video', async () => {
  // The non-vacuity guard for the test above. If someone "simplifies" by dropping twitter:card
  // unconditionally, these go red; if they restore it unconditionally, the test above goes red.
  // The pair is what pins the branch.
  const slides = await body(render({ kind: 'post', post: ttSlides }, 'discord', ORIGIN))
  assert.deepEqual(namedOf(slides, 'twitter:card'), ['summary_large_image'],
    'a slideshow has media but no og:video, so C1 row 1 still applies')
  assert.equal(linksOf(slides, ACTIVITY).length, 1, 'and it keeps the activity card it already had')

  const textOnly = await body(render({ kind: 'post', post: { ...ttVideo, media: [] } }, 'discord', ORIGIN))
  assert.deepEqual(namedOf(textOnly, 'twitter:card'), ['summary'], 'no media at all is C1 row 2')
})

test('a tt VIDEO status carries ONE media_attachment, type "video", on OUR origin', async () => {
  // This is what actually draws the inline player: Discord reads media_attachments[].type, not
  // og:video, on the card it chooses. Production's own status JSON is the evidence
  // (type:"video", url on its own offload host, meta.original 720x1280).
  const st = toMastodonStatus(ttVideo, ORIGIN)
  assert.equal(st.media_attachments.length, 1, 'exactly one attachment for a one-video post')
  const [a] = st.media_attachments
  assert.equal(a.type, 'video', "Mastodon's vocabulary for a video with sound; 'gifv' is the soundless-loop type")
  assert.equal(a.url, `${ORIGIN}/_media/tt%3A777/0`)
  // preview_url IS THE POSTER, NOT THE VIDEO. This assertion used to read
  // `assert.equal(a.preview_url, a.url)` — it was pinning the defect itself. Measured 2026-07-19:
  // Discord asks for the poster, gets mp4 bytes, and drops the rich activity card for the plain
  // OpenGraph one. See types.ts's Media.poster for the three-way payload diff.
  assert.equal(a.preview_url, `${ORIGIN}/_media/tt%3A777/poster0`)
  assert.notEqual(a.preview_url, a.url, 'preview_url pointing at the video is the bug')
  assert.deepEqual(a.meta, { original: { width: 720, height: 1280, size: '720x1280', aspect: 720 / 1280 } })
  // THE PROJECT CONSTRAINT, asserted over the WHOLE serialized blob rather than one field: a raw
  // CDN url anywhere in this document is a cookie-gated, expiring url handed to a client that
  // caches what it fetches.
  const blob = JSON.stringify(st)
  assert.ok(!blob.includes('aweme/v1/play'), `a raw CDN url leaked into the status: ${blob}`)
  assert.ok(!blob.includes('tiktokcdn'), 'nor any other raw CDN host')
})

test("a tt VIDEO's Mastodon content carries BOTH the caption AND the counts", async () => {
  // Defect 1 of the three the carve-out cost. og:description is not rendered on a player card at
  // all, so the caption reached nobody; `content` is the body Discord draws on the activity card
  // and it carries both parts at once, with the counts in Discord's own emoji artwork.
  //
  // NOTE this is a deliberate SUPERSET of production, which ships counts-only content
  // ("<b>❤️ 20.9K 💬 82 🔁 4.1K</b>", measured 2026-07-19) and puts the caption nowhere on the
  // activity card. We have a caption surface that works; there is no reason to drop it.
  const content = toMastodonStatus(ttVideoCounted, ORIGIN).content
  assert.match(content, /a beluga/, 'the caption must survive onto the one body surface that renders')
  assert.match(content, /<b>.*<\/b>$/, 'and the counts block must terminate it')
  for (const glyph of ['❤️ 4K', '\u{1F4AC} 3', '\u{1F501} 21.1K']) {
    assert.ok(content.includes(glyph), `a count went missing from content: ${content}`)
  }
})

test('a tt VIDEO status populates account.avatar — the author row the carve-out had no way to draw', async () => {
  // Defect 3. On the plain head a video embed showed a bare "mbedfx" provider line and no
  // face at all; the account block is where the avatar row comes from, and it only exists on the
  // activity document.
  const st = toMastodonStatus(ttVideo, ORIGIN)
  assert.equal(st.account.avatar, `${ORIGIN}/_media/tt%3A777/avatar`)
  assert.equal(st.account.avatar_static, st.account.avatar)
  assert.equal(st.account.display_name, 'U')
})

test('a tt SLIDESHOW is UNCHANGED: spoof head, three image attachments, no video tags', async () => {
  // The must-not-break case. Slideshows already took the spoof path, so removing the carve-out
  // must be invisible to them in both documents.
  const html = await body(render({ kind: 'post', post: ttSlides }, 'discord', ORIGIN))
  assert.equal(linksOf(html, ACTIVITY).length, 1)
  assert.equal(linksOf(html, OEMBED).length, 1)
  assert.deepEqual(tagsOf(html, 'og:image'), [], 'the spoof suppresses og:image on a media post')
  assert.ok(!html.includes('og:video'), 'a slideshow has no video, so no fallback either')
  const st = toMastodonStatus(ttSlides, ORIGIN)
  assert.equal(st.media_attachments.length, 3)
  assert.deepEqual(st.media_attachments.map(a => a.type), ['image', 'image', 'image'])
})

test('BLUESKY IMAGE/TEXT POSTS ARE BYTE-IDENTICAL ACROSS THE CARVE-OUT REMOVAL, on every client', async () => {
  // `base` is an IMAGE post and the second case is text-only — the two Bluesky shapes this golden
  // pins. (Bluesky video posts became remux videos on 2026-07-22 and DO now take the video branch;
  // that path is pinned by the video-case golden in mastodon.test.mjs, not here. These non-video
  // goldens are unaffected by that change.) Pinned as WHOLE DOCUMENTS captured before the carve-out
  // removal rather than as property assertions: a stray tag, a lost one or a reordering all fail
  // here, and none of them would fail a single-property check.
  //
  // IT GUARDS THE PRODUCTION-PARITY CHANGE TOO (2026-07-19, see the PARITY block at the end of
  // this file). Every parity divergence is gated on a playable video, and these two cases have
  // none, so "these heads are unaffected" is exactly what the six golden documents make good on,
  // byte for byte, across all three client classes. Note the discord goldens still carry BOTH
  // rel=canonical and twitter:card: the parity change drops those on the video branch ONLY, and
  // this is the standing proof that non-video heads kept them.
  const ID = '1098115058097108105099101046098115107121046115111099105097108058051107050097'
  const OG = '<meta property="og:title" content="Alice (@alice.bsky.social)"/>' +
    '<meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/>' +
    `<meta property="og:url" content="${base.canonical}"/><meta property="og:site_name" content="mbedfx"/>`
  const SPOOF_TAIL = `<link rel="canonical" href="${base.canonical}"/>` +
    `<link rel="alternate" type="application/activity+json" href="${ORIGIN}/users/alice.bsky.social/statuses/${ID}"/>` +
    `<link rel="alternate" type="application/json+oembed" href="${ORIGIN}/_oembed/${ID}"/>`
  const AVATAR = `<meta property="og:image" content="${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/avatar"/>`
  const IMG = `<meta property="og:image" content="${ORIGIN}/_media/bs%3Aalice.bsky.social%3A3k2a/0"/>` +
    '<meta property="og:image:width" content="800"/><meta property="og:image:height" content="600"/>'
  // Both spellings, one value — see discord.ts. Written as the pair here so a future change that
  // drops one of them fails on THIS line rather than only on a byte count somewhere else.
  const THEME = '<meta name="theme-color" content="#0085ff"/><meta property="theme-color" content="#0085ff"/>'
  const doc = tags => `<!doctype html><html><head>${tags}</head><body></body></html>`
  const GOLDEN = {
    'discord/media': doc(`${OG}${THEME}<meta name="twitter:card" content="summary_large_image"/>${SPOOF_TAIL}`),
    'discord/text-only': doc(`${OG}${AVATAR}${THEME}<meta name="twitter:card" content="summary"/>${SPOOF_TAIL}`),
    'other-bot/media': doc(`${OG}${THEME}${IMG}<meta name="twitter:card" content="summary_large_image"/>`),
    'other-bot/text-only': doc(`${OG}${THEME}${AVATAR}<meta name="twitter:card" content="summary"/>`),
    'telegram/media': doc(`${OG}${IMG}<meta name="twitter:card" content="summary_large_image"/>`),
    'telegram/text-only': doc(`${OG}${AVATAR}<meta name="twitter:card" content="summary"/>`),
  }
  for (const client of ['discord', 'other-bot', 'telegram']) {
    for (const [label, post] of [['media', base], ['text-only', { ...base, media: [] }]]) {
      const at = `${client}/${label}`
      assert.equal(await body(render({ kind: 'post', post }, client, ORIGIN)), GOLDEN[at], at)
    }
  }
})

test('telegram and other-bot KEEP the plain head with og:video for a video post', async () => {
  // The plain-head video branch is NOT dead code after the carve-out goes: 'other-bot' shares
  // this head and 'telegram' has its own copy in telegram.ts, and both still need a player.
  // What neither may gain is a Discord-only bet — the two callback links.
  for (const client of ['other-bot', 'telegram']) {
    const html = await body(render({ kind: 'post', post: ttVideoCounted }, client, ORIGIN))
    assert.match(html, /property="og:video" content="[^"]*\/_media\/tt%3A777\/0"/, `${client} keeps its player`)
    assert.match(html, /property="og:type" content="video\.other"/, client)
    assert.deepEqual(tagsOf(html, 'og:image'), [], `${client}: og:image would outrank the player`)
    assert.deepEqual(linksOf(html, OEMBED), [], `${client} must get no oembed link`)
    assert.deepEqual(linksOf(html, ACTIVITY), [], `${client} must get no activity link`)
    assert.ok(!html.includes('aweme/v1/play'), `${client}: a raw CDN url must never reach a client`)
  }
})

test('THE ROUND-TRIP SEAM: a video post\'s activity href decodes back to its own ref', async () => {
  // The spoof only pays off if Discord's callback names this post again. A link that 404s is
  // worse than no link — the card degrades to a bare title with a wasted round trip — and the
  // video path is the one that has never been exercised through this seam before today.
  const html = await body(render({ kind: 'post', post: ttVideoCounted }, 'discord', ORIGIN))
  const href = linksOf(html, ACTIVITY)[0]
  assert.ok(href.startsWith(`${ORIGIN}/users/`), href)
  const last = href.split('/').pop()
  assert.equal(decodeStatusId(last), refKey(ttVideoCounted.ref), 'the id segment must decode to this post ref key')
  const r = route(new URL(href))
  assert.equal(r.kind, 'activity')
  assert.deepEqual(r.ref, ttVideoCounted.ref)
})

// DELETED 2026-07-19: 'A PLAYABLE VIDEO TAKES THE PLAIN og:video PATH, NOT THE SPOOF'.
//
// It asserted `!html.includes('application/activity+json')` with the message "the spoof link
// would compete with og:video" — the carve-out's founding claim, and the one production disproved
// on this date. The claim it made is now made in reverse by 'A tt VIDEO ON DISCORD TAKES THE
// SPOOF HEAD' above, which keeps every other assertion it had (og:video present, og:type present,
// zero og:image) and only flips the link.
//
// Its last assertion, twitter:image=/_alt/0, moved to the other-bot sweep below: that tag lives on
// the plain head, which no Discord response reaches any more.

test('A tt VIDEO ON DISCORD EMITS THE oEMBED LINK — from the SPOOF head, alongside the activity link', async () => {
  // THE HISTORY, because this assertion has been INVERTED THREE TIMES IN ONE DAY and a reader who
  // finds any of the earlier commits first will "fix" it back to a broken state.
  //
  // 141005e: the carve-out had shipped with counts on NO surface — a human saw a TikTok video
  // render a working player and no likes, reposts or comments. An oEmbed link on the PLAIN head
  // fixed it by giving the counts `author_name`. Verified working in a real client.
  //
  // fdd8cfa: the same human then saw a cosmetic follow-on — a video's counts and a slideshow's
  // counts drew DIFFERENT emoji artwork, because author_name is the small author line (viewer's
  // system emoji font) while the spoof's counts ride the Mastodon `content` (embed body, Discord's
  // own emoji). That commit moved the counts to og:description and deleted the link. Wrong, and
  // measured wrong the same day: a screenshot showed a player card renders NO og:description at
  // all, so the counts moved to no surface. 141005e's link was restored.
  //
  // THIS COMMIT ends the whole argument by deleting its premise. The carve-out is gone, so a tt
  // video takes the spoof head, whose oEmbed link this now is — and the video's counts ride the
  // Mastodon `content` exactly as a slideshow's do. The emoji mismatch that drove fdd8cfa and
  // 6fae4a9 is not an "accepted cost" any more; it does not exist.
  const html = await body(render({ kind: 'post', post: ttVideoCounted }, 'discord', ORIGIN))
  assert.equal(linksOf(html, OEMBED).length, 1, 'exactly one oembed link')
  assert.equal(linksOf(html, ACTIVITY).length, 1, 'and the activity link production ships beside it')
  // og:description stays counts-free: §3's double-render trap is still live, and on the spoof head
  // the body Discord reads is `content`, which carries the counts.
  assert.ok(!tagsOf(html, 'og:description')[0].includes('❤'), 'counts in og:description would double-render')
  // The player still has its OpenGraph fallback beside the links. Production fxtiktok ships all
  // three on one head today (measured 2026-07-19).
  //
  // The '.mp4' suffix arrived with the production-parity change later that day (see the PARITY
  // block at the end of this file). Only the URL SPELLING moved — the assertion this test cares
  // about, that the player survives beside both links, is unchanged.
  assert.match(html, /property="og:video" content="[^"]*\/_media\/tt%3A777\/0\.mp4"/)
})

test("a video post's oembed href ROUTES BACK to this very post", async () => {
  // A link Discord follows to a 404 is worse than no link: the author line goes bare and the
  // counts are still lost, but now with a wasted round trip. The activity href gets the same
  // proof in 'THE ROUND-TRIP SEAM' above, and oembedLink() is reused rather than rebuilt so the
  // two heads cannot spell the wire format differently.
  const html = await body(render({ kind: 'post', post: ttVideoCounted }, 'discord', ORIGIN))
  const href = linksOf(html, OEMBED)[0]
  assert.ok(href.startsWith(`${ORIGIN}/_oembed/`), href)
  const r = route(new URL(href))
  assert.equal(r.kind, 'oembed')
  assert.deepEqual(r.ref, ttVideoCounted.ref)
})

test('NEVER ZERO AND NEVER TWO COUNTS SURFACES IN ONE EMBED — §3, swept', async () => {
  // The invariant every 2026-07-19 defect broke, from both directions: 141005e's predecessor had
  // ZERO surfaces (a player with no counts), the naive fix for the emoji mismatch — append to
  // og:description AND keep the link — has TWO, and fdd8cfa's shipped fix had zero again because
  // Discord renders no og:description on a player card. Sweeping it across post kinds and clients
  // is what makes it an invariant rather than a spot check on today's gate.
  //
  // NOT WEAKENED by the carve-out's removal later the same day, and the surfaces it knows about
  // did not change: an og:description carrying a heart, and a linked oEmbed document. What changed
  // is that EVERY Discord post now satisfies the "at least one" half through the spoof head's own
  // link, rather than the video kind satisfying it through a second one. Both halves of the
  // assertion below are load-bearing in the direction they always were.
  //
  // The Mastodon `content` is deliberately NOT counted here: it is a different DOCUMENT with a
  // different consumer, which is precisely why §3 lets the spoof path carry counts there and in
  // author_name at once.
  for (const [post, label] of [[ttVideoCounted, 'tt video'], [ttSlidesCounted, 'tt slideshow'], [base, 'bluesky']]) {
    for (const client of ['discord', 'other-bot', 'telegram']) {
      const html = await body(render({ kind: 'post', post }, client, ORIGIN))
      const inBody = (tagsOf(html, 'og:description')[0] ?? '').includes('❤')
      const linked = linksOf(html, OEMBED).length > 0
      const at = `${label}/${client}`
      assert.ok(!(inBody && linked), `${at}: counts on BOTH og:description and an oEmbed link`)
      // Every one of these fixtures carries real counts, so a Discord viewer must see them
      // somewhere. This is the half that 141005e's defect failed.
      if (client === 'discord') assert.ok(inBody || linked, `${at}: a Discord embed with no counts surface`)
    }
  }
})

test('THE COUNTS STILL REACH author_name ON THE SPOOF PATH, which is where that document is linked', async () => {
  // toOEmbed did not change and must not: the spoof head still links it, and a slideshow's
  // counts still ride author_name there — the body being the Mastodon `content` instead, so the
  // two surfaces stay disjoint. Without this the suite could go green on an oEmbed document
  // whose author line had quietly degraded to the bare 'Embed' floor.
  const o = toOEmbed(ttSlidesCounted, ORIGIN)
  assert.equal(o.author_name, '\u2764\uFE0F 4K   \u{1F4AC} 3   \u{1F501} 21.1K')
  assert.notEqual(o.author_name, 'Embed')
  // And the spoof head is the head that links it — proven by round-tripping the href. As of
  // 2026-07-19 the spoof head is the ONLY head that links it, on any client: the carve-out that
  // gave the plain head a second copy is gone, and TypeScript now forbids re-adding one there.
  const html = await body(render({ kind: 'post', post: ttSlidesCounted }, 'discord', ORIGIN))
  const href = linksOf(html, OEMBED)[0]
  assert.ok(href.startsWith(`${ORIGIN}/_oembed/`), href)
  const r = route(new URL(href))
  assert.equal(r.kind, 'oembed')
  assert.deepEqual(r.ref, ttSlidesCounted.ref)
})

// The golden author_name string, written out rather than built from statParts: a test that calls
// the formatter it is checking proves only that the code equals itself. The emoji are the METRICS
// table's, in its order (likes, replies, reposts — reordered 2026-07-19 to match fxTikTok/tnktok),
// joined with THREE LITERAL SPACES — author_name's own verified separator (§3), not the '&ensp;'
// the Mastodon content block uses.
const AUTHOR_COUNTS = '\u2764\uFE0F 4K   \u{1F4AC} 3   \u{1F501} 21.1K'

test("A tt VIDEO'S og:description IS THE CAPTION ONLY — the counts ride other surfaces", async () => {
  // Still true, for a DIFFERENT reason than when it was written, and both reasons matter.
  //
  // THEN (fdd8cfa's lesson): the video took the plain head, and a real client showed Discord
  // renders NO og:description on a player-type embed — so composing counts into it moved them to
  // no surface at all rather than to a quieter one.
  //
  // NOW (the carve-out's removal): the video takes the SPOOF head, whose body is the Mastodon
  // `content`. og:description is fallback insurance there, not the body, and §3 forbids counts in
  // it because it is not disjoint from oEmbed author_name — the OpenGraph path reads the body from
  // one and the author line from the other. Same assertion, and there is no longer any surface
  // this post's counts fail to reach: `content` carries them for the body, author_name for the
  // top line.
  const html = await body(render({ kind: 'post', post: ttVideoCounted }, 'discord', ORIGIN))
  const [desc] = tagsOf(html, 'og:description')
  // Whole-value equality, not a bare `!includes('❤')`: it pins that the caption SURVIVED and
  // that nothing was appended to it, in one assertion no stray separator can slip past.
  assert.equal(desc, 'a beluga', 'the description is the post text and nothing else')
  for (const glyph of ['❤️', '\u{1F501}', '\u{1F4AC}', '21.1K']) {
    assert.ok(!desc.includes(glyph), `a count leaked into og:description: ${desc}`)
  }
  // The counts surface, present exactly once.
  assert.equal(linksOf(html, OEMBED).length, 1, 'author_name is one of the two counts surfaces')
  // The fallback player survives everything above. ('.mp4' since the production-parity change —
  // the url spelling moved, the claim did not.)
  assert.match(html, /property="og:video" content="[^"]*\/_media\/tt%3A777\/0\.mp4"/)
  // And the counts DO reach the body Discord actually reads on this head.
  assert.match(toMastodonStatus(ttVideoCounted, ORIGIN).content, /<b>.*❤️ 4K.*<\/b>/)
})

test('THE COUNTS ACTUALLY REACH author_name for a tt video post', async () => {
  // The head-side assertions prove the LINK is emitted; this proves the document it points at
  // carries what the link exists to deliver. Without it the suite would pass on a link to a
  // document whose author line had quietly degraded to the bare 'Embed' floor and call the defect
  // fixed. toOEmbed is untouched by any of 2026-07-19's four commits — only who links it moved.
  const o = toOEmbed(ttVideoCounted, ORIGIN)
  assert.equal(o.author_name, AUTHOR_COUNTS)
  assert.notEqual(o.author_name, 'Embed')
})

test('NO twitter:description ANYWHERE — the 6fae4a9 experiment is deleted, not dormant', async () => {
  // 6fae4a9 added a `twitter:description` push to the plain head's video branch, gated on
  // `client === 'discord'`. It was an explicitly-labelled UNVERIFIED EXPERIMENT: a guess that
  // Discord renders a twitter:card=player head under the twitter-card model, which would have
  // explained the day's og:description measurement and given the caption somewhere to land.
  // NOBODY EVER SAW IT WORK.
  //
  // It is obsolete rather than disproven — the caption now reaches the viewer through the Mastodon
  // `content` on the spoof head — and its own comment demanded deletion in that case, because an
  // unfalsified guess left in a head is cargo cult that the next reader mistakes for a measurement.
  //
  // ASSERTED AS AN ABSENCE ACROSS EVERY CLIENT AND BOTH tt POST KINDS, because that is the shape
  // of the mistake this guards: someone re-reads 6fae4a9, sees a caption tag that "cannot hurt",
  // and pushes it back — most plausibly without the client gate, onto 'other-bot', which was never
  // part of any of it.
  for (const post of [ttVideoCounted, ttSlidesCounted]) {
    for (const client of ['discord', 'other-bot', 'telegram']) {
      const html = await body(render({ kind: 'post', post }, client, ORIGIN))
      assert.deepEqual(namedOf(html, 'twitter:description'), [], `${client} must carry no twitter:description`)
    }
  }
  // The caption's real surface, and the reason the experiment has nothing left to recover.
  assert.match(toMastodonStatus(ttVideoCounted, ORIGIN).content, /a beluga/)
})

test('THE VIDEO AND THE SLIDESHOW AGREE ON THE COUNTS THEMSELVES, across both surfaces', async () => {
  // THE EMOJI MISMATCH IS OVER, 2026-07-19, and this comment is the third version of itself.
  //
  // It used to say the two post kinds could NOT render identically: a video's counts sat in oEmbed
  // author_name (small author line, viewer's system emoji font) and a slideshow's in the Mastodon
  // `content` (embed body, Discord's own artwork), because the carve-out put them on different
  // heads. fdd8cfa tried to unify them through og:description and cost the counts entirely; the
  // mismatch was then recorded as an ACCEPTED cost.
  //
  // It is not a cost any more. With the carve-out gone BOTH kinds take the spoof head, so both
  // carry counts in `content` (same artwork, same separator) and both carry them in author_name.
  // The fix for the cosmetic defect turned out to be deleting the design mistake that caused it,
  // not finding a third surface.
  //
  // What this still pins, and what it always pinned: the metrics that survive, their order, their
  // abbreviation and their emoji — everything statParts owns — are identical across the two
  // surfaces. Only the JOIN differs, and each separator is verified for its own surface (three
  // literal spaces for author_name, '&ensp;' for the content block). Both sides are read out of
  // real rendered output rather than compared through the formatter they share, so a second
  // formatter drifting from the first fails HERE.
  const videoCounts = toOEmbed(ttVideoCounted, ORIGIN).author_name

  // Cross-kind on purpose: the VIDEO's author_name against the SLIDESHOW's content block. If the
  // two post kinds ever diverge in which metrics survive, this is the assertion that catches it.
  const content = toMastodonStatus(ttSlidesCounted, ORIGIN).content
  const block = content.slice(content.lastIndexOf('<b>'))
  assert.match(block, /^<b>.*<\/b>$/, `expected a trailing counts block, got: ${content}`)
  // Strip the markup, normalize BOTH joins away, and what is left must match part for part.
  // The content block's trailing separator has no counterpart in author_name, which has nothing
  // following it to separate — hence the trailing empty part is dropped.
  const slidesParts = block.replace(/<\/?b>/g, '').split('&ensp;').filter(Boolean)
  assert.deepEqual(videoCounts.split('   '), slidesParts)

  // And both are the golden parts, so this cannot pass by both surfaces being wrong together.
  assert.equal(videoCounts, AUTHOR_COUNTS)
  // No markup on the plain-text surface: it is a JSON string value, and a '<b>' would be shown.
  assert.ok(!videoCounts.includes('<b>') && !videoCounts.includes('&ensp;'), videoCounts)

  // THE MISMATCH'S GRAVE. A video's OWN content block must now be byte-identical to a slideshow's,
  // which is the thing that was impossible while the carve-out existed and is the whole cosmetic
  // win of removing it. Written as an equality between the two rendered blocks rather than as
  // "the video has counts", because the defect was never absence — it was two different renderings
  // of the same numbers.
  const videoContent = toMastodonStatus(ttVideoCounted, ORIGIN).content
  const videoBlock = videoContent.slice(videoContent.lastIndexOf('<b>'))
  assert.equal(videoBlock, block, 'video and slideshow counts must render as the same bytes now')
})

test('a tt video with NO counts still renders, and author_name degrades to the floor', async () => {
  // A brand-new post has all three counts present and all three ZERO, which is the case a naive
  // `if (post.counts)` gets wrong. The corrupted-cache shapes are here for the same reason
  // statParts guards them: counts survive a JSON round trip, so null/NaN/strings reach a
  // renderer, and 'author_name: "❤️ NaN"' is a visible defect in a real embed.
  const shapes = [
    undefined,
    {},
    { likes: 0, reposts: 0, replies: 0 },
    { likes: null, reposts: 'many', replies: NaN },
    { likes: -5 },
  ]
  for (const counts of shapes) {
    const post = { ...ttVideo, counts }
    const html = await body(render({ kind: 'post', post }, 'discord', ORIGIN))
    const at = `counts=${JSON.stringify(counts)}`
    // The caption is the description whatever the counts do — they are not in it any more.
    assert.equal(tagsOf(html, 'og:description')[0], 'a beluga', at)
    assert.match(html, /property="og:video"/, `the player survives every counts shape: ${at}`)
    // The link still goes out: author_name falls through to the 'Embed' floor rather than
    // rendering a NaN, and a bare author line is not a reason to drop the callback.
    assert.equal(linksOf(html, OEMBED).length, 1, at)
    assert.equal(toOEmbed(post, ORIGIN).author_name, 'Embed', at)
  }

  // The mirror case: counts but NO caption. og:description is then empty and the counts are
  // unaffected — they live on other surfaces, so nothing can strand a separator between them.
  const textless = { ...ttVideoCounted, text: '' }
  const html = await body(render({ kind: 'post', post: textless }, 'discord', ORIGIN))
  assert.equal(tagsOf(html, 'og:description')[0], '')
  assert.equal(toOEmbed(textless, ORIGIN).author_name, AUTHOR_COUNTS)
  // And `content` is the counts block ALONE — no leading separator where the caption would have
  // been. buildContentHtml owns that rule (every separator belongs to the part that follows it);
  // this is the video path exercising it, which nothing did while the carve-out existed.
  assert.equal(toMastodonStatus(textless, ORIGIN).content, '<b>\u2764\uFE0F 4K&ensp;\u{1F4AC} 3&ensp;\u{1F501} 21.1K&ensp;</b>')
})

test('A tt SLIDESHOW IS UNCHANGED — spoof path, activity link, counts in the Mastodon content', async () => {
  const html = await body(render({ kind: 'post', post: ttSlidesCounted }, 'discord', ORIGIN))
  assert.equal(linksOf(html, ACTIVITY).length, 1, 'a slideshow keeps the spoof bet')
  assert.equal(linksOf(html, OEMBED).length, 1, 'and keeps its oembed link')
  assert.ok(!html.includes('og:video'), 'a slideshow has no video to play')
  // og:description on the spoof head stays counts-free: `content` is the body Discord reads
  // there, so counts in both would double-render on THAT path.
  const [desc] = tagsOf(html, 'og:description')
  assert.equal(desc, 'a beluga')
  assert.ok(toMastodonStatus(ttSlidesCounted, ORIGIN).content.includes(`<b>`), 'counts still ride content')
})

test('a text-only BLUESKY post on discord still gets its oembed link — the change is TikTok-video-scoped', async () => {
  // Proves the removal did not widen. A Bluesky post carries no playable video (its HLS video is
  // normalized to a still image), so on Discord it takes the SPOOF head, which emits its own
  // oEmbed link and gets its counts from author_name. Nothing about that moved.
  const textOnly = { ...base, media: [] }
  const html = await body(render({ kind: 'post', post: textOnly }, 'discord', ORIGIN))
  assert.equal(linksOf(html, OEMBED).length, 1, 'the spoof head keeps its counts surface')
  assert.equal(linksOf(html, ACTIVITY).length, 1)
  const [desc] = tagsOf(html, 'og:description')
  assert.ok(!desc.includes('❤'), `counts must not leak into a spoof-head description: ${desc}`)
  // Three literal spaces there, not the EN SPACE: author_name is a different surface with its
  // own verified separator, and this pins that it did not move either.
  assert.equal(toOEmbed(textOnly, ORIGIN).author_name, '\u2764\uFE0F 5   \u{1F4AC} 1   \u{1F501} 2')
})

test('telegram and other-bot see NOTHING of any of it, on a tt video', async () => {
  // 'other-bot' IS the plain head and 'telegram' is a near-copy of it in telegram.ts, so this is
  // the assertion that stops any Discord-only bet being written outside a client test. Neither
  // has ever had a counts surface here and neither gains one; neither gains the deleted
  // twitter:description experiment; and — this is the part the carve-out's removal is about —
  // neither loses its player, because the plain head's video branch is still live for them.
  //
  // The twitter:image=/_alt/0 assertion moved here from the deleted 'A PLAYABLE VIDEO TAKES THE
  // PLAIN og:video PATH' test: that tag lives on this head, which no Discord response reaches any
  // more, so 'other-bot' is now its only audience.
  for (const client of ['other-bot', 'telegram']) {
    const html = await body(render({ kind: 'post', post: ttVideoCounted }, client, ORIGIN))
    assert.equal(tagsOf(html, 'og:description')[0], 'a beluga', `${client} description must stay bare`)
    assert.deepEqual(namedOf(html, 'twitter:description'), [], `${client} must not get the deleted experiment`)
    assert.deepEqual(linksOf(html, OEMBED), [], `${client} must get no oembed link`)
    assert.deepEqual(linksOf(html, ACTIVITY), [], `${client} must get no activity link`)
    assert.match(html, /property="og:video"/, `${client} keeps its player`)
  }
  const other = await body(render({ kind: 'post', post: ttVideoCounted }, 'other-bot', ORIGIN))
  assert.match(other, new RegExp(`twitter:image" content="${ORIGIN}/_alt/0"`), 'the suppression target survives')
})

test('A SLIDESHOW STILL TAKES THE SPOOF — the gallery is what Phase 2 bought', async () => {
  const html = await body(render({ kind: 'post', post: ttSlides }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.equal(tagsOf(html, 'og:image').length, 0, 'the spoof suppresses og:image on a media post')
  assert.ok(!html.includes('og:video'), 'a slideshow has no video to play')
})

test('REGRESSION: Bluesky is untouched — its HLS video is already a thumbnail image', async () => {
  // Bluesky video is normalized to kind:'image' (Phase 1 fix I-1, because Discord cannot play
  // HLS), so no Bluesky post has ever had a kind:'video' entry — it could not reach the carve-out
  // while that existed and cannot reach the og:video fallback that replaced it.
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.equal(tagsOf(html, 'og:image').length, 0)
  assert.ok(!html.includes('og:video'), 'no Bluesky post can produce a video tag on any head')
})

test('the spoof fallback and the plain head ask the SAME question of the SAME list', async () => {
  // playableVideo() reads mediaOf (the post's OWN media), never mediaList (post + hoisted quote
  // media) — and BOTH heads now call it, so this pins the shared predicate rather than a gate.
  // If the two ever asked different questions, a post whose QUOTE carried a video would advertise
  // an og:video whose index names a picture in the parent, or none at all. embed.ts names this
  // defect class explicitly; the carve-out's removal did not retire it, it gave it a second call
  // site inside renderSpoof.
  const quotedVideo = {
    ...base,
    media: [{ kind: 'image', url: 'https://cdn.bsky.app/a.jpg', w: 800, h: 600 }],
    quote: { ...ttVideo, quote: undefined, replyTo: undefined },
  }
  const html = await body(render({ kind: 'post', post: quotedVideo }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:video'), 'a hoisted quote video is not the POST\'s video')
  // The quoted video still reaches the viewer — through the gallery, which is the surface §7
  // hoists it onto. Its attachment is the parent's index 1.
  //
  // AS AN IMAGE POINTING AT ITS POSTER, since 2026-07-20. The hoist makes this gallery MIXED (an
  // image beside a video), and Discord renders only the type of the first attachment — so emitting
  // this entry as type:"video" is emitting it as nothing at all. See galleryHasVideo() in
  // mastodon.ts. Nothing is lost by the conversion here either: the og:video assertion two lines
  // up is the proof that this post has no player on any head to begin with.
  const st = toMastodonStatus(quotedVideo, ORIGIN)
  assert.deepEqual(st.media_attachments.map(a => a.type), ['image', 'image'],
    'a mixed gallery is flattened, so the hoisted video renders instead of being discarded')
  assert.equal(st.media_attachments[1].url, `${ORIGIN}/_media/${encodeURIComponent(refKey(base.ref))}/poster1`,
    'and it addresses its POSTER, never the mp4')
})

test('a video entry with no url produces NO og:video fallback', async () => {
  // usable() is the shared predicate: an object with no url resolves through pickMedia to null,
  // so emitting a fallback for it would advertise a player guaranteed to 404. Under the carve-out
  // this also meant skipping the spoof path entirely; now the post takes the spoof either way and
  // only the fallback tag is at stake — a strictly smaller blast radius for the same guard.
  const broken = { ...ttVideo, media: [{ kind: 'video', w: 720, h: 1280 }] }
  const html = await body(render({ kind: 'post', post: broken }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:video'))
})

test('other-bot and telegram keep their own shapes on a tt video', async () => {
  const other = await body(render({ kind: 'post', post: ttVideo }, 'other-bot', ORIGIN))
  assert.match(other, /og:video/, 'the plain head still emits og:video for other bots')
  const tg = await body(render({ kind: 'post', post: ttVideo }, 'telegram', ORIGIN))
  assert.ok(!/http-equiv=["']?refresh/i.test(tg))
})

test('THE oEMBED LINK MUST NOT LEAK to other-bot or telegram on a video post', async () => {
  // The oEmbed link is a DISCORD bet and does not transfer to another consumer for free. An
  // oEmbed document with type:'rich' and no `html` violates the oEmbed spec; Discord demonstrably
  // tolerates it (FxEmbed ships exactly that to 100% of its Discord traffic) but we have NO
  // evidence how Slack or Facebook react, and a bot that follows the link and then rejects the
  // document ends up worse off than one that never saw it.
  //
  // This assertion has survived every flip of where that link is emitted from — plain head only,
  // neither head (fdd8cfa), both heads (141005e), spoof head only (the carve-out's removal) —
  // which is the point of writing it as a sweep over the clients rather than as a property of
  // whichever line discord.ts currently has.
  for (const client of ['other-bot', 'telegram']) {
    const html = await body(render({ kind: 'post', post: ttVideo }, client, ORIGIN))
    assert.deepEqual(linksOf(html, OEMBED), [], `${client} must get no oembed link`)
    assert.deepEqual(linksOf(html, ACTIVITY), [], `${client} must get no activity link`)
  }
})

test('REGRESSION: a Bluesky post keeps its link shape on every client', async () => {
  // The plain head is shared, so the blast radius of touching it is wider than TikTok. Bluesky
  // normalizes its HLS video to kind:'image', so no Bluesky post can reach the video branch at
  // all — on any client, on either head. The stronger whole-document form of this claim is
  // 'BLUESKY IS BYTE-IDENTICAL ACROSS THE CARVE-OUT REMOVAL' above, which pins the exact bytes;
  // this one keeps the per-client link-shape assertion legible on its own.
  for (const client of ['discord', 'other-bot', 'telegram']) {
    const html = await body(render({ kind: 'post', post: base }, client, ORIGIN))
    assert.ok(!html.includes('og:video'), `${client}: Bluesky has no playable video`)
    // discord keeps the spoof (activity + oembed); the others keep neither. Exactly as before.
    assert.equal(linksOf(html, OEMBED).length, client === 'discord' ? 1 : 0, client)
    assert.equal(linksOf(html, ACTIVITY).length, client === 'discord' ? 1 : 0, client)
  }
})

test('theme-color follows ref.p on the SPOOF head — Bluesky blue must not ship on TikTok', async () => {
  const bs = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.match(bs, /theme-color" content="#0085ff"/)
  const tt = await body(render({ kind: 'post', post: ttSlides }, 'discord', ORIGIN))
  // #ff0050 is production fxtiktok's measured value (see the Phase 3b parity baseline).
  assert.match(tt, /theme-color" content="#ff0050"/)
  assert.ok(!tt.includes('#0085ff'))
})

test('THE PLAIN HEAD EMITS theme-color TOO — it had NONE before Phase 3a', async () => {
  // Phase 3a added theme-color to the plain head because the video carve-out made it what a
  // TikTok VIDEO post rendered through on Discord, so a head with no accent colour was shipping
  // the phase's headline post kind. THAT ARGUMENT MOVED when the carve-out was removed
  // (2026-07-19): the Discord video case now belongs to the spoof head, which always had the tag.
  //
  // The line stays, and this test with it, for the client that is still here. 'other-bot' reaches
  // the plain head with a tt post of any shape, and "a head with no accent colour at all" was
  // never a Discord-scoped defect — so deleting the tag as carve-out leftovers would re-open it.
  // Asserted through other-bot precisely because Discord can no longer prove it.
  //
  // property=, not name=: measured on production fxtiktok's own plain-og video head, which is
  // the head Discord renders with #ff0050 today. It also matches the spoof head, so the two
  // heads agree. (fail.ts's errorEmbed keeps name= — recorded, not unified.)
  const ttv = await body(render({ kind: 'post', post: ttVideo }, 'other-bot', ORIGIN))
  assert.match(ttv, /name="theme-color" content="#ff0050"/)
  assert.ok(!ttv.includes('#0085ff'))
  // Genuinely the plain head: it has the player tags and neither callback link.
  assert.match(ttv, /property="og:video"/)
  assert.ok(!ttv.includes('application/activity+json'))

  // And it follows ref.p there too, rather than being a hardcoded pink.
  const bsv = await body(render({ kind: 'post', post: base }, 'other-bot', ORIGIN))
  assert.match(bsv, /name="theme-color" content="#0085ff"/)

  // The Discord half of the same claim, now on the spoof head where a tt VIDEO actually lands.
  const spoofed = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.match(spoofed, /name="theme-color" content="#ff0050"/)
  assert.match(spoofed, /application\/activity\+json/)
})

test('a corrupt ref.p yields a COLOUR on both heads, not a function or an object', async () => {
  // The themeColor() half of mastodon.test.mjs's applicationName guard, and it needs its own
  // test: with the guard mutated to `THEME[...] ?? '#0085ff'` the whole suite stayed green,
  // so nothing was holding it. An uncovered guard is one a later "simplification" deletes.
  //
  // Same hazard both lookups carry: a raw read on an object literal inherits Object.prototype,
  // where 'constructor' is a FUNCTION and '__proto__' is an object — neither undefined, so ??
  // never fires. Interpolating either into a meta tag ships Object's source text, or
  // "[object Object]", into the head as an accent colour.
  //
  // Swept across BOTH heads because they call the same function from two places. THE CLIENT is
  // what selects the head now, not the post kind: until 2026-07-19 a video post on 'discord' was
  // the plain head (that was the carve-out) and a slideshow on 'discord' was the spoof, so both
  // could be reached from one client. With the carve-out gone every 'discord' response is the
  // spoof, and 'other-bot' is the only door left to the plain head — so the sweep asks it directly
  // rather than relying on a post shape to route there.
  for (const p of ['constructor', '__proto__', 'toString', 'nope', 42, null]) {
    for (const [client, post, label] of [
      ['other-bot', ttVideo, 'plain head'],
      ['discord', ttSlides, 'spoof head'],
      ['discord', ttVideo, 'spoof head, video fallback'],
    ]) {
      const html = await body(render({ kind: 'post', post: { ...post, ref: { p, id: '1' } } }, client, ORIGIN))
      // namedOf, not tagsOf: theme-color is spelled name= (see discord.ts — Discord ignores property=).
      const colours = namedOf(html, 'theme-color')
      assert.deepEqual(colours, ['#0085ff'], `${label}, ref.p=${String(p)}`)
    }
  }
})

// ---------------------------------------------------------------------------
// PRODUCTION PARITY FOR THE tt VIDEO HEAD, 2026-07-19.
//
// WHY THIS IS ONE CHANGE AND NOT SIX. Discord kept drawing our VIDEO posts with the OpenGraph
// card (no avatar, counts in the author line in the viewer's system emoji font, NO caption, no
// footer) while drawing our SLIDESHOWS with the activity card (avatar, caption, counts in
// Discord's own artwork, footer). Production fxtiktok gets the activity card for video. Confirmed
// by screenshots in a real Discord client THREE TIMES.
//
// Three single-tag hypotheses were tried and all three failed — most recently "it's twitter:card",
// which was removed from this head and changed nothing. Each attempt costs a full round trip
// through a human with a Discord client, which is a slow oracle to bisect against. So this stops
// bisecting: it reproduces production's head wholesale and lets one human test settle it.
//
// PRODUCTION'S HEAD, captured live from https://megapenispoopenfarten.sex/t/ZTSw2mYwR/ :
//   og:site_name, og:title, theme-color, og:url, og:description
//   twitter:site, twitter:creator, twitter:title          <- all spelled property=, not name=
//   og:video, og:video:type, og:video:width/height, og:type=video.other
//   twitter:player, twitter:player:stream, twitter:player:width/height,
//   twitter:player:stream:content_type                    <- also property=
//   <link ... application/json+oembed>, <link ... application/activity+json>
//   ABSENT: og:image, twitter:card, rel=canonical, og:video:secure_url
//   and the media URL ENDS IN .mp4
//
// TWO DELIBERATE DIVERGENCES, both recorded rather than silently taken:
//   - production emits og:video:type TWICE. That is plainly a bug, and a duplicated tag cannot be
//     what selects a card model, so we emit it once.
//   - we keep the caption in the Mastodon `content`, which production does not. It is a surface
//     that demonstrably works and nothing about parity argues for dropping it.
//
// IF A CLIENT CONFIRMS THIS WORKS, someone may bisect back toward a smaller head — but MUST NOT
// do so speculatively. The whole point of shipping the head whole is that the individual tags
// have not been tested individually and three guesses about them have already been wrong.
// ---------------------------------------------------------------------------

test('PARITY: a tt VIDEO head drops og:video:secure_url, canonical, twitter:card and og:image', async () => {
  // The four ABSENCES, which are the half of the delta that ours had and production's lacked
  // (plus twitter:card and og:image, which were already gone and stay gone).
  const html = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(html, 'og:video:secure_url'), [], 'production emits no og:video:secure_url')
  assert.ok(!html.includes('rel="canonical"'), 'production emits no rel=canonical on a video head')
  assert.deepEqual(namedOf(html, 'twitter:card'), [], 'production emits no twitter:card on a video head')
  assert.deepEqual(tagsOf(html, 'og:image'), [], 'an og:image would outrank the card we want')
  // And the two callback links production DOES ship stay shipped — this is a parity change, not
  // a strip-it-all change, and without these there is no activity card to win in the first place.
  assert.equal(linksOf(html, ACTIVITY).length, 1, 'the activity link is the whole bet')
  assert.equal(linksOf(html, OEMBED).length, 1, 'and production ships the oembed link beside it')
})

test('PARITY: a tt VIDEO head adds the twitter:title/site/creator trio, spelled property=', async () => {
  // Production spells these property= rather than the conventional name=. That looks wrong and is
  // copied deliberately: the point of this change is to stop reasoning about which spelling
  // Discord cares about and reproduce the head that is observed working.
  const html = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(html, 'twitter:title'), ['U (@u)'], 'same value as og:title')
  assert.deepEqual(tagsOf(html, 'og:title'), ['U (@u)'], 'and og:title itself is unchanged')
  assert.deepEqual(tagsOf(html, 'twitter:site'), ['@u'])
  assert.deepEqual(tagsOf(html, 'twitter:creator'), ['@u'])
  // name= spellings would be a DIFFERENT head from the one measured, so pin the absence too.
  assert.deepEqual(namedOf(html, 'twitter:title'), [], 'production does not spell this name=')
  assert.deepEqual(namedOf(html, 'twitter:site'), [])
  assert.deepEqual(namedOf(html, 'twitter:creator'), [])
})

test('PARITY: a tt VIDEO head carries the full twitter:player family', async () => {
  const html = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(html, 'twitter:player:width'), ['720'])
  assert.deepEqual(tagsOf(html, 'twitter:player:height'), ['1280'])
  assert.deepEqual(tagsOf(html, 'twitter:player:stream:content_type'), ['video/mp4'])
  assert.equal(tagsOf(html, 'twitter:player').length, 1)
  assert.equal(tagsOf(html, 'twitter:player:stream').length, 1)
  // og:video:type stays SINGLE. Production emits it twice; see the block comment above.
  assert.deepEqual(tagsOf(html, 'og:video:type'), ['video/mp4'], 'production duplicates this; we do not')
  // The og: side of the player is unchanged by the parity change.
  assert.deepEqual(tagsOf(html, 'og:type'), ['video.other'])
  assert.deepEqual(tagsOf(html, 'og:video:width'), ['720'])
  assert.deepEqual(tagsOf(html, 'og:video:height'), ['1280'])
})

test('PARITY: og:video and both twitter:player URLs are ONE url, on our origin, ending in .mp4', async () => {
  // The suffix delta. Production's media URL ends in '.mp4' and ours ended in a bare '/0'.
  // Asserted as EQUALITY across the three tags rather than three separate patterns: three
  // spellings of one url is how one of them ends up pointing at a different media index.
  const html = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  const [video] = tagsOf(html, 'og:video')
  assert.equal(video, `${ORIGIN}/_media/tt%3A777/0.mp4`)
  assert.deepEqual(tagsOf(html, 'twitter:player'), [video], 'the player must be the same url as og:video')
  assert.deepEqual(tagsOf(html, 'twitter:player:stream'), [video], 'and so must the stream')
  // THE PROJECT CONSTRAINT, re-asserted because this test mints a new url shape.
  assert.ok(!html.includes('aweme/v1/play'), 'a raw CDN url must never reach a client')
  // The suffixed url must actually RESOLVE — a head that advertises a 404 player is worse than
  // one that advertises none. This is the renderer↔router round trip, asserted end to end rather
  // than trusting router.test.mjs to have picked the same spelling.
  const got = route(new URL(video))
  assert.deepEqual(got, { kind: 'media', ref: ttVideo.ref, index: 0 })
})

test('PARITY: media_attachments and the avatar keep the EXTENSIONLESS url', async () => {
  // The suffix is scoped to og:video / twitter:player and nothing else. media_attachments is what
  // actually draws Discord's inline player on the card we want, and it was never part of the
  // delta — changing it would be shipping an untested second change under cover of this one.
  const st = toMastodonStatus(ttVideo, ORIGIN)
  assert.equal(st.media_attachments[0].url, `${ORIGIN}/_media/tt%3A777/0`, 'no suffix here')
  assert.equal(st.account.avatar, `${ORIGIN}/_media/tt%3A777/avatar`)
  // And no image url anywhere gains one either.
  const slides = toMastodonStatus(ttSlides, ORIGIN)
  assert.deepEqual(slides.media_attachments.map(a => a.url), [0, 1, 2].map(i => `${ORIGIN}/_media/tt%3A778/${i}`))
})

test('PARITY MUST-NOT-BREAK: the tt SLIDESHOW head is untouched — canonical, twitter:card, activity', async () => {
  // Slideshows ALREADY get the activity card. They are the control in every screenshot that
  // established the defect, so a parity change that moved them would destroy its own evidence.
  const html = await body(render({ kind: 'post', post: ttSlides }, 'discord', ORIGIN))
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.tiktok\.com\/@u\/photo\/778"\/>/, 'keeps canonical')
  assert.deepEqual(namedOf(html, 'twitter:card'), ['summary_large_image'], 'keeps twitter:card')
  assert.equal(linksOf(html, ACTIVITY).length, 1)
  assert.equal(linksOf(html, OEMBED).length, 1)
  assert.deepEqual(tagsOf(html, 'og:image'), [])
  assert.ok(!html.includes('og:video'), 'a slideshow has no video, so none of the parity block applies')
  assert.ok(!html.includes('twitter:player'), 'and no player family either')
  assert.deepEqual(tagsOf(html, 'twitter:title'), [], 'the trio is scoped to the video branch')
  assert.deepEqual(tagsOf(html, 'twitter:site'), [])
  assert.deepEqual(tagsOf(html, 'twitter:creator'), [])
})

test('PARITY MUST-NOT-BREAK: a TEXT-ONLY tt post on discord keeps canonical and twitter:card', async () => {
  // The other non-video branch of the same head. The parity block is gated on a playable video,
  // so everything C1 measured on the no-media branch survives verbatim.
  const html = await body(render({ kind: 'post', post: { ...ttVideo, media: [] } }, 'discord', ORIGIN))
  assert.match(html, /<link rel="canonical"/, 'keeps canonical')
  assert.deepEqual(namedOf(html, 'twitter:card'), ['summary'], 'C1 row 2')
  assert.equal(tagsOf(html, 'og:image').length, 1, 'and the avatar og:image')
  assert.ok(!html.includes('twitter:player'))
})

test('PARITY MUST-NOT-BREAK: telegram and other-bot keep the PLAIN head, verbatim', async () => {
  // The parity change is scoped to the spoof head. The plain head still serves 'other-bot' and
  // telegram.ts still has its own copy, and neither may inherit a Discord-shaped bet: they keep
  // og:video:secure_url, keep the EXTENSIONLESS media url, and gain no player family.
  for (const client of ['other-bot', 'telegram']) {
    const html = await body(render({ kind: 'post', post: ttVideo }, client, ORIGIN))
    assert.deepEqual(tagsOf(html, 'og:video'), [`${ORIGIN}/_media/tt%3A777/0`], `${client}: no .mp4 suffix`)
    assert.deepEqual(tagsOf(html, 'og:video:secure_url'), [`${ORIGIN}/_media/tt%3A777/0`], `${client}: keeps secure_url`)
    assert.ok(!html.includes('twitter:player'), `${client}: gains no player family`)
    assert.deepEqual(tagsOf(html, 'twitter:title'), [], `${client}: gains no twitter:title`)
    assert.deepEqual(tagsOf(html, 'twitter:site'), [], `${client}: gains no twitter:site`)
    assert.deepEqual(linksOf(html, ACTIVITY), [], `${client} must get no activity link`)
    assert.deepEqual(linksOf(html, OEMBED), [], `${client} must get no oembed link`)
  }
  // other-bot keeps twitter:card=player; that is the plain head's own bet and it is untouched.
  const other = await body(render({ kind: 'post', post: ttVideo }, 'other-bot', ORIGIN))
  assert.deepEqual(namedOf(other, 'twitter:card'), ['player'])
})

test('PARITY MUST-NOT-BREAK: an author-less video post degrades rather than shipping "@undefined"', async () => {
  // twitter:site and twitter:creator are the first tags in this head built from author.handle
  // ALONE (og:title composes it with the name and has always been guarded). deserializePost
  // validates ref, canonical and createdAt and NOTHING else, so an author-less record reaches
  // here — the same corrupted-cache path str() exists for throughout this repo.
  const html = await body(render({ kind: 'post', post: { ...ttVideo, author: undefined } }, 'discord', ORIGIN))
  assert.ok(!html.includes('undefined'), `an unguarded author read leaked: ${html}`)
  assert.deepEqual(tagsOf(html, 'twitter:site'), ['@'], 'degrades to the bare marker, never "@undefined"')
  // twitter:title follows og:title through byline(): no handle, no parenthetical. twitter:site is
  // built from the handle ALONE and is deliberately left as the bare '@' — it is a different tag with
  // a different contract, and this test's subject is that neither says "undefined".
  assert.deepEqual(tagsOf(html, 'twitter:title'), [''])
})

// ---------------------------------------------------------------------------
// THE MIXED CAROUSEL — the head half. See test/mastodon.test.mjs for the activity-payload half.
//
// The fixture is duplicated rather than shared, matching what every other fixture in this repo's
// tests does (`base` exists in both files with different values): a test file that imports its
// inputs from a sibling test file fails for reasons that have nothing to do with what it asserts.
// ---------------------------------------------------------------------------

/**
 * Videos at indices 2 and 4 — the shape no platform before Instagram could produce. TikTok's
 * video is always index 0, so "og:video names the first video AT ITS OWN INDEX" was true by
 * accident there and has never actually been tested.
 */
const igMixed = () => ({
  ref: { p: 'ig', kind: 'p', code: 'ABC' },
  canonical: 'https://www.instagram.com/p/ABC/',
  author: { name: 'A', handle: 'a', url: 'https://www.instagram.com/a/' },
  text: 'x', createdAt: new Date('2026-07-01T00:00:00Z'), counts: {}, sensitive: false,
  media: [
    { kind: 'image', url: 'https://cdn/0.jpg', w: 1080, h: 1080 },
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1080, h: 1350 },
    { kind: 'video', url: 'https://cdn/2.mp4', w: 720, h: 1280, poster: 'https://cdn/2.jpg' },
    { kind: 'image', url: 'https://cdn/3.jpg', w: 1080, h: 1080 },
    { kind: 'video', url: 'https://cdn/4.mp4', w: 720, h: 1280, poster: 'https://cdn/4.jpg' },
  ],
})

test('THE HEAD OF A MIXED CAROUSEL: og:video is the FIRST video, at ITS OWN index', async () => {
  // Never exercised. Every video post to date had its video at index 0. Here the first playable
  // video is at index 2, and og:video must name /_media/{key}/2 — coherent with the gallery,
  // which advertises all five.
  const html = await body(render({ kind: 'post', post: igMixed() }, 'discord', ORIGIN))
  // deepEqual against og:video's OWN content attribute, never a substring match over the whole
  // document. spoofVideoTags() builds ONE shared `url` const and interpolates it into og:video,
  // twitter:player AND twitter:player:stream, so an unanchored /\/_media\/…\/2/ is satisfied by
  // any of the three — it pins "some tag somewhere mentions index 2", which is strictly weaker
  // than what this test's name claims. MEASURED: hardcoding ONLY the og:video line to index 0,
  // leaving twitter:player correct, left all 477 tests green while og:video advertised entry
  // 0's JPEG bytes as video/mp4 — Phase 1's documented I-1 defect, which renders a dead player.
  assert.deepEqual(tagsOf(html, 'og:video'), [`${ORIGIN}/_media/ig%3Ap%3AABC/2.mp4`],
    'og:video ITSELF must name the first VIDEO index — one tag, that exact value')
  assert.ok(!html.includes('cdn/'), 'no raw CDN url in the head either')
  // Still the spoof path: the activity link and og:video ship together (measured against
  // production 2026-07-19), and the gallery comes from media_attachments, not from og:image.
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:image'), 'the og:image suppression on a media post is the mechanism')
})

test('theme-color and the platform name follow ref.p for Instagram', async () => {
  // These table rows have existed since Phase 3a as UNVERIFIED placeholders — no ig Post could
  // reach them. This is the first time one can. The VALUE is a human-gate item; that it is
  // wired at all is this test's job.
  const html = await body(render({ kind: 'post', post: igMixed() }, 'discord', ORIGIN))
  assert.match(html, /theme-color" content="#c13584"/)
  assert.ok(!html.includes('#0085ff'), 'Bluesky blue must not ship on Instagram')
  assert.ok(!html.includes('#ff0050'), 'nor TikTok pink')
})

test('a single-image Instagram post takes the same path Bluesky already proved', async () => {
  // The regression guard: adding a platform must not perturb the shape a human already signed off.
  const single = { ...igMixed(), media: [{ kind: 'image', url: 'https://cdn/0.jpg', w: 1080, h: 1080 }] }
  const html = await body(render({ kind: 'post', post: single }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:video'), 'no video entry means no video tags')
})

// ── Task 5: the failure embed titles on a SHARED per-platform DISPLAY_NAME map, so a failed tweet reads
// "Couldn't load this Twitter post", never the code "Couldn't load this x post". The bug was shared:
// index.ts built the title straight from outcome.platform (the CODE), so every platform showed its code.
const failEmbed = (platform) => body(render(
  { kind: 'failure', canonical: platform === 'x' ? 'https://x.com/i/status/1' : null, platform, reason: 'unavailable' },
  'discord', ORIGIN))

test('a Twitter failure embed titles on the NAME "Twitter", never the code "x"', async () => {
  const html = await failEmbed('x')
  assert.match(html, /og:title" content="Couldn't load this Twitter post"/)
  assert.ok(!html.includes('this x post'), 'the CODE must never reach a user')
})

test('the display-name map is SHARED — a TikTok failure says "TikTok", not "tt"', async () => {
  // Pins that the fix is a per-platform map, not a hardcoded 'Twitter' that would leave tt/ig/... on
  // their codes — the very bug this closes.
  assert.match(await failEmbed('tt'), /og:title" content="Couldn't load this TikTok post"/)
})

// ---------------------------------------------------------------------------
// TASK 6 — the Twitter video HEAD is free too. A {p:'x'} video Post is the first to reach the spoof
// head's og:video fallback and THEME.x (#000000). Defined locally rather than shared with
// mastodon.test.mjs because these are separate test modules; it mirrors that file's xVideo() byte
// for byte so the two cannot drift.
// ---------------------------------------------------------------------------
const xVideo = () => ({
  ref: { p: 'x', id: '20' }, canonical: 'https://x.com/jack/status/20',
  author: { name: 'jack', handle: 'jack', url: 'https://x.com/jack' },
  text: 'x', createdAt: new Date('2020-01-01T00:00:00Z'), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: 'https://video.twimg.com/v.mp4', w: 1280, h: 720,
            poster: 'https://pbs.twimg.com/v.jpg' }],
})

test('a Twitter video head: og:video is our origin, theme-color is the x row, no raw CDN', async () => {
  const html = await body(render({ kind: 'post', post: xVideo() }, 'discord', ORIGIN))
  assert.match(html, /property="og:video"/)
  assert.match(html, /\/_media\/x%3A20\/0/, 'og:video must point at OUR origin')
  assert.ok(!html.includes('video.twimg') && !html.includes('pbs.twimg'), 'no raw CDN in the head')
  assert.match(html, /theme-color" content="#000000"/, 'the x theme row, verified reachable')
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:image'), 'og:image suppression on a media post is the mechanism')
})

test('a text-only tweet renders the plain card with no video tags', async () => {
  const text = { ...xVideo(), media: [] }
  const html = await body(render({ kind: 'post', post: text }, 'discord', ORIGIN))
  assert.ok(!html.includes('og:video'))
  assert.match(html, /theme-color" content="#000000"/)
})

// ---------------------------------------------------------------------------
// DIMENSION TAGS. A `<= 0` gate was added here on 2026-07-25 and REVERTED the same day, and these
// tests were rewritten with it — the earlier version asserted dimTags(0,0) === [].
//
// WHY. The evidence was real but FACEBOOK-ONLY: the fb head shipped og:video:width="0" for a video that
// is really 576x1024, because the container's meta call was not REPORTING dimensions it had. That is
// fixed at the source (container _meta_page + normalizeFacebook). Keeping the gate would have silently
// dropped both tags from YouTube (w:0,h:0, "Discord reads the muxed mp4's real dimensions"), Reddit,
// TikTok slideshow covers and every Bluesky/Threads entry with no aspectRatio — all shipped, verified
// heads — i.e. a speculative subtraction from a verified head on evidence from a different platform,
// which discord.ts's spoofVideoTags docstring forbids in as many words. So 0 is passed through, and the
// pinned claim below is finiteness: a corrupted cache record can never ship content="undefined".
// ---------------------------------------------------------------------------

test('dimTags: non-finite pairs emit NOTHING; real pairs and the 0 sentinel emit both', () => {
  assert.deepEqual(dimTags('og:video', NaN, 10), [])
  assert.deepEqual(dimTags('og:video', undefined, undefined), [])
  assert.deepEqual(dimTags('og:video', 576, 1024), [
    '<meta property="og:video:width" content="576"/>',
    '<meta property="og:video:height" content="1024"/>',
  ])
  // 0 IS A LIVE VALUE, not a corruption — youtube/normalize.ts ships it on every video, and Discord
  // reads the muxed mp4's real dimensions. Pinned so a future tidy cannot re-subtract it silently.
  assert.deepEqual(dimTags('og:video', 0, 0), [
    '<meta property="og:video:width" content="0"/>',
    '<meta property="og:video:height" content="0"/>',
  ])
  // The prefix is a parameter, and BOTH consumers matter — a Discord video head emits og:video:* and
  // twitter:player:* from the same numbers.
  assert.deepEqual(dimTags('twitter:player', 576, 1024), [
    '<meta property="twitter:player:width" content="576"/>',
    '<meta property="twitter:player:height" content="1024"/>',
  ])
})

/**
 * A Facebook-shaped Post: the platform whose head measurably shipped the 0x0 lie. Local rather than
 * imported for the same reason xVideo() above is — these are separate test modules.
 */
const fbVideo = (w, h) => ({
  ref: { p: 'fb', kind: 'share', id: 'Fixture03X' },
  canonical: 'https://www.facebook.com/share/v/Fixture03X/',
  author: { name: 'PhillyBanana', handle: 'PhillyBanana', url: 'https://www.facebook.com/61554703834017' },
  text: 'Are you “Disturbed”', createdAt: new Date('2026-07-16T16:14:06Z'), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: 'https://www.facebook.com/share/v/Fixture03X', w, h,
            poster: 'https://scontent.xx.fbcdn.net/thumb.jpg' }],
})

test('an fb head with UNKNOWN dimensions ships the SAME 0 sentinel every other remux platform does', async () => {
  // The pre-g4 container answer (no width/height in the dict) is the only way fb still reaches 0,0, and
  // this asserts it degrades to YouTube's shipped shape rather than to a shape nobody has verified.
  const html = await body(render({ kind: 'post', post: fbVideo(0, 0) }, 'discord', ORIGIN))
  assert.match(html, /property="og:video"/, 'the video itself is still promised')
  assert.deepEqual(tagsOf(html, 'og:video:width'), ['0'])
  assert.deepEqual(tagsOf(html, 'og:video:height'), ['0'])
  assert.deepEqual(tagsOf(html, 'twitter:player:width'), ['0'])
  assert.deepEqual(tagsOf(html, 'twitter:player:height'), ['0'])
})

test('an fb head with REAL dimensions emits all four, and the two prefixes agree', async () => {
  const html = await body(render({ kind: 'post', post: fbVideo(576, 1024) }, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(html, 'og:video:width'), ['576'])
  assert.deepEqual(tagsOf(html, 'og:video:height'), ['1024'])
  // ONE dimTags call per prefix over ONE Media, so a disagreement here means the head grew a second
  // source of truth for the same video's size.
  assert.deepEqual(tagsOf(html, 'twitter:player:width'), tagsOf(html, 'og:video:width'))
  assert.deepEqual(tagsOf(html, 'twitter:player:height'), tagsOf(html, 'og:video:height'))
})

test('THEME-COLOR SHIPS BOTH SPELLINGS WITH ONE VALUE — Discord reads name=', async () => {
  /**
   * THE BUG THIS PINS RAN FOR THE WHOLE LIFE OF THE FEATURE, silently: the tag was present, valid to
   * look at, and never read. Reported as "we cannot colour our cards", diagnosed by comparing live
   * heads with a Discordbot UA against the fixers that DO get coloured stripes:
   *
   *     vxtwitter   <meta content="#1DA1F2" name="theme-color">        -> blue, as observed
   *     lgb45       <meta name="theme-color" content="#F79829">        -> GOLD, as observed
   *                 <meta property="theme-color" content="#6363ff">    -> ignored
   *
   * lgb45 is the proof, and it is a natural experiment nobody had to construct: it is an fxtwitter
   * fork that ships BOTH spellings on ONE head with DIFFERENT values, and Discord draws the name=
   * one. One document, two candidate colours, one winner.
   *
   * theme-color is a standard HTML meta and takes name=; property= is the OGP-flavoured attribute and
   * this is not an og tag. fail.ts got it right from the start, which is why FAILURE cards have been
   * coloured all along while post cards were not — an inconsistency the old comment recorded as
   * deliberate rather than investigating.
   *
   * Swept across BOTH heads discord.ts builds — spoof and plain — because they spell their tags from
   * different code paths and one of them has been missing this tag entirely before. Telegram is NOT
   * swept: telegram.ts builds its own head and emits no theme-color, which is correct (Telegram draws
   * no accent stripe), and asserting otherwise here would pin a behaviour nobody wants.
   */
  for (const client of ['discord', 'other-bot']) {
    for (const post of [ttSlides, ttVideo]) {
      const html = await body(render({ kind: 'post', post }, client, ORIGIN))
      const named = namedOf(html, 'theme-color')
      const propd = tagsOf(html, 'theme-color')
      assert.equal(named.length, 1, `${client}: exactly one name= theme-color`)
      // BOTH ARE SHIPPED — the owner's call, 2026-08-01, for coverage of consumers that copied
      // fxtwitter's spelling. name= is the one Discord reads; property= is the belt.
      assert.equal(propd.length, 1, `${client}: property= ships too, for coverage`)
      // THE ASSERTION THAT ACTUALLY PROTECTS ANYTHING. Two tags naming one value is redundancy; two
      // naming two values is a bug waiting for a consumer to read the other one — which is precisely
      // what lgb45 does (#F79829 by name=, an inherited #6363ff by property=). One themeColor() call
      // feeds both here so this cannot happen, and this line is what keeps it that way.
      assert.deepEqual(named, propd, `${client}: the two spellings must never disagree`)
    }
  }
})
