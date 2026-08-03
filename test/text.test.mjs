import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContentHtml, buildPlainText, abbrev } from '../src/render/text.ts'
import { esc } from '../src/render/fail.ts'
import { serializePost, deserializePost } from '../src/cache.ts'

// U+FE00, VARIATION SELECTOR-1. Written as an escape here and never as a literal: it is
// an invisible character, so a literal would be indistinguishable from its own absence in
// a diff, an editor or a careless copy-paste could drop it, and every assertion below
// would still READ as correct while asserting the wrong string. The separator characters
// are the wire format (spec §4, established by codepoint-dumping live FxEmbed output),
// so they get pinned exactly rather than matched loosely.
const VS1 = '\uFE00'
/** Every newline inside user text. TWO variation selectors, unconditionally. */
const BR = `<br>${VS1}${VS1}`
/** A generated structural gap: bare, NO variation selector. The asymmetry is the point. */
const GAP = '<br><br>'

const base = {
  ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
  canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
  text: 'hello',
  createdAt: new Date('2026-07-01T12:00:00Z'),
  media: [],
  counts: {},
  sensitive: false,
}
const quoted = {
  ...base,
  ref: { p: 'bs', handle: 'bob.bsky.social', rkey: '3q9z' },
  canonical: 'https://bsky.app/profile/bob.bsky.social/post/3q9z',
  author: { name: 'Bob', handle: 'bob.bsky.social', url: 'https://bsky.app/profile/bob.bsky.social' },
  text: 'quoted text',
}
const parent = {
  ...base,
  ref: { p: 'bs', handle: 'carol.bsky.social', rkey: '3p1p' },
  canonical: 'https://bsky.app/profile/carol.bsky.social/post/3p1p',
  author: { name: 'Carol', handle: 'carol.bsky.social', url: 'https://bsky.app/profile/carol.bsky.social' },
  text: 'parent text',
}

test('every newline becomes <br> plus TWO variation selectors', () => {
  // Spec §4 overturns the plan, which said to insert a hair space between *consecutive*
  // <br> only. FxEmbed appends two U+FE00 after EVERY newline-derived <br>, conditioned
  // on nothing. U+FE00 is invisible and non-whitespace, which is exactly why it works:
  // a blank line built this way cannot be trimmed or collapsed by Discord.
  const p = { ...base, text: 'a\nb\n\nc' }
  assert.equal(buildContentHtml(p), `a${BR}b${BR}${BR}c`)
})

test('a user blank line is distinguishable from a generated gap — no bare <br><br> from text', () => {
  // The whole reason the two separators differ. If text newlines emitted bare <br><br>,
  // nothing downstream (or in review) could tell a user's blank line apart from the gap
  // the builder inserts before a quote or the counts block. Assert the property directly,
  // not just the byte string, so a "simplification" that drops the selectors is caught.
  const html = buildContentHtml({ ...base, text: 'a\n\nb' })
  assert.ok(!html.includes(GAP), `user text must never produce a bare <br><br>: ${JSON.stringify(html)}`)
})

test('\\r\\n and a lone \\r are newlines too, not literal control bytes', () => {
  // A stray \r that survived into `content` would sit inside a JSON string as a real
  // carriage return: Discord renders no break for it, so two lines silently run together
  // while the payload still looks plausible. Normalize at the one place that knows.
  assert.equal(buildContentHtml({ ...base, text: 'a\r\nb' }), `a${BR}b`)
  assert.equal(buildContentHtml({ ...base, text: 'a\rb' }), `a${BR}b`)
  assert.ok(!buildContentHtml({ ...base, text: 'a\r\nb' }).includes('\r'))
})

test('structural gaps before the quote and before the counts are bare <br><br>', () => {
  const p = { ...base, text: 'line1\n\nline2', quote: quoted, counts: { likes: 3 } }
  const html = buildContentHtml(p)
  assert.ok(html.includes(`line2${GAP}<blockquote>`), `gap before quote must be bare: ${JSON.stringify(html)}`)
  assert.ok(html.includes(`</blockquote>${GAP}<b>`), `gap before counts must be bare: ${JSON.stringify(html)}`)
})

test('the quote internal separator carries EXACTLY ONE variation selector', () => {
  // Verified asymmetry (spec §6e): two selectors inside user text, one inside the quote
  // head/body separator, zero in a structural gap. A copy-paste of the text separator
  // into the quote builder is the easy mistake; this pins the difference.
  // The fixture carries a blank line in the POST text on purpose. A blank line renders as
  // `<br>︀︀<br>︀︀`, so a bare `!html.includes('<br>'+VS1+VS1+'<br>')` would flag it as a
  // wrong quote separator — a red test with no defect behind it. Anchoring the negative on
  // `</b>` scopes it to the boundary actually under test.
  const html = buildContentHtml({ ...base, text: 'a\n\nb', quote: quoted })
  assert.ok(html.includes(`</b><br>${VS1}<br>quoted text`), `quote separator wrong: ${JSON.stringify(html)}`)
  assert.ok(!html.includes(`</b><br>${VS1}${VS1}<br>`), 'the quote separator must not use the text-break pair')
})

test('composition order is reply prefix, text, quote, counts', () => {
  const html = buildContentHtml({ ...base, replyTo: parent, quote: quoted, counts: { likes: 3 } })
  const at = [html.indexOf('<sub>'), html.indexOf('hello'), html.indexOf('<blockquote>'), html.indexOf('&ensp;')]
  assert.ok(at.every(i => i >= 0), `every part must be present: ${JSON.stringify(html)}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, `wrong order: ${JSON.stringify(html)}`)
})

test('the reply prefix ends in a plain <br> — structural, no variation selector', () => {
  const html = buildContentHtml({ ...base, replyTo: parent })
  assert.ok(
    html.includes('<sub>↩ <a href="https://bsky.app/profile/carol.bsky.social" class="u-url mention">Carol (@carol.bsky.social)</a></sub><br>hello'),
    `reply prefix wrong: ${JSON.stringify(html)}`,
  )
})

test('the counts block joins with &ensp; AND carries a trailing &ensp;', () => {
  // The trailing separator is not a typo in the spec — it is in the live FxEmbed output.
  // Dropping it is invisible locally and changes the rendered spacing in a real client.
  const html = buildContentHtml({ ...base, text: '', counts: { replies: 5, reposts: 14, likes: 140 } })
  assert.equal(html, '<b>\u2764\uFE0F 140&ensp;\u{1f4ac} 5&ensp;\u{1f501} 14&ensp;</b>')
})

test('the heart keeps its U+FE0F — without it the glyph renders as monochrome text', () => {
  // ❤ alone is the text-presentation black heart. The trailing VS16 is invisible and
  // is exactly the kind of character an editor silently eats (the same class of hazard as
  // U+FE00 above), so pin the codepoint pair rather than trusting the source literal.
  const html = buildContentHtml({ ...base, counts: { likes: 1 } })
  assert.ok(html.includes('\u2764\uFE0F'), 'the heart must be the emoji-presentation sequence')
})

test('counts omit any metric that is zero, absent, or not a finite number', () => {
  assert.ok(!buildContentHtml({ ...base, counts: { likes: 0, reposts: 7 } }).includes('❤'), 'zero is omitted')
  const only = buildContentHtml({ ...base, text: '', counts: { reposts: 7 } })
  assert.equal(only, '<b>\u{1f501} 7&ensp;</b>', 'absent metrics leave no gap in the block')
  // A count arrives from JSON, so it can be anything after a cache round trip. NaN would
  // otherwise render "❤️ NaN" straight into a Discord embed.
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, '9']) {
    const html = buildContentHtml({ ...base, text: '', counts: { likes: bad } })
    assert.equal(html, '', `a ${String(bad)} like count must produce no counts block, got ${JSON.stringify(html)}`)
  }
})

test('no surviving metric means NO counts block at all, not an empty <b></b>', () => {
  assert.equal(buildContentHtml({ ...base, counts: {} }), 'hello')
  assert.equal(buildContentHtml({ ...base, counts: { likes: 0, reposts: 0, replies: 0 } }), 'hello')
  assert.ok(!buildContentHtml({ ...base, counts: {} }).includes('<b>'))
})

test('views are never rendered — only likes, replies and reposts', () => {
  // Post.counts carries `views`, but the verified FxEmbed counts block has three slots.
  // Adding a fourth here would silently diverge from the format the spec pinned.
  assert.equal(buildContentHtml({ ...base, counts: { views: 9999 } }), 'hello')
})

test('abbrev switches to K at 1000 and M at a million, truncating rather than rounding', () => {
  assert.equal(abbrev(0), '0')
  assert.equal(abbrev(999), '999')
  assert.equal(abbrev(1000), '1K')
  assert.equal(abbrev(1100), '1.1K')
  assert.equal(abbrev(1999), '1.9K')
  assert.equal(abbrev(8100), '8.1K')
  assert.equal(abbrev(999999), '999.9K')
  assert.equal(abbrev(1000000), '1M')
  assert.equal(abbrev(1100000), '1.1M')
  assert.equal(abbrev(12345678), '12.3M')
  // The reason truncation was chosen over rounding: rounding 999_950/1000 gives 1000.0,
  // which renders the nonsense "1000K" for a number that is not yet a million. Truncation
  // has no such boundary — it can never carry a value up into the next tier's range.
  assert.equal(abbrev(999950), '999.9K')
})

test('counts are abbreviated inside the block, not printed raw', () => {
  const html = buildContentHtml({ ...base, text: '', counts: { likes: 1100 } })
  assert.equal(html, '<b>\u2764\uFE0F 1.1K&ensp;</b>')
})

test('an absent part leaves no stray separator', () => {
  // Empty text with a quote must not open with a gap, and a quote with no text must not
  // carry its internal separator — both are the "join a list that has holes in it" bug.
  assert.equal(
    buildContentHtml({ ...base, text: '', quote: quoted }),
    `<blockquote><b><a href="https://bsky.app/profile/bob.bsky.social/post/3q9z">Quoting</a> Bob (<a href="https://bsky.app/profile/bob.bsky.social">@bob.bsky.social</a>)</b><br>${VS1}<br>quoted text</blockquote>`,
  )
  const emptyQuote = buildContentHtml({ ...base, text: '', quote: { ...quoted, text: '' } })
  assert.ok(!emptyQuote.includes('<br>'), `a textless quote needs no separator: ${JSON.stringify(emptyQuote)}`)
  assert.ok(emptyQuote.endsWith('</b></blockquote>'))
  // A post with nothing at all renders as nothing, never as loose punctuation.
  assert.equal(buildContentHtml({ ...base, text: '' }), '')
})

test('an empty-text REPLY leaves no stacked or dangling structural break', () => {
  // The case the test above is named for but never exercised. An image-only reply and a
  // no-commentary quote-post-as-reply are both ordinary Bluesky posts (normalize.ts accepts
  // any string, including ''), and spec C1 emits the activity for every Discord response,
  // so this shape reaches a client. The defect: the reply prefix used to carry its own
  // trailing <br>, so with no text to absorb it the following part's bare <br><br> stacked
  // on top — THREE breaks where §6e specifies exactly two — and a reply with nothing after
  // it ended on a <br> pointing at nothing.
  const prefix =
    '<sub>↩ <a href="https://bsky.app/profile/carol.bsky.social" class="u-url mention">Carol (@carol.bsky.social)</a></sub>'

  const withQuote = buildContentHtml({ ...base, text: '', replyTo: parent, quote: quoted })
  assert.ok(withQuote.startsWith(`${prefix}${GAP}<blockquote>`), `stacked break before quote: ${JSON.stringify(withQuote)}`)
  const withCounts = buildContentHtml({ ...base, text: '', replyTo: parent, counts: { likes: 3 } })
  assert.ok(withCounts.startsWith(`${prefix}${GAP}<b>`), `stacked break before counts: ${JSON.stringify(withCounts)}`)
  for (const html of [withQuote, withCounts]) {
    assert.ok(!html.includes('<br><br><br>'), `three consecutive breaks: ${JSON.stringify(html)}`)
  }
  // A reply prefix with nothing following it is the whole content — no trailing separator.
  assert.equal(buildContentHtml({ ...base, text: '', replyTo: parent }), prefix)

  // Same shape, same rule, plain-text side: §6f's separators are \n and \n\n, never \n\n\n.
  const plain = buildPlainText({ ...base, text: '', replyTo: parent, quote: quoted })
  assert.equal(plain, '↩ Carol (@carol.bsky.social)\n\nQuoting Bob (@bob.bsky.social)\n\nquoted text')
  assert.equal(buildPlainText({ ...base, text: '', replyTo: parent }), '↩ Carol (@carol.bsky.social)')
})

test('a quote or replyTo with no author degrades to a dropped part, never a throw', () => {
  // Reachability proven through the real guard, not asserted: cache.ts's hasValidIdentity
  // validates ref/canonical/createdAt for the root AND for quote/replyTo, but NOT author —
  // and its own docstring says the guard must be total "regardless of what today's renderer
  // happens to draw". This builder is what activates that path, so it owns the other half.
  const authorless = { ref: quoted.ref, canonical: quoted.canonical, createdAt: quoted.createdAt, text: 'q', media: [], counts: {}, sensitive: false }
  for (const key of ['quote', 'replyTo']) {
    const revived = deserializePost(serializePost({ ...base, [key]: authorless }))
    assert.ok(revived !== null, `the cache guard accepts an authorless ${key}; the renderer must too`)
    let html
    assert.doesNotThrow(() => { html = buildContentHtml(revived) }, `authorless ${key} threw`)
    assert.equal(html, 'hello', `an unrenderable ${key} is dropped, not half-drawn: ${JSON.stringify(html)}`)
    assert.doesNotThrow(() => buildPlainText(revived), `authorless ${key} threw in plain text`)
    assert.equal(buildPlainText(revived), 'hello')
  }
})

test('a non-string text, name, handle or url degrades instead of throwing in esc()', () => {
  // Exactly the reasoning countsHtml already applies to the counts ("counts survive a JSON
  // cache round trip, so this value can be null, a string, or NaN") — the strings survive
  // the same round trip and got no such guard. Each of these reached esc() and threw
  // `s.replace is not a function`, which is a 500 on a route whose contract is to degrade.
  for (const bad of [42, null, undefined, {}, ['a']]) {
    const label = JSON.stringify(bad) ?? 'undefined'
    assert.doesNotThrow(() => buildContentHtml({ ...base, text: bad }), `text ${label}`)
    assert.equal(buildContentHtml({ ...base, text: bad }), '', `a non-string text renders as absent, got text ${label}`)
    assert.doesNotThrow(() => buildPlainText({ ...base, text: bad }), `plain text ${label}`)
    for (const field of ['name', 'handle', 'url']) {
      const q = { ...base, quote: { ...quoted, author: { ...quoted.author, [field]: bad } } }
      const r = { ...base, replyTo: { ...parent, author: { ...parent.author, [field]: bad } } }
      assert.doesNotThrow(() => buildContentHtml(q), `quote author.${field} ${label}`)
      assert.doesNotThrow(() => buildContentHtml(r), `replyTo author.${field} ${label}`)
      assert.doesNotThrow(() => buildPlainText(q), `plain quote author.${field} ${label}`)
      assert.doesNotThrow(() => buildPlainText(r), `plain replyTo author.${field} ${label}`)
    }
    assert.doesNotThrow(() => buildContentHtml({ ...base, quote: { ...quoted, canonical: bad } }), `quote canonical ${label}`)
    assert.doesNotThrow(() => buildContentHtml({ ...base, quote: { ...quoted, text: bad } }), `quote text ${label}`)
  }
})

test('buildPlainText normalizes \\r the same way buildContentHtml does', () => {
  // The HTML side already owns this hazard; og:description is fed by the plain side, so a
  // lone CR survived raw into an attribute value there. Same defect, same fix, one owner.
  const plain = buildPlainText({ ...base, text: 'line one\rline two', quote: { ...quoted, text: 'a\r\nb' } })
  assert.ok(!plain.includes('\r'), `a raw carriage return reached og:description: ${JSON.stringify(plain)}`)
  assert.equal(plain, 'line one\nline two\n\nQuoting Bob (@bob.bsky.social)\n\na\nb')
})

test('attacker-controlled text cannot break out into markup', () => {
  // Post text is attacker-controlled: anyone can post one. buildContentHtml's output is
  // interpolated into a JSON string field, so JSON.stringify escapes nothing HTML-ish —
  // this function is the only escaping boundary that exists on that path.
  const evil = '"><script>alert(1)</script>'
  const html = buildContentHtml({ ...base, text: evil })
  assert.ok(!html.includes('<script'), `script tag survived: ${JSON.stringify(html)}`)
  assert.ok(!html.includes('</script>'))
  assert.equal(html, '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('a quoted post cannot inject markup through its author name, handle or URLs', () => {
  // The quote path is newer than the text path and has FOUR interpolation sites in one
  // template (canonical, name, url, handle) — the easiest place to forget an esc() and the
  // hardest to notice, since a quote is absent from most fixtures.
  const evil = {
    ...quoted,
    canonical: 'https://e.example/"onerror="boom',
    author: {
      name: '<script>alert(1)</script>',
      handle: 'x"onmouseover="boom',
      url: 'https://e.example/"onerror="boom',
    },
    text: '<b>not bold</b>',
  }
  const html = buildContentHtml({ ...base, quote: evil })
  assert.ok(!html.includes('<script'), `script tag survived the quote path: ${JSON.stringify(html)}`)
  // The only legitimate `="` sequences in this output are href= and class=. An injected
  // event handler could only appear if a quote in the raw was left unescaped.
  assert.ok(!/onerror="/.test(html), 'a raw quote in an href would open an attribute')
  assert.ok(!/onmouseover="/.test(html), 'a raw quote in the handle would open an attribute')
  assert.ok(!html.includes('<b>not bold</b>'), 'quoted post text must be escaped too')
  assert.ok(html.includes('&lt;b&gt;not bold&lt;/b&gt;'))
})

test('a replied-to author cannot inject markup either', () => {
  const evil = {
    ...parent,
    author: { name: '"><img src=x>', handle: 'p"onload="boom', url: 'https://e.example/"onload="boom' },
  }
  const html = buildContentHtml({ ...base, replyTo: evil })
  assert.ok(!html.includes('<img'), `img tag survived the reply path: ${JSON.stringify(html)}`)
  assert.ok(!/onload="/.test(html))
})

test('buildPlainText NEVER contains engagement counts', () => {
  // Spec §3 — the actual double-render trap. Counts legitimately live in TWO places
  // (Mastodon `content` and oEmbed `author_name`) because their consumers are disjoint.
  // og:description is NOT disjoint from author_name: the OpenGraph path reads the body
  // from og:description and the author line from author_name, so counts here would render
  // the stats twice in one embed. buildPlainText is the og:description source.
  const p = { ...base, text: 'no digits here', counts: { likes: 1337, reposts: 42, replies: 7 } }
  const plain = buildPlainText(p)
  for (const emoji of ['\u{1f4ac}', '\u{1f501}', '❤']) {
    assert.ok(!plain.includes(emoji), `a counts emoji leaked into og:description: ${JSON.stringify(plain)}`)
  }
  for (const n of ['1337', '1.3K', '42', '7']) {
    assert.ok(!plain.includes(n), `a count value leaked into og:description: ${JSON.stringify(plain)}`)
  }
  assert.ok(!plain.includes('&ensp;'))
  assert.equal(plain, 'no digits here')
})

test('buildPlainText carries reply and quote context in the §6f shape', () => {
  const p = { ...base, replyTo: parent, quote: quoted }
  assert.equal(
    buildPlainText(p),
    '↩ Carol (@carol.bsky.social)\nhello\n\nQuoting Bob (@bob.bsky.social)\n\nquoted text',
  )
})

test('buildPlainText emits no markup and is NOT pre-escaped', () => {
  // Its consumer is `og:description`'s attribute value, and the renderer escapes at that
  // boundary (Phase 1 renderPost does esc(desc)). Escaping here too would double-escape:
  // a post reading `a & b` would render as `a &amp; b` in the embed. So the contract is
  // "plain text in, plain text out" — asserted in both directions.
  const p = { ...base, text: 'a & b <c> "d"' }
  const plain = buildPlainText(p)
  assert.equal(plain, 'a & b <c> "d"', 'must not be pre-escaped — the renderer escapes at the attribute')
  assert.ok(!plain.includes('&amp;'), 'a double-escape would show as &amp; in the embed')
  // And escaping it once, as the renderer does, must be enough to make it inert.
  assert.ok(!esc(buildPlainText({ ...base, text: '"><script>alert(1)</script>' })).includes('<script'))
})

test('the sensitive marker is NOT applied here — the renderer owns it', () => {
  // Phase 1 puts `[sensitive] ` on og:description in renderPost. Adding it here as well
  // would render it twice; adding it here INSTEAD would silently drop it from the
  // non-spoof path that still builds its description from post.text.
  assert.ok(!buildPlainText({ ...base, sensitive: true }).includes('[sensitive]'))
  assert.ok(!buildContentHtml({ ...base, sensitive: true }).includes('[sensitive]'))
})

test('a deeper-than-guaranteed quote chain does not throw and does not recurse', () => {
  // The normalizer caps depth at 1, so post.quote.quote is always undefined — but this
  // builder is fed from the cache, whose validation (deserializePost) checks identity and
  // dates, NOT depth. A corrupted or future entry must degrade, never 500.
  const deep = { ...base, quote: { ...quoted, quote: { ...quoted, text: 'GRANDCHILD' } } }
  let html
  assert.doesNotThrow(() => { html = buildContentHtml(deep) })
  assert.ok(!html.includes('GRANDCHILD'), 'depth 2 is dropped, not rendered')
  assert.doesNotThrow(() => buildPlainText(deep))
  assert.ok(!buildPlainText(deep).includes('GRANDCHILD'))
})

/* ===================== THE BODY CAP =====================
 *
 * Requested 2026-08-03: "cap descriptions at 253 characters with the last three being ...".
 *
 * Measured first, because the instinct needed checking: across the captured fixtures the median
 * caption is 81 characters and two thirds are under 200 — Twitter, Instagram and Bluesky were never
 * the problem. The long-form platforms are: Lemmy's median fixture is 3,239 characters, PieFed's
 * 1,228. Those are the walls this exists to stop.
 */

const cap = { ref: { p: 'x', kind: 'status', id: '1' }, canonical: 'https://x.com/a/status/1',
  author: { name: 'A', handle: 'a', url: 'https://x.com/a' },
  createdAt: new Date('2026-01-01T00:00:00Z'), counts: {}, sensitive: false, media: [] }

test('A BODY OVER THE CAP IS CUT TO 253 ENDING IN THREE DOTS, on BOTH heads', () => {
  /**
   * Both, or the cap does not exist. A post WITH media is drawn from the Mastodon spoof and one
   * WITHOUT from the plain OpenGraph head, so capping one and not the other caps neither from a
   * reader's side — the oldest lesson in this repo, and the one it has re-learned most often.
   */
  const post = { ...cap, text: 'y'.repeat(4000) }

  const html = buildContentHtml(post)
  const htmlRun = (html.match(/y+/) || [''])[0]
  assert.ok(htmlRun.length <= 250, `spoof body capped, was ${htmlRun.length}`)
  assert.match(html, /y\.\.\./, 'and marked as cut')

  const plain = buildPlainText(post)
  const plainRun = (plain.match(/y+/) || [''])[0]
  assert.ok(plainRun.length <= 250, `plain body capped, was ${plainRun.length}`)
  assert.match(plain, /y\.\.\./, 'and marked as cut')

  // The whole string is 253: 250 of post plus three dots. Asserted exactly, because "about 250" is
  // how a cap drifts.
  assert.equal(plainRun.length + 3, 253, 'exactly the requested length')
})

test('A BODY UNDER THE CAP IS UNTOUCHED — no dots on a post that fits', () => {
  // Two thirds of real posts are under 200 characters. The cap must be invisible to them, and a
  // trailing "..." on a complete sentence would be a lie about the post having been cut.
  const text = 'z'.repeat(200)
  const post = { ...cap, text }
  assert.ok(buildPlainText(post).includes(text), 'the body survives whole')
  assert.ok(!buildPlainText(post).includes('...'), 'and is not marked as cut')
})

test('A BODY EXACTLY AT THE CAP IS UNTOUCHED — the boundary is inclusive', () => {
  // 253 is a cap, not a threshold to exceed. An off-by-one here would put "..." on a post that fits
  // exactly, which is the same lie as the case above and much harder to notice.
  const text = 'q'.repeat(253)
  assert.ok(buildPlainText({ ...cap, text }).includes(text), 'exactly 253 passes through whole')
  assert.ok(!buildPlainText({ ...cap, text: 'q'.repeat(253) }).includes('...'))
})

test('A CAPPED TRANSLATION KEEPS THE ENGLISH, because translation puts it first', () => {
  /**
   * The consequence of capping AFTER translation, stated as a test so it is a decision rather than
   * an accident. withTranslation composes English, then the marker, then the original — so a
   * translated post long enough to hit the cap loses the ORIGINAL and keeps the English, which is
   * the half a reader of an English-language card actually needs. Reversed, the cap would throw away
   * the only part they can read.
   */
  const english = 'The weather is far too hot today and the barber has opinions about it. '.repeat(4)
  const post = { ...cap, text: `${english}\n\n🌐 Translated from Chinese\n${'中'.repeat(500)}` }
  const plain = buildPlainText(post)
  assert.ok(plain.startsWith('The weather is far too hot'), 'the English survives')
  assert.ok(!plain.includes('中'), 'the original is what gets dropped, not the translation')
  assert.ok(plain.endsWith('...'), 'and it says it was cut')
})
