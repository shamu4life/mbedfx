import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeReddit } from '../src/platforms/reddit/normalize.ts'
import { redditHtmlToText, redditMarkdownToText, decodeEntities } from '../src/platforms/reddit/body.ts'

/**
 * A REDDIT POST'S BODY, AS THE CARD CARRIES IT. Reported 2026-10-11: r/YouShouldKnow/comments/8xq8ac showed
 * none of its text. Reddit calls that post `multi_media` (an old text post, no picture in it at all), and the
 * normalizer kept a body for type 'text' alone. The fixtures are real embed.reddit.com pages captured that day
 * from a residential IP; a throwaway Cloudflare Worker fetched 8xq8ac, 1x2wg7e, 1x1xajw and 1mizdfz the same
 * day and got the same type and the same rtjson body (or the same absence of one) as these captures.
 */

const page = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const rd = (id) => ({ p: 'rd', sub: '', id })
const embed = (name, id) => normalizeReddit({ source: 'embed', html: page(name) }, rd(id))

test('A MULTI_MEDIA POST KEEPS ITS BODY — the Pyrex report', () => {
  const post = embed('reddit-embed-multimedia.html', '8xq8ac')
  assert.equal(post.title, 'YSK: PYREX and pyrex are not the same thing.')
  assert.ok(post.text.startsWith("Products with the name 'pyrex' (all lowercase)"), post.text.slice(0, 80))
  assert.ok(post.text.includes('TLDR: Look at the Logo, PYREX (All uppercase) is good'), 'the whole body, down to its TLDR')
  assert.equal(post.text.split('\n\n').length, 4, 'four paragraphs, one blank line between each')
})

test("REDDIT'S TEMPLATE WHITESPACE NEVER REACHES THE CARD", () => {
  /**
   * The old extraction kept the page's indentation: production /_api/v1 published `\n    \n\n\n      ` inside
   * a text post's body (2026-10-11), which the card draws as three blank lines per paragraph break, each
   * costing characters out of the body budget.
   */
  for (const [name, id] of [['reddit-embed-multimedia.html', '8xq8ac'], ['reddit-embed-text-list.html', '1x2z546'],
    ['reddit-embed-text-table.html', '1x01w2y'], ['reddit-embed-multimedia-spoiler.html', '1x2om7u']]) {
    const { text } = embed(name, id)
    assert.ok(text.length > 100, `${name}: has a body`)
    assert.doesNotMatch(text, /\n{3,}/, `${name}: never more than one blank line`)
    assert.doesNotMatch(text, /[ \t]+\n|\n[ \t]+(?![•\d])/, `${name}: no indentation or trailing spaces around a break`)
    assert.doesNotMatch(text, / {2,}/, `${name}: no doubled spaces`)
  }
})

test('A <br> IS A LINE BREAK, and a list item gets its own line with its number', () => {
  const { text } = embed('reddit-embed-text-list.html', '1x2z546')
  assert.match(text, /\(not sure prices will go down\)\nPurpose: 1440p Gaming/, 'the <br> between two lines survives as one newline')
  assert.match(text, /\n1\. ASRock B650 Rock ATX/, 'an ordered item starts its own line with its number')
  assert.match(text, /\n8\. 850W PSU/, 'and the numbering runs through the list')
})

test('A BULLETED LIST READS AS BULLETS, its bold labels as plain text', () => {
  const { text } = embed('reddit-embed-text-bullets.html', '1x2zjml')
  assert.match(text, /\n• MOBO: MSI B550M PRO-VDH WIFI\n• GPU: ASUS TUF RTX 3060 Ti OC/)
})

test('A TABLE READS ROW BY ROW, its cells joined with a bar', () => {
  const { text } = embed('reddit-embed-text-table.html', '1x01w2y')
  assert.match(text, /\nSEP \| 371 \| 153 \| 35\nOCT \| 427 \| 165 \| 22/)
  assert.match(text, /=COUNTIFS\(\$B:\$B,">=9\/1\/2025"/, 'the blockquote and its entities come through as text')
})

test('A SPOILER IS NEVER SHOWN — the card says one is there instead', () => {
  // A card has no click-to-reveal, so the only honest rendering is a marker. Measured markup: rtjson
  // spells it <shreddit-spoiler> (r/anime/comments/1x2om7u), Reddit's feed <span class="md-spoiler-text">.
  const { text } = embed('reddit-embed-multimedia-spoiler.html', '1x2om7u')
  assert.match(text, /Which becomes: \[Hikaru no Go\]\[spoiler\]$/, 'the spoiler element is the marker')
  assert.equal(redditHtmlToText('<p>The killer is <shreddit-spoiler>the butler</shreddit-spoiler>.</p>'), 'The killer is [spoiler].')
  assert.equal(redditHtmlToText('<p>It was <span class="md-spoiler-text">his sled <span>Rosebud</span></span> all along</p>'),
    'It was [spoiler] all along', 'a nested span inside the feed spoiler does not end it early')
})

test("A MULTI_MEDIA POST'S INLINE PICTURE IS ITS MEDIA, and its alt text is not body", () => {
  const post = embed('reddit-embed-multimedia-figure.html', '1x2wg7e')
  assert.deepEqual(post.media, [{ kind: 'image', url: 'https://i.redd.it/6dfrmp25zquh1.png', w: 0, h: 0 }],
    'rebuilt as the clean, unsigned i.redd.it url, like a gallery slide')
  assert.ok(!post.text.includes('Image from r/'), 'the figure title is not body text')
  assert.ok(!post.text.includes('r/DeadlockTheGame - '), 'nor its alt text')
  assert.match(post.text, /and my absolute favorite\.\.\.\n\nGood change or nah\?/, 'the text on both sides of it joins up')
})

test('ENTITIES ARE DECODED EXACTLY ONCE', () => {
  assert.equal(decodeEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;', 'an escaped entity stays an entity')
  assert.equal(decodeEntities('it&#39;s &quot;x&quot; &#x1F600; &hellip;'), 'it\'s "x" 😀 …')
  assert.equal(decodeEntities('&bogus; &#xZZ;'), '&bogus; &#xZZ;', 'an unknown one is left alone')
  assert.equal(redditHtmlToText('<p>a&nbsp;&nbsp;b&#x200B;</p>'), 'a b', 'no-break spaces collapse, zero-width ones go')
})

test('A LINK POST RECORDS WHERE IT POINTS, and carries no media of its own', () => {
  const post = embed('reddit-embed-link-youtube.html', '1mizdfz')
  assert.equal(post.link, 'https://youtu.be/6j7bugx2hvk', 'byte-for-byte the url that was submitted')
  assert.deepEqual(post.media, [], 'the linked media is the worker\'s to compose, under the linked key')
})

test("A REMOVED LINK POST'S OWN PERMALINK IS NEVER A LINK — and neither is any Reddit url", () => {
  // Measured 2026-10-11: a moderator removal rewrites a link post's url to its own permalink plus
  // /removed_by_moderator/ (5 of 42). Delegating that would make the post its own media.
  const html = page('reddit-embed-link-youtube.html').replace(/https:\/\/youtu\.be\/6j7bugx2hvk/g,
    'https://www.reddit.com/r/theydidthemath/comments/1mizdfz/removed_by_moderator/')
  assert.equal(normalizeReddit({ source: 'embed', html }, rd('1mizdfz')).link, undefined)
  for (const url of ['https://v.redd.it/abc', 'https://i.redd.it/x.png', 'https://old.reddit.com/r/a/comments/b/', 'javascript:alert(1)']) {
    const h = page('reddit-embed-link-youtube.html').replace(/https:\/\/youtu\.be\/6j7bugx2hvk/g, url)
    assert.equal(normalizeReddit({ source: 'embed', html: h }, rd('1mizdfz')).link, undefined, url)
  }
})

test('A CROSSPOST OF A LINK CARRIES THE LINK — its url is the parent\'s destination', () => {
  const html = page('reddit-embed-link-youtube.html').replace(/&quot;type&quot;:&quot;link&quot;/, '&quot;type&quot;:&quot;crosspost&quot;')
  assert.notEqual(html, page('reddit-embed-link-youtube.html'), 'precondition: the type was rewritten')
  assert.equal(normalizeReddit({ source: 'embed', html }, rd('1mizdfz')).link, 'https://youtu.be/6j7bugx2hvk')
})

test('MARKDOWN FROM THE ARCHIVE READS LIKE THE RENDERED BODY', () => {
  const md = [
    '# Heading', '', 'Some **bold** and *em* and ~~gone~~ and `code` and [a link](https://x.com/y "t").',
    '', '* one', '* two', '    * nested', '', '1. first', '2) second', '', '> quoted', '',
    'A >!secret!< here.', '', '| a | b |', '|---|:--:|', '| 1 | 2 |', '', '***', '', 'escaped \\*stars\\* and &amp;',
    '', '```', 'let x = 1', '```',
  ].join('\n')
  assert.equal(redditMarkdownToText(md), [
    'Heading', '', 'Some bold and em and gone and code and a link.', '', '• one', '• two', '  • nested', '',
    '1. first', '2. second', '', 'quoted', '', 'A [spoiler] here.', '', 'a | b', '1 | 2', '',
    'escaped *stars* and &', '', 'let x = 1',
  ].join('\n'))
})
