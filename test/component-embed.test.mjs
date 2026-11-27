import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPONENT_EMBED_MAX_BYTES, GALLERY_CARD_MAX, galleryCardJson, galleryCardScript, md, takesGalleryCard,
} from '../src/render/componentembed.ts'
import { toMastodonStatus } from '../src/render/mastodon.ts'
import { TRANSLATION_MARKER, withTranslation } from '../src/translate.ts'

/**
 * THE GALLERY CARD (src/render/componentembed.ts): a Discord component embed for a post with more than
 * four pictures and no video, built to look like today's activity card.
 *
 * REWRITTEN 2026-11-26, from the tests that pinned the /_wait/e experiment's builder. That builder drew
 * an author Section with the avatar as its Thumbnail, a "View on ..." link button and no footer, and the
 * owner's paste turned that look down (the module docstring has the reading). The schema validator below
 * is unchanged, every payload still goes through it, and the old shape tests are now their opposites: no
 * Section, no Thumbnail, no button, and a footer line. The tests of the experiment's ROUTE went with the
 * route; test/pipeline.test.mjs's WAIT GUARDS hold its ids to a 404, and test/gallery-card.test.mjs
 * holds every head to the goldens rendered before this card existed.
 *
 * No network, and no worker: these call the pure builder.
 */
globalThis.fetch = async u => { throw new Error(`network touched: ${u}`) }

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'
const when = new Date('2026-10-30T18:00:00Z')
const S = Math.floor(when.getTime() / 1000)
const img = (i, extra = {}) => ({ kind: 'image', url: `https://scontent.cdninstagram.com/v/${i}.jpg`, w: 1080, h: 1350, ...extra })

/** An Instagram carousel of `n` pictures. */
const carousel = (n, extra = {}) => ({
  ref: { p: 'ig', kind: 'p', code: 'GaLUnit00001' },
  canonical: 'https://www.instagram.com/p/GaLUnit00001/',
  author: { name: 'Example Gallery', handle: 'example.gallery', url: 'https://www.instagram.com/example.gallery/', avatar: 'https://scontent.cdninstagram.com/v/avatar.jpg' },
  text: 'nine frames from the weekend',
  createdAt: when,
  media: Array.from({ length: n }, (_, i) => img(i, i < 2 ? { alt: `frame ${i + 1}` } : {})),
  counts: { likes: 20900, replies: 82, reposts: 4100 },
  sensitive: false,
  ...extra,
})

/**
 * DISCORD'S STATED RULES, as a validator. Each line is one sentence of the docs quoted in
 * src/render/componentembed.ts (discord-api-docs at 2d337dbb16). Throws on the first broken rule.
 * Unchanged from the experiment's tests: the rules did not move, only the card did.
 */
function validate(text) {
  const bytes = new TextEncoder().encode(text).length
  assert.ok(bytes <= 3000, `3,000-byte limit, escapes at full length: ${bytes}`)
  const doc = JSON.parse(text)
  assert.deepEqual(Object.keys(doc), ['component'], 'a JSON object with a single, parent Container component')
  const c = doc.component
  assert.equal(c.type, 17, 'the parent is a Container')
  let components = 0
  let galleryItems = 0
  let textChars = 0
  const httpUrl = (u, max, what) => {
    assert.equal(typeof u, 'string', what)
    assert.ok(u.length <= max, `${what}: at most ${max} characters`)
    assert.match(u, /^https?:\/\//, `${what}: http or https`)
  }
  const keys = (o, allowed, what) => {
    for (const k of Object.keys(o)) assert.ok(allowed.includes(k), `${what}: unexpected key ${k}`)
  }
  const visit = (n, where) => {
    components += 1
    assert.ok([1, 2, 9, 10, 11, 12, 14, 17].includes(n.type), `${where}: type ${n.type} is not a compatible component`)
    switch (n.type) {
      case 17:
        assert.equal(where, 'root', 'A Container cannot contain another Container component')
        keys(n, ['type', 'id', 'components', 'accent_color', 'spoiler'], 'container')
        if (n.accent_color != null) assert.ok(Number.isInteger(n.accent_color) && n.accent_color >= 0 && n.accent_color <= 0xffffff, 'accent_color is RGB 0x000000 to 0xFFFFFF')
        assert.ok(Array.isArray(n.components) && n.components.length > 0)
        for (const ch of n.components) {
          assert.ok([1, 9, 10, 12, 14].includes(ch.type), `container child type ${ch.type}`)
          visit(ch, 'container')
        }
        break
      case 9:
        keys(n, ['type', 'id', 'components', 'accessory'], 'section')
        assert.ok(n.components.length >= 1 && n.components.length <= 3, 'one to three child components')
        for (const ch of n.components) { assert.equal(ch.type, 10, 'section children are Text Displays'); visit(ch, 'section') }
        assert.ok(n.accessory && [2, 11].includes(n.accessory.type), 'a section has an accessory, a Button or a Thumbnail')
        visit(n.accessory, 'accessory')
        break
      case 10:
        keys(n, ['type', 'id', 'content'], 'text display')
        assert.ok(typeof n.content === 'string' && n.content.length > 0)
        textChars += n.content.length
        break
      case 11:
        keys(n, ['type', 'id', 'media', 'description', 'spoiler'], 'thumbnail')
        assert.equal(where, 'accessory', 'thumbnails are section accessories')
        keys(n.media, ['url'], 'thumbnail media: only url is settable')
        httpUrl(n.media.url, 2048, 'thumbnail url')
        break
      case 12:
        keys(n, ['type', 'id', 'items'], 'media gallery')
        assert.ok(n.items.length >= 1 && n.items.length <= 10, '1 to 10 media gallery items')
        for (const it of n.items) {
          keys(it, ['media', 'description', 'spoiler'], 'gallery item')
          keys(it.media, ['url'], 'gallery media: only url is settable')
          httpUrl(it.media.url, 2048, 'gallery url')
          if (it.description != null) assert.ok(typeof it.description === 'string' && it.description.length <= 1024, 'alt text max 1024')
          galleryItems += 1
        }
        break
      case 1:
        keys(n, ['type', 'id', 'components'], 'action row')
        assert.ok(n.components.length >= 1 && n.components.length <= 5, 'up to 5 buttons')
        for (const ch of n.components) { assert.equal(ch.type, 2); visit(ch, 'row') }
        break
      case 2:
        keys(n, ['id', 'type', 'url', 'style', 'label', 'emoji', 'disabled'], 'button: any other key invalidates the entire payload')
        assert.equal(n.style, 5, 'a button must use the link style')
        assert.ok(n.label || n.emoji, 'with a label, an emoji, or both')
        if (n.label != null) assert.ok(n.label.length <= 80, 'label max 80')
        httpUrl(n.url, 512, 'button url')
        break
      case 14:
        keys(n, ['type', 'id', 'divider', 'spacing'], 'separator')
        break
    }
  }
  visit(c, 'root')
  assert.ok(components <= 40, `up to 40 components, the Container included: ${components}`)
  assert.ok(galleryItems <= 10, 'Media Gallery items are capped at 10 across the entire embed')
  assert.ok(textChars <= 4000, 'text displays total at most 4000 characters')
  return doc
}
const flat = doc => {
  const out = []
  const walk = n => { out.push(n); for (const ch of n.components || []) walk(ch); if (n.accessory) walk(n.accessory) }
  walk(doc.component)
  return out
}

/**
 * TODAY'S CARD'S SHAPE, which is what the owner approved: an author line, the body, the gallery and the
 * footer, in that order, as plain Text Displays around one Media Gallery. Every payload goes through
 * this as well as validate().
 */
function shape(doc) {
  const kinds = doc.component.components.map(n => n.type)
  for (const banned of [1, 2, 9, 11, 14]) {
    assert.ok(!flat(doc).some(n => n.type === banned), `no type ${banned}: no button, no Section, no Thumbnail, no logo`)
  }
  assert.equal(kinds.filter(k => k === 12).length, 1, 'one Media Gallery')
  assert.equal(kinds.at(-1), 10, 'a Text Display closes the card')
  assert.match(doc.component.components.at(-1).content, /^-# /, 'and it is the footer, as subtext')
  assert.equal(kinds.at(-2), 12, 'with the gallery right above it, where the activity card draws its pictures')
  return doc.component.components
}

test('THE GALLERY CARD FOR NINE PICTURES obeys every rule Discord states, and is today\'s card in components', () => {
  const post = carousel(9)
  const text = galleryCardJson(post, ORIGIN, 'mbedfx')
  const doc = validate(text)
  const [who, body, gallery, foot] = shape(doc)
  assert.equal(doc.component.components.length, 4)
  assert.equal(doc.component.accent_color, 0xc13584, 'the head\'s own theme-color for Instagram')
  assert.deepEqual(who, { type: 10, content: '**Example Gallery** (@example.gallery)' }, 'the author line as text, the name in bold as byline() spells it')
  assert.equal(body.content, 'nine frames from the weekend\n\n**❤️ 20.9K\u2002💬 82\u2002🔁 4.1K**',
    'the caption, a blank line, then the counts bold and joined with the en space the activity card uses')
  assert.equal(gallery.items.length, 9, 'all nine, the 3x3 grid')
  assert.equal(foot.content, `-# mbedfx | <t:${S}:d> <t:${S}:t>`,
    'the footer: the site name and the date as Discord timestamps, so it prints in the reader\'s zone')
  assert.equal(galleryCardScript(post, ORIGIN, 'mbedfx'), `<script id="discord:component-embed" type="application/json">${text}</script>`)
})

test('THE PICTURES ARE THE URLS media_attachments ALREADY PUBLISHES, first nine, with their alt text', () => {
  // Extensionless, as media_attachments spells them. The 2026-11-26 paste drew Bluesky's four pictures
  // inside a component embed from exactly this spelling, so no `.jpg` is guessed onto them.
  const post = carousel(12)
  const items = flat(JSON.parse(galleryCardJson(post, ORIGIN, 'mbedfx'))).find(n => n.type === 12).items
  const status = toMastodonStatus(post, ORIGIN, 'videos', 'mbedfx')
  assert.equal(items.length, GALLERY_CARD_MAX)
  assert.deepEqual(items.map(i => i.media.url), status.media_attachments.slice(0, 9).map(a => a.url))
  assert.deepEqual(items.map(i => i.description), status.media_attachments.slice(0, 9).map(a => a.description ?? undefined))
  // A dead entry keeps its index, as everywhere: the pictures after it still name their own bytes.
  const holed = carousel(6, { media: [img(0), null, img(2), img(3), img(4), img(5)] })
  assert.deepEqual(flat(JSON.parse(galleryCardJson(holed, ORIGIN, 'mbedfx'))).find(n => n.type === 12).items.map(i => i.media.url.split('/').pop()),
    ['0', '2', '3', '4', '5'])
})

test('WHO GETS THE GALLERY CARD: more than four plain pictures of the post\'s own, no video, gif or spoiler', () => {
  const yes = [
    ['five pictures', carousel(5)],
    ['nine', carousel(9)],
    ['twenty', carousel(20)],
    ['five usable among a dead entry and an empty url', carousel(7, { media: [img(0), null, img(2), { kind: 'image', url: '' }, img(4), img(5), img(6)] })],
    ['five, sensitive (labelled, not hidden, as today)', carousel(5, { sensitive: true })],
  ]
  const no = [
    ['four pictures: the activity card already holds them', carousel(4)],
    ['four usable and a dead entry', carousel(5, { media: [img(0), null, img(2), img(3), img(4)] })],
    ['five with a video: the card would cost it its poster frame', carousel(5, { media: [img(0), img(1), { kind: 'video', url: 'https://v.example/2.mp4', w: 0, h: 0 }, img(3), img(4)] })],
    ['five with a gif: not pasted in a gallery yet', carousel(5, { media: [img(0), img(1), { kind: 'gif', url: 'https://v.example/2.gif', w: 1, h: 1 }, img(3), img(4)] })],
    ['five where one is a still-muxing video', carousel(5, { media: [img(0), img(1), img(2), img(3), img(4, { posterOnly: true, poster: 'https://v.example/4.jpg' })] })],
    ['five where one is a promised mux', carousel(5, { media: [img(0), img(1), img(2), img(3), img(4, { pendingMux: true })] })],
    ['five, spoiler: its head names no media on purpose', carousel(5, { spoiler: true })],
    ['two of its own and four hoisted from the quote', carousel(2, { quote: carousel(4, { ref: { p: 'ig', kind: 'p', code: 'GaLQuoted0001' } }) })],
    ['no media at all', carousel(0)],
    ['a cache record with no media array', carousel(0, { media: undefined })],
    // REVIEW, 2026-11-26. Six pictures of its own, quoting a post with a video: the activity card hoists
    // that video in as a still and, on /p, says "🎬 Contains video" under the counts. The gallery card
    // shows none of the quote's media, so it would drop that line and make /p and /v the same card.
    ['six quoting a post with a video: the activity card marks it', carousel(6, {
      quote: carousel(0, { ref: { p: 'ig', kind: 'p', code: 'GaLQuoted0002' }, media: [{ kind: 'video', url: 'https://v.example/q.mp4', w: 720, h: 1280, poster: 'https://v.example/q.jpg' }] }),
    })],
    ['six quoting a video whose mux has not landed', carousel(6, {
      quote: carousel(0, { ref: { p: 'ig', kind: 'p', code: 'GaLQuoted0003' }, media: [img(0, { posterOnly: true, poster: 'https://v.example/q.jpg' })] }),
    })],
  ]
  // The quote's pictures and gifs do not stop the card: they are dropped from it at the cost the module
  // docstring accepts, and the activity card marks neither in words.
  yes.push(
    ['six quoting a post with pictures', carousel(6, { quote: carousel(2, { ref: { p: 'ig', kind: 'p', code: 'GaLQuoted0004' } }) })],
    ['six quoting a gif', carousel(6, { quote: carousel(0, { ref: { p: 'ig', kind: 'p', code: 'GaLQuoted0005' }, media: [{ kind: 'gif', url: 'https://v.example/q.gif', w: 1, h: 1 }] }) })],
  )
  for (const [what, post] of yes) {
    assert.equal(takesGalleryCard(post), true, what)
    shape(validate(galleryCardJson(post, ORIGIN, 'mbedfx')))
  }
  for (const [what, post] of no) {
    assert.equal(takesGalleryCard(post), false, what)
    assert.equal(galleryCardJson(post, ORIGIN, 'mbedfx'), null, what)
    assert.equal(galleryCardScript(post, ORIGIN, 'mbedfx'), '', `${what}: nothing goes into the head`)
  }
})

test('A POST BUILT TO OVERFLOW stays valid and under budget, trimmed alt first, then text, never the pictures', () => {
  // Every field at its worst: a caption that tries to close the script element, twelve pictures with
  // 1024-character alt text, emoji (four UTF-8 bytes each, so .length would under-count), the two
  // line terminators a JSON string may hold but a script must not, and a run of `<>`, the costliest
  // characters there are: `<` is escaped twice, once for markdown and once for the script, and comes
  // out eight bytes long. The text clamp upstream (500 characters) cannot keep that under budget.
  const post = carousel(12, {
    text: '</script><script>alert(1)</script> & <!-- \u2028\u2029 ' + '🦋'.repeat(20) + '<>'.repeat(200) + ' *bold* _it_',
    media: Array.from({ length: 12 }, (_, i) => img(i, { alt: 'a'.repeat(1024) })),
  })
  const text = galleryCardJson(post, ORIGIN, 'mbedfx')
  const doc = validate(text)
  shape(doc)
  assert.ok(!/[<>&\u2028\u2029]/.test(text), 'no character that could end the script element or a JS line survives unescaped')
  assert.ok(text.includes('\\u003c/script\\u003e'), 'the caption\'s closing tag is still there, as an escape')
  const items = flat(doc).find(n => n.type === 12).items
  assert.equal(items.length, 9, 'nine pictures, the cap, and none trimmed')
  assert.ok(items.every(i => !('description' in i)), 'alt text went first')
  const body = doc.component.components[1].content
  assert.ok(body.includes('script') && body.includes('...\n\n**❤️'), 'then the caption was cut, with the ellipsis the other heads use, and the counts kept')
  assert.ok(new TextEncoder().encode(text).length > COMPONENT_EMBED_MAX_BYTES - 40, 'the cut is tight, not a fixed haircut')
  // REWRITTEN from the experiment's test, which dropped gallery items last. The gallery card never does:
  // a card that fits only by showing fewer pictures is worse than today's card, so it answers null and
  // the head stays as it was (test/gallery-card.test.mjs has that head against its golden).
  assert.equal(galleryCardJson({ ...post, author: { ...post.author, name: 'n'.repeat(3000) } }, ORIGIN, 'mbedfx'), null)
  // Urls past the schema's 2,048 characters are left out; with four left there is no gallery card.
  const long = carousel(5, { media: [img(0), img(1), img(2), img(3), { kind: 'image', url: 'https://x.example/' + 'a'.repeat(10), w: 1, h: 1 }] })
  assert.ok(galleryCardJson(long, ORIGIN, 'mbedfx'))
  assert.equal(galleryCardJson(long, 'https://' + 'o'.repeat(2048) + '.example', 'mbedfx'), null)
})

test('A CAPTION\'S MARKDOWN IS ESCAPED, so it reads as typed, and its urls are copied untouched', () => {
  assert.equal(md('*not bold* _not it_ ~~no~~ `no` ||no|| [no](x) <@1>'),
    '\\*not bold\\* \\_not it\\_ \\~\\~no\\~\\~ \\`no\\` \\|\\|no\\|\\| \\[no\\](x) \\<@1>')
  assert.equal(md('# not a heading\n-# not subtext\n> not a quote\n- not a list\n1. not a list'),
    '\\# not a heading\n\\-# not subtext\n\\> not a quote\n\\- not a list\n1\\. not a list')
  // Mid-line, these mean nothing to Discord and stay as they are.
  assert.equal(md('a # b - c > d 1. e'), 'a # b - c > d 1. e')
  // A backslash inside a url would end up in the link.
  assert.equal(md('see https://example.com/a_b*c and _x_'), 'see https://example.com/a_b*c and \\_x\\_')
})

test('THE BODY KEEPS THE ACTIVITY CARD\'S ORDER: reply line, bold title, text, the quote as a blockquote, counts', () => {
  const quoted = { ...carousel(0), ref: { p: 'ig', kind: 'p', code: 'GaLQuoted0002' }, author: { name: 'Quoted', handle: 'quoted', url: 'https://q.example' }, text: 'first\n\n> second' }
  const post = carousel(6, {
    title: 'A *title*',
    text: 'the text',
    replyTo: { ...carousel(0), ref: { p: 'ig', kind: 'p', code: 'GaLParent0001' }, author: { name: 'Parent', handle: 'parent', url: 'https://p.example' } },
    quote: quoted,
  })
  const body = JSON.parse(galleryCardJson(post, ORIGIN, 'mbedfx')).component.components[1].content
  assert.equal(body, [
    '-# ↩ Parent (@parent)',
    '**A \\*title\\***',
    '',
    'the text',
    '',
    '> **Quoting Quoted (@quoted)**',
    '> ',
    '> first',
    '> ',
    '> \\> second',
    '',
    '**❤️ 20.9K\u2002💬 82\u2002🔁 4.1K**',
  ].join('\n'), 'the reply as subtext for the <sub> it sits in, and a quoted `>` stays text inside the quote')
  // A record whose reply or quote has no author drops that part, as buildContentHtml does.
  const orphan = JSON.parse(galleryCardJson({ ...post, replyTo: { ...post.replyTo, author: undefined }, quote: { ...quoted, author: null } }, ORIGIN, 'mbedfx'))
  assert.equal(orphan.component.components[1].content, '**A \\*title\\***\n\nthe text\n\n**❤️ 20.9K\u2002💬 82\u2002🔁 4.1K**')
  // No counts, no text: no body component at all, rather than an empty one, which is invalid.
  const bare = validate(galleryCardJson(carousel(5, { text: '', counts: {} }), ORIGIN, 'mbedfx'))
  assert.deepEqual(bare.component.components.map(n => n.type), [10, 12, 10])
})

test('THE [sensitive] LABEL LEADS THE BODY, and no cut can take it', () => {
  const plain = JSON.parse(galleryCardJson(carousel(5, { sensitive: true }), ORIGIN, 'mbedfx')).component.components[1].content
  assert.ok(plain.startsWith('\\[sensitive\\] nine frames'), plain)
  const reply = JSON.parse(galleryCardJson(carousel(5, {
    sensitive: true,
    replyTo: { ...carousel(0), ref: { p: 'ig', kind: 'p', code: 'GaLParent0002' }, author: { name: 'P', handle: 'p', url: 'https://p.example' } },
  }), ORIGIN, 'mbedfx')).component.components[1].content
  assert.ok(reply.startsWith('\\[sensitive\\]\n-# ↩ P (@p)'), 'on its own line when the body opens with the subtext reply line')
  const overflowing = carousel(9, { sensitive: true, text: '<>'.repeat(250), author: { name: 'n'.repeat(1200), handle: 'h' } })
  const cutBody = JSON.parse(galleryCardJson(overflowing, ORIGIN, 'mbedfx')).component.components[1].content
  assert.ok(cutBody.startsWith('\\[sensitive\\] '), 'the label survives the cut')
})

test('THE FOOTER IS TODAY\'S: the site name, then the date in the reader\'s zone, or the name alone when undated', () => {
  const foot = post => JSON.parse(galleryCardJson(post, ORIGIN, 'Embed *Corner*')).component.components.at(-1).content
  assert.equal(foot(carousel(5)), `-# Embed \\*Corner\\* | <t:${S}:d> <t:${S}:t>`, 'SITE_NAME, escaped like any text')
  // An unknown date prints nothing, as the activity card's footer reads just "mbedfx" since 2026-11-25.
  for (const createdAt of [new Date(0), new Date(NaN), undefined, '2026-10-30']) {
    assert.equal(foot(carousel(5, { createdAt })), '-# Embed \\*Corner\\*', String(createdAt))
  }
  assert.equal(JSON.parse(galleryCardJson(carousel(5), ORIGIN, undefined)).component.components.at(-1).content.split(' |')[0], '-# mbedfx',
    'no name configured reads as the default, through siteLabel')
})

test('NO SECTION, NO THUMBNAIL, NO BUTTON: the look the owner turned down cannot come back by accident', () => {
  // REWRITTEN from "NO AVATAR MEANS A BARE TEXT DISPLAY". The experiment's builder put the avatar in a
  // Section Thumbnail whenever there was one, which drew both test posts' platform logos large at the top
  // right, and added a link button. Here the avatar never appears, whatever the post carries.
  for (const post of [carousel(9), carousel(5, { author: { name: 'No Avatar', handle: 'na', url: 'https://n.example' } })]) {
    const text = galleryCardJson(post, ORIGIN, 'mbedfx')
    shape(validate(text))
    assert.ok(!text.includes('/avatar'), 'the avatar is not in the payload at all')
    assert.ok(!text.includes(post.canonical), 'nor a link to the post: the message\'s own link is that')
  }
  // A handle-only or nameless author still gets a valid card.
  assert.equal(JSON.parse(galleryCardJson(carousel(5, { author: { handle: 'only' } }), ORIGIN, 'mbedfx')).component.components[0].content, '**@only**')
  const anon = validate(galleryCardJson(carousel(5, { author: undefined }), ORIGIN, 'mbedfx'))
  assert.deepEqual(anon.component.components.map(n => n.type), [10, 12, 10], 'no author line rather than an empty one')
})

test('A TRANSLATED GALLERY POST SAYS WHAT ITS ACTIVITY DOCUMENT SAYS: the translation and the marker reach the card', () => {
  /**
   * CLAUDE.md's "Discord reads two documents" lesson, for the third surface. The translation bug was a fix
   * that reached one document and not the other. withTranslation writes the translation and its marker
   * into post.text, and the gallery card reads post.text through the same clampText as the activity
   * card's `content`, so both carry them. A marker added only inside mastodon.ts would have reached the
   * activity card and not this one; this pins that it does not work that way.
   */
  const post = withTranslation(carousel(6, { text: '白菜おいしいね' }), 'Chinese cabbage is delicious', 'ja')
  const body = JSON.parse(galleryCardJson(post, ORIGIN, 'mbedfx')).component.components[1].content
  assert.equal(body, `Chinese cabbage is delicious\n\n${TRANSLATION_MARKER} from Japanese\n白菜おいしいね\n\n**❤️ 20.9K 💬 82 🔁 4.1K**`)
  const content = toMastodonStatus(post, ORIGIN, 'videos', 'mbedfx').content
  for (const line of ['Chinese cabbage is delicious', `${TRANSLATION_MARKER} from Japanese`, '白菜おいしいね']) {
    assert.ok(content.includes(line), `the activity document carries "${line}" too`)
  }
})

test('A HEAD STILL WAITING ON ITS TRANSLATION KEEPS TODAY\'S CARD, and the caller says which state it is in', () => {
  /**
   * REVIEW, 2026-11-26. Today's card heals a translation that missed the head's deadline: the activity
   * document Discord fetches next asks again and carries it. The gallery card replaces that document and
   * Discord never fetches it, so a gallery built from a lost race keeps the untranslated caption for
   * good. `pending` is how the caller says where the race stands; test/gallery-card-pending.test.mjs
   * drives the same rule through the worker.
   */
  const ja = carousel(6, { text: '白菜おいしいね' })
  const translated = withTranslation(ja, 'Chinese cabbage is delicious', 'ja')
  const english = carousel(6)
  // Latin text sourceLanguage cannot rule out as foreign (AUTO): Portuguese here, and as often English.
  const auto = carousel(6, { text: 'Seis fotos da viagem à praia, que saudade' })
  const cases = [
    // [what, post, pending, takes the card]
    ['a lost race, Japanese caption', ja, true, false],
    ['a lost race even on an English caption: something else may be arriving', english, true, false],
    ['a translation that landed, then a pending flag anyway', translated, true, false],
    ['settled with no translation: English, a decline, or translation off', ja, false, true],
    ['settled and translated', translated, false, true],
    ['settled on Latin text: the detector has answered, whatever it said', auto, false, true],
    // Left out: the caller never ran the translation (the short-link arm). The caption decides.
    ['never asked, Japanese caption: the activity document would translate it', ja, undefined, false],
    ['never asked, Latin text that may be foreign', auto, undefined, false],
    ['never asked, but the marker is already in the text', translated, undefined, true],
    ['never asked, English caption', english, undefined, true],
  ]
  for (const [what, post, pending, takes] of cases) {
    assert.equal(takesGalleryCard(post, pending), takes, what)
    const json = galleryCardJson(post, ORIGIN, 'mbedfx', pending)
    assert.equal(json !== null, takes, `${what}: the builder agrees`)
    if (takes) shape(validate(json))
    else assert.equal(galleryCardScript(post, ORIGIN, 'mbedfx', pending), '', `${what}: nothing goes into the head`)
  }
})
