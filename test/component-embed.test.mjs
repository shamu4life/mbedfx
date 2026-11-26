import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { componentEmbedJson, md, COMPONENT_EMBED_MAX_BYTES } from '../src/render/componentembed.ts'
import { toMastodonStatus } from '../src/render/mastodon.ts'

/**
 * THE COMPONENT-EMBED EXPERIMENT (/_wait/e, 2026-11-26). Discord documented component embeds on
 * 2026-10-05, and nobody has measured what it draws for a head that carries both one and the
 * activity+json link every media card here depends on. These pin what makes one paste of three links
 * a reading: v=0 is production's head with only the activity id changed, v=1 adds exactly one script
 * element, v=2 swaps the activity link for it, the payload obeys every rule Discord's docs state, and
 * none of it reaches a response outside the experiment.
 *
 * No network: the posts are stubs, and fetch throws for the whole file. Every test mints its own post
 * id, so no cache or in-flight map is shared between tests.
 */
globalThis.fetch = async u => { throw new Error(`network touched: ${u}`) }

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const ctx = { waitUntil() {} }
const req = (path, ua) => new Request(`${ORIGIN}${path}`, { headers: ua ? { 'user-agent': ua } : {} })
const fakeCache = () => {
  const m = new Map()
  return {
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}
const fakeEnv = () => {
  const points = []
  return {
    points,
    AE: { writeDataPoint(p) { points.push(p) } },
    ASSETS: { async fetch() { return new Response('asset', { status: 200 }) } },
    TRANSLATE_GOOGLE: 'off',
  }
}

/** An X video post, shaped like /X/status/2102147636702634195 (the smoke check's video) on 2026-11-26. */
const xVideo = id => ({
  ref: { p: 'x', id },
  canonical: `https://x.com/X/status/${id}`,
  author: { name: 'X', handle: 'X', url: 'https://x.com/X', avatar: 'https://pbs.twimg.com/profile_images/1/x.jpg' },
  text: 'timeline. ticker. trade. https://t.co/1ufRfdiYpS',
  createdAt: new Date('2026-09-21T21:27:07Z'),
  media: [{ kind: 'video', url: 'https://video.twimg.com/amplify_video/1/vid/x.mp4', w: 1920, h: 1080, poster: 'https://pbs.twimg.com/1.jpg' }],
  counts: { likes: 14700, replies: 1700, reposts: 2100 },
  sensitive: false,
})
/** A Bluesky post with four captioned images, shaped like /profile/bsky.app/post/3myx7vphq3s2j. */
const bsImages = rkey => ({
  ref: { p: 'bs', handle: 'bsky.app', rkey },
  canonical: `https://bsky.app/profile/bsky.app/post/${rkey}`,
  author: { name: 'Bluesky', handle: 'bsky.app', url: 'https://bsky.app/profile/bsky.app', avatar: 'https://cdn.bsky.app/img/avatar/plain/did/a' },
  text: 'getting our Halloween decorations set up',
  createdAt: new Date('2026-10-30T18:00:00Z'),
  media: [0, 1, 2, 3].map(i => ({ kind: 'image', url: `https://cdn.bsky.app/img/feed_fullsize/plain/did/${i}`, w: 1000, h: 1000, alt: `Gravestone ${i}\n\n"Remember websites?"` })),
  counts: { likes: 3800, replies: 232, reposts: 413 },
  sensitive: false,
})
const depsFor = post => {
  const asked = []
  return { asked, cache: fakeCache(), fetchPost: async ref => { asked.push(ref); return post } }
}
const xPath = id => `/X/status/${id}`
const bsPath = rkey => `/profile/bsky.app/post/${rkey}`

/**
 * DISCORD'S STATED RULES, as a validator. Each line is one sentence of the docs quoted in
 * src/render/componentembed.ts (discord-api-docs at 2d337dbb16). Throws on the first broken rule.
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

test('A COMPONENT EMBED FOR AN X VIDEO AND A BLUESKY GALLERY obeys every rule Discord states, under 3,000 bytes', () => {
  for (const post of [xVideo('2102147636702634001'), bsImages('3ce0000000001')]) {
    const text = componentEmbedJson(post, ORIGIN)
    assert.ok(text, post.canonical)
    const doc = validate(text)
    const nodes = flat(doc)
    const button = nodes.find(n => n.type === 2)
    assert.deepEqual(button, { type: 2, style: 5, label: post.ref.p === 'x' ? 'View on Twitter' : 'View on Bluesky', url: post.canonical },
      'one link button, to the original post, and the paste\'s tell: neither other card draws one')
    assert.equal(nodes.filter(n => n.type === 2).length, 1)
    assert.equal(doc.component.accent_color, post.ref.p === 'x' ? 0x000000 : 0x0085ff, 'the head\'s own theme-color')
    const section = nodes.find(n => n.type === 9)
    assert.equal(section.components[0].content, post.ref.p === 'x' ? '**X** (@X)' : '**Bluesky** (@bsky.app)')
    assert.equal(section.accessory.media.url, `${ORIGIN}/_media/${encodeURIComponent(post.ref.p === 'x' ? `x:${post.ref.id}` : `bs:bsky.app:${post.ref.rkey}`)}/avatar`)
    assert.ok(nodes.some(n => n.type === 10 && n.content === post.text), 'the caption, whole')
    assert.ok(nodes.some(n => n.type === 10 && /^\*\*❤️ /.test(n.content)), 'the counts, bold, as the activity card prints them')
  }
})

test('THE MEDIA URLS ARE ONES MBEDFX ALREADY PUBLISHES: the video as og:video spells it, images as media_attachments do', async () => {
  // The video takes og:video's `.mp4` spelling and not the document's bare `/0`: the docs list the
  // formats as ".mp4, .webm, and .mov", and a url check would otherwise cost the paste its player.
  const x = xVideo('2102147636702634002')
  const head = await (await handle(req(xPath(x.ref.id), DISCORD), fakeEnv(), ctx, depsFor(x))).text()
  const ogVideo = /<meta property="og:video" content="([^"]+)"/.exec(head)[1]
  const xItems = flat(JSON.parse(componentEmbedJson(x, ORIGIN))).find(n => n.type === 12).items
  assert.deepEqual(xItems.map(i => i.media.url), [ogVideo.replace(/&amp;/g, '&')])
  assert.ok(ogVideo.endsWith('/0.mp4'))
  // Images keep the extensionless url: the CDN chooses the format per request, so an extension would
  // be a guess. Exactly the activity document's urls, in its order, with its alt text.
  const bs = bsImages('3ce0000000002')
  const status = toMastodonStatus(bs, ORIGIN, 'videos', 'mbedfx')
  const bsItems = flat(JSON.parse(componentEmbedJson(bs, ORIGIN))).find(n => n.type === 12).items
  assert.deepEqual(bsItems.map(i => i.media.url), status.media_attachments.map(a => a.url))
  assert.deepEqual(bsItems.map(i => i.description), status.media_attachments.map(a => a.description))
})

test('A POST BUILT TO OVERFLOW stays valid and under budget, trimmed alt first, then text, then items', () => {
  // Every field at its worst: a caption that tries to close the script element, twelve pictures with
  // 1024-character alt text, emoji (four UTF-8 bytes each, so .length would under-count), the two
  // line terminators a JSON string may hold but a script must not, and a run of `<>`, the costliest
  // characters there are: `<` is escaped twice, once for markdown and once for the script, and comes
  // out eight bytes long. The text clamp upstream (500 characters) cannot keep that under budget.
  const post = {
    ...bsImages('3ce0000000003'),
    text: '</script><script>alert(1)</script> & <!-- \u2028\u2029 ' + '🦋'.repeat(20) + '<>'.repeat(200) + ' *bold* _it_',
    media: Array.from({ length: 12 }, (_, i) => ({ kind: 'image', url: `https://cdn.bsky.app/img/${i}`, w: 10, h: 10, alt: 'a'.repeat(1024) })),
  }
  const text = componentEmbedJson(post, ORIGIN)
  const doc = validate(text)
  assert.ok(!/[<>&\u2028\u2029]/.test(text), 'no character that could end the script element or a JS line survives unescaped')
  assert.ok(text.includes('\\u003c/script\\u003e'), 'the caption\'s closing tag is still there, as an escape')
  const items = flat(doc).find(n => n.type === 12).items
  assert.equal(items.length, 10, 'ten items, the cap, and none of the twelve past it')
  assert.ok(items.every(i => !('description' in i)), 'alt text went first')
  const caption = flat(doc).find(n => n.type === 10 && n.content.includes('script'))
  assert.ok(caption && caption.content.endsWith('...'), 'then the caption was cut, with the ellipsis the other heads use')
  assert.equal(JSON.parse(text).component.components.length, doc.component.components.length, 'and it still parses as JSON')
  // Still the most that fits: one more character of caption would not.
  assert.ok(new TextEncoder().encode(text).length > COMPONENT_EMBED_MAX_BYTES - 40, 'the cut is tight, not a fixed haircut')
  // Items go last, only once the caption is gone. An author line nothing trims (names are short in
  // practice, but the cache is not validated past ref and date) leaves room for fewer than ten.
  const crowded = validate(componentEmbedJson({ ...post, author: { ...post.author, name: 'n'.repeat(1900) } }, ORIGIN))
  const left = flat(crowded).find(n => n.type === 12).items
  assert.ok(left.length >= 1 && left.length < 10, `some items dropped, not all: ${left.length}`)
  assert.ok(!flat(crowded).some(n => n.type === 10 && n.content.includes('script')), 'and only after the caption went')
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

test('NO AVATAR MEANS A BARE TEXT DISPLAY: a Section without its accessory is invalid', () => {
  const post = { ...xVideo('2102147636702634004'), author: { name: 'X', handle: 'X', url: 'https://x.com/X' } }
  const doc = validate(componentEmbedJson(post, ORIGIN))
  assert.ok(!flat(doc).some(n => n.type === 9 || n.type === 11))
  assert.equal(doc.component.components[0].content, '**X** (@X)')
  // No media means no gallery component at all, since an empty one is invalid.
  const bare = validate(componentEmbedJson({ ...post, media: [] }, ORIGIN))
  assert.ok(!flat(bare).some(n => n.type === 12))
})

test('NO VALID PAYLOAD MEANS NULL, never a payload that breaks a rule', () => {
  for (const canonical of ['', 'javascript:alert(1)', `https://x.com/${'a'.repeat(600)}`]) {
    assert.equal(componentEmbedJson({ ...xVideo('2102147636702634005'), canonical }, ORIGIN), null, `button url ${canonical.slice(0, 30)}`)
  }
  // An author line no trim can shorten (the cache is not validated past ref and date) cannot fit.
  const huge = { ...xVideo('2102147636702634006'), author: { name: 'n'.repeat(3000), handle: 'X' } }
  assert.equal(componentEmbedJson(huge, ORIGIN), null)
})

test('THE ORDINARY HEAD AND DOCUMENT ARE UNTOUCHED: a 1… id never reaches the experiment', async () => {
  const post = xVideo('2102147636702634010')
  const deps = depsFor(post)
  const env = fakeEnv()
  const head = await (await handle(req(xPath(post.ref.id), DISCORD), env, ctx, deps)).text()
  assert.ok(!head.includes('discord:component-embed'), 'production\'s head carries no component embed')
  const sid = /activity\+json" href="[^"]*\/statuses\/(1\d+)"/.exec(head)[1]
  const doc = await handle(req(`/api/v1/statuses/${sid}`, DISCORD), env, ctx, deps)
  assert.equal(await doc.text(), JSON.stringify(toMastodonStatus(post, ORIGIN, 'videos', 'mbedfx')))
  assert.equal(doc.headers.get('cache-control'), null, 'and production\'s document keeps its own headers')
  assert.ok(!env.points.some(p => p.blobs[1].startsWith('wait_')), 'no wait row for an ordinary paste')
})

/** The three heads for one post, beside production's own, each from a fresh cache. */
async function heads(post, path) {
  const direct = await handle(req(path, DISCORD), fakeEnv(), ctx, depsFor(post))
  const production = await direct.text()
  const sid = /activity\+json" href="[^"]*\/statuses\/(1\d+)"/.exec(production)[1]
  const out = { production, sid, type: direct.headers.get('content-type') }
  for (const v of ['0', '1', '2']) {
    const res = await handle(req(`/_wait/e/${v}/t${v}${path}`, DISCORD), fakeEnv(), ctx, depsFor(post))
    assert.equal(res.status, 200, `v=${v}`)
    assert.equal(res.headers.get('cache-control'), 'no-store', 'an experiment result must never be pinned by a response cache')
    assert.equal(res.headers.get('content-type'), out.type)
    out[v] = await res.text()
  }
  return out
}
const SCRIPT = /<script id="discord:component-embed" type="application\/json">([^<]*)<\/script><\/head>/

for (const [name, post, path] of [
  ['X VIDEO', xVideo('2102147636702634020'), xPath('2102147636702634020')],
  ['BLUESKY GALLERY', bsImages('3ce0000000020'), bsPath('3ce0000000020')],
]) {
  test(`WAIT e/{v} HEADS (${name}): each differs from production's head exactly as its variant says`, async () => {
    const h = await heads(post, path)
    const act = `<link rel="alternate" type="application/activity+json" href="${ORIGIN}/users/${post.author.handle}/statuses/${h.sid}"/>`
    assert.ok(h.production.includes(act), 'the fixture head carries the one activity link the variants change')
    // v=0: the id, and nothing else.
    assert.ok(h[0].includes(`/statuses/9700${h.sid}"`), 'the activity id is 9, e=7, 00, then the real id')
    assert.equal(h[0].replace(`/statuses/9700${h.sid}"`, `/statuses/${h.sid}"`), h.production, 'v=0 is production\'s head but for the id')
    assert.ok(h[0].includes(`/_oembed/${h.sid}"`), 'the counts link keeps the real id')
    // v=1: the id, plus one script element right before </head>, holding exactly the builder's payload.
    const s1 = SCRIPT.exec(h[1])
    assert.ok(s1, 'v=1 carries the script, inside the head')
    assert.equal(s1[1], componentEmbedJson(post, ORIGIN))
    validate(s1[1])
    assert.equal(h[1].split('discord:component-embed').length, 2, 'one script, not two')
    assert.equal(h[1].replace(s1[0], '</head>').replace(`/statuses/9701${h.sid}"`, `/statuses/${h.sid}"`), h.production,
      'v=1 is production\'s head but for the id and the script')
    // v=2: the activity link out, the script in, and the oEmbed link kept.
    const s2 = SCRIPT.exec(h[2])
    assert.equal(s2[1], s1[1], 'v=1 and v=2 carry the same payload, so the two cards differ by the activity link alone')
    assert.ok(!h[2].includes('activity+json'), 'v=2 has no activity link')
    assert.ok(h[2].includes(`/_oembed/${h.sid}"`), 'and keeps the oEmbed link')
    assert.equal(h[2].replace(s2[0], '</head>'), h.production.replace(act, ''), 'v=2 is production\'s head but for those two changes')
  })
}

test('WAIT e DOCUMENTS: 9700 and 9701 are today\'s document under the wait id, counted 700 and 701', async () => {
  const post = xVideo('2102147636702634030')
  const deps = depsFor(post)
  const head = await (await handle(req(xPath(post.ref.id), DISCORD), fakeEnv(), ctx, deps)).text()
  const sid = /activity\+json" href="[^"]*\/statuses\/(1\d+)"/.exec(head)[1]
  const direct = await (await handle(req(`/api/v1/statuses/${sid}`, DISCORD), fakeEnv(), ctx, deps)).text()
  const rows = []
  const env = { ...fakeEnv(), AE: { writeDataPoint: r => rows.push(r) } }
  for (const [path, code] of [[`/api/v1/statuses/9700${sid}`, '9700'], [`/api/v1/statuses/9701${sid}`, '9701'], [`/users/X/statuses/9701${sid}`, '9701']]) {
    const res = await handle(req(path, DISCORD), env, ctx, deps)
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get('cache-control'), 'no-store', path)
    assert.equal(res.headers.get('content-type'), 'application/json', path)
    assert.equal(await res.text(), direct.replace(`{"id":"${sid}"`, `{"id":"${code}${sid}"`),
      `${path}: production's document byte for byte, under the id it was fetched as`)
  }
  // REWRITTEN 2026-11-26 (review): blob1 was 'none', as on every other wait surface, so an X paste and a
  // Bluesky paste both wrote an anonymous 701 and the rows could not say which card fetched its
  // document. e's rows now carry the post's platform, read off the real id.
  assert.deepEqual(rows.filter(r => r.blobs[1].startsWith('wait_')).map(r => [r.blobs, r.doubles]), [
    [['x', 'wait_api', 'discord'], [1, 700]],
    [['x', 'wait_api', 'discord'], [1, 701]],
    [['x', 'wait_users', 'discord'], [1, 701]],
  ], 'a 701 row is what says Discord fetched the document beside a component embed, and it names the post\'s platform')
  // v=2 has no document, so 9702 names nothing; 97 with any other pair is not a wait id either.
  for (const bad of [`/api/v1/statuses/9702${sid}`, `/api/v1/statuses/9705${sid}`, `/api/v1/statuses/9710${sid}`]) {
    const e2 = fakeEnv()
    const res = await handle(req(bad, DISCORD), e2, ctx, deps)
    assert.equal(res.status, 404, bad)
    assert.ok(!e2.points.some(p => p.blobs[1].startsWith('wait_')), `${bad} never reached the experiment`)
  }
})

test('WAIT e PASSES A NON-200 THROUGH and refuses a head it cannot mark', async () => {
  const post = xVideo('2102147636702634040')
  const path = xPath(post.ref.id)
  // A human gets production's answer for the path untouched: the redirect to the post.
  for (const v of ['0', '1', '2']) {
    const deps = depsFor(post)
    const human = await handle(req(`/_wait/e/${v}/t${path}`, 'Mozilla/5.0 (Macintosh) Safari/605.1'), fakeEnv(), ctx, deps)
    const plain = await handle(req(path, 'Mozilla/5.0 (Macintosh) Safari/605.1'), fakeEnv(), ctx, deps)
    assert.equal(human.status, 302, `v=${v}`)
    assert.equal(human.headers.get('location'), plain.headers.get('location'))
    assert.equal(deps.asked.length, 0, 'and a human still costs no upstream fetch')
  }
  // A head with nothing to mark is refused rather than served as a second control: Telegram gets
  // the plain og: head, and a failed fetch gets the failure card, and neither has an activity link.
  for (const [ua, deps] of [['TelegramBot (like TwitterBot)', depsFor(post)], [DISCORD, depsFor(null)]]) {
    for (const v of ['0', '1', '2']) {
      const res = await handle(req(`/_wait/e/${v}/t${path}`, ua), fakeEnv(), ctx, deps)
      assert.equal(res.status, 422, `${ua} v=${v}`)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    }
  }
})

test('WAIT e GUARDS: only an X or Bluesky post re-enters, and the target never leaves our origin', async () => {
  const post = xVideo('2102147636702634050')
  const path = xPath(post.ref.id)
  // Refused BEFORE re-entry: this route reads a 200 into memory, so a /_media/ tail would buffer a
  // video, and a /_wait/ tail would nest experiments. A gallery mode moves the sentinel off 1, and a
  // `.mp4` tail answers with the file itself.
  for (const tail of ['/NASA/posts/1600685561426814', '/@user/video/7660566211100511518', '/watch?v=dQw4w9WgXcQ',
    '/p/DaQ5CPTki4E', '/r/pics/comments/abc123/title', `/_media/x%3A${post.ref.id}/0`, `/_wait/e/0/t${path}`,
    '/_wait/a/60/dQw4w9WgXcQ', `${path}/p`, `${path}.mp4`, '/users/X/statuses/97011121116', '/']) {
    const deps = depsFor(post)
    const res = await handle(req(`/_wait/e/1/t${tail}`, DISCORD), fakeEnv(), ctx, deps)
    assert.equal(res.status, 404, tail)
    assert.equal(res.headers.get('cache-control'), 'no-store', tail)
    assert.equal(deps.asked.length, 0, `${tail}: nothing was fetched`)
  }
  // Content, not status: an unmatched path falls through to ordinary routing. What must be true is
  // that no head marked for the experiment comes back.
  for (const bad of [`/_wait/e/3/t${path}`, `/_wait/e/1/${path}`, `/_wait/e/1/${'x'.repeat(25)}${path}`, `/_wait/e/1/t.t${path}`]) {
    const res = await handle(req(bad, DISCORD), fakeEnv(), ctx, depsFor(post))
    const text = await res.text()
    assert.ok(!text.includes('/statuses/970') && !text.includes('discord:component-embed'), `${bad}: v is 0, 1 or 2 and the tag is 1-24 word characters`)
  }
  // A tail spelled `//host/…` stays on OUR origin: the target is concatenated, never resolved as a
  // url relative to the origin, where `//` would name a host and move every link in the head.
  const slashed = await (await handle(req(`/_wait/e/1/t/${path}`, DISCORD), fakeEnv(), ctx, depsFor(post))).text()
  const hosts = [...slashed.matchAll(/(?:href|content)="(https?:\/\/[^"]*)"/g)].map(m => new URL(m[1]).host)
  assert.ok(hosts.includes('staging.megapenispoopenfarten.sex'))
  assert.deepEqual([...new Set(hosts.filter(h => h !== 'x.com'))], ['staging.megapenispoopenfarten.sex'])
})
