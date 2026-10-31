import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { CARD_NOTES, sourceLanguage, splitNotes, TRANSLATION_MARKER, withTranslation } from '../src/translate.ts'
import { IG_AGE_NOTE, IG_NO_VIDEO_NOTE } from '../src/platforms/instagram/normalize.ts'
import { AGE_NOTE, LENGTH_NOTE, LIVE_NOTE } from '../src/platforms/youtube/normalize.ts'
import { normalizeMasto } from '../src/platforms/mastoapi/normalize.ts'
import { normalizeMisskey } from '../src/platforms/misskey/normalize.ts'
import { normalizePeerTube, PEERTUBE_LIVE_NOTE } from '../src/platforms/peertube/normalize.ts'
import { normalizeImgurApi } from '../src/platforms/imgur/normalize.ts'

/**
 * OUR OWN NOTES ARE NOT THE AUTHOR'S WORDS (translate.ts CARD_NOTES, splitNotes).
 *
 * THE DEFECT, found 2026-10-31 on production right after IG_AGE_NOTE deployed: /reel/DfCz_wfx2zp/ had shown
 * "🌐 Translated from Japanese" with no note, and with the note in front it showed no translation at all. The
 * note's English letters diluted the caption's Japanese below FOREIGN_RATIO and looksEnglish then read the
 * note's function words. A review of the fix found the same in YouTube's and PeerTube's live notes, the
 * fediverse boost line and Imgur's overflow count; translate.ts CARD_NOTES has the measurements.
 *
 * CORRECTED THE SAME DAY: the first version of this file said YouTube's AGE_NOTE hid a Japanese title. It
 * cannot: a title is never translated, and an age-gated post's text is the note alone. LIVE_NOTE is the
 * YouTube note that sits ahead of words that are detected, so the first test uses it.
 */

const CAPTION = 'NI HOWDY MY FELLOW TOMODATCHI 🇺🇸🇯🇵 #kpop好きな人と繋がりたい #nihowdy #asian #america #crush'
const NOTED = `${IG_AGE_NOTE}\n\n${CAPTION}`

test('the reported caption reads as Japanese once the note is split off, and did not with the note in front', () => {
  assert.equal(sourceLanguage(CAPTION), 'ja')
  // The defect itself, kept as a fact about the detector: the note must never reach it.
  assert.equal(sourceLanguage(NOTED), null)
  assert.equal(sourceLanguage(splitNotes(NOTED).body), 'ja')
  // YouTube's live note sits ahead of a broadcast's description (withLiveNote, at build time).
  const live = `${LIVE_NOTE}\n\n${CAPTION}`
  assert.equal(sourceLanguage(live), null)
  assert.equal(sourceLanguage(splitNotes(live).body), 'ja', 'and a description behind YouTube\'s live note')
})

/** The normalizers' own lines, run through the normalizers rather than typed out, so a reworded line fails here. */
const fixture = n => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))
const PT = 'Bom dia amigos, tudo bem hoje'

test('a boost line and a live line from the normalizers are lifted off, and the post under them is detected', () => {
  const reblog = fixture('masto-status-reblog.json')
  const masto = normalizeMasto({ ...reblog, reblog: { ...reblog.reblog, content: `<p>${PT}</p>`, spoiler_text: '' } },
    { p: 'ms', host: 'mstdn.social', id: reblog.id })
  assert.match(masto.text, /^🔁 boosted by @/)
  assert.equal(sourceLanguage(masto.text), null, 'the defect: "boosted by" reads as English')
  assert.deepEqual(splitNotes(masto.text).body, PT)
  assert.equal(sourceLanguage(splitNotes(masto.text).body), 'auto')

  const renote = fixture('misskey-note-renote.json')
  const mk = normalizeMisskey({ ...renote, renote: { ...renote.renote, text: PT, cw: null } }, { p: 'mk', host: 'misskey.io', id: renote.id })
  assert.match(mk.text, /^🔁 boosted by @/)
  assert.equal(splitNotes(mk.text).body, PT)

  const video = fixture('peertube-video.json')
  const pt = normalizePeerTube({ ...video, isLive: true, description: CAPTION, channel: null }, { p: 'pt', host: 'framatube.org', id: 'vZNcho9kCoVzc8wZwacPtc' })
  assert.ok(pt.text.startsWith(PEERTUBE_LIVE_NOTE), pt.text)
  assert.equal(splitNotes(pt.text).body, CAPTION)
  assert.equal(sourceLanguage(splitNotes(pt.text).body), 'ja')
})

test("Imgur's overflow count is our line at the END, kept out of the question and kept after the original", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, url: `https://i.imgur.com/i${i}.jpg`, kind: 'image', w: 1, h: 1 }))
  const post = normalizeImgurApi({ id: 'iX265HX', title: 't', description: PT, createdAt: '2026-10-31T00:00:00Z', total: 25, items },
    { p: 'im', kind: 'album', id: 'iX265HX' })
  assert.equal(post.text, `${PT}\n\n+5 more images on Imgur`)
  assert.equal(sourceLanguage(post.text), null, 'the defect: "more" and "on" read as English')
  assert.deepEqual(splitNotes(post.text), { notes: '', body: PT, tail: '+5 more images on Imgur' })
  assert.equal(withTranslation(post, 'Good morning friends, all good today', 'pt').text,
    `Good morning friends, all good today\n\n${TRANSLATION_MARKER} from Portuguese\n${PT}\n\n+5 more images on Imgur`)
})

test('notes are peeled off the front only, stacked ones too, and nothing else is touched', () => {
  assert.deepEqual(splitNotes(NOTED), { notes: IG_AGE_NOTE, body: CAPTION, tail: '' })
  assert.deepEqual(splitNotes(`${AGE_NOTE}\n\n${LENGTH_NOTE}\n\nタイトル`), { notes: `${AGE_NOTE}\n\n${LENGTH_NOTE}`, body: 'タイトル', tail: '' })
  assert.deepEqual(splitNotes(IG_NO_VIDEO_NOTE), { notes: IG_NO_VIDEO_NOTE, body: '', tail: '' }, 'a card that is only its note')
  // A note's words in the middle are text, not a note: only what we prepend is ours.
  const quoted = `someone said: ${IG_AGE_NOTE}`
  assert.deepEqual(splitNotes(quoted), { notes: '', body: quoted, tail: '' })
  assert.deepEqual(splitNotes(`${CAPTION}\n\n${IG_AGE_NOTE}`), { notes: '', body: `${CAPTION}\n\n${IG_AGE_NOTE}`, tail: '' }, 'nor at the end')
  assert.deepEqual(splitNotes(CAPTION), { notes: '', body: CAPTION, tail: '' })
  for (const junk of [null, undefined, 42, {}]) assert.deepEqual(splitNotes(junk), { notes: '', body: '', tail: '' })
})

test('a translated card keeps its note first, above the translation and outside what the marker labels', () => {
  const post = { text: NOTED }
  const out = withTranslation(post, 'I want to connect with people who like K-pop', 'ja')
  assert.equal(out.text,
    `${IG_AGE_NOTE}\n\nI want to connect with people who like K-pop\n\n${TRANSLATION_MARKER} from Japanese\n${CAPTION}`)
  assert.equal(withTranslation(out, 'again', 'ja'), out, 'idempotent: the second seam adds nothing')
  // A post with no note is composed exactly as before this change.
  assert.equal(withTranslation({ text: '白菜おいしいね' }, 'Chinese cabbage is delicious', 'ja').text,
    `Chinese cabbage is delicious\n\n${TRANSLATION_MARKER} from Japanese\n白菜おいしいね`)
})

test('every note a platform normalizer defines is in CARD_NOTES, derived from the source rather than listed by hand', () => {
  // Derived because a note missing from the list fails silently: the card renders, untranslated, with no error.
  const root = new URL('../src/platforms/', import.meta.url)
  const found = []
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    let src
    try { src = readFileSync(new URL(`${dir.name}/normalize.ts`, root), 'utf8') } catch { continue }
    // Either quote, typed or not. A note written inline, as PeerTube's once was, is invisible to this scan:
    // name it as a *_NOTE constant (the review of 2026-10-31 found that one).
    for (const m of src.matchAll(/^(?:export )?const (\w*_NOTE)(?::\s*string)?\s*=\s*(['"])(.+?)\2/gm)) found.push([`${dir.name}:${m[1]}`, m[3]])
  }
  assert.ok(found.length >= 6, `the scan found too few notes to be working: ${JSON.stringify(found)}`)
  for (const [where, text] of found) assert.ok(CARD_NOTES.includes(text), `${where} is not in CARD_NOTES`)
})

/** The render seam, end to end: the model is asked about the caption alone, and the card leads with the note. */
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
function fakeR2() {
  const store = new Map()
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) {
      const v = store.get(k)
      return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null
    },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

/** Each needle present, and in this order. A bare `indexOf(a) < indexOf(b)` passes when `a` is missing (-1). */
function inOrder(text, needles) {
  let from = 0
  for (const n of needles) {
    const at = text.indexOf(n, from)
    assert.ok(at >= 0, `missing or out of order: ${JSON.stringify(n)} in ${JSON.stringify(text)}`)
    from = at + n.length
  }
}

/**
 * REWRITTEN 2026-10-31, before merge. The first version checked the order with a bare indexOf comparison, which
 * a review showed passing with the note deleted, and it rendered a reel with no media, so it never asked for
 * the activity document: the one Discord reads for a reel with a cover, which is what the reported reel has.
 */
test('a noted Instagram reel renders its translation on both documents, note first, and the model never sees the note', async () => {
  // Its own code, so no module-level in-flight map can hand another test's answer to this one.
  const code = 'DfCzNoteXl8'
  const asked = []
  const env = {
    AE: { writeDataPoint() {} },
    ASSETS: { async fetch() { return new Response('a') } },
    MEDIA_CACHE: fakeR2(),
    AI: { async run(_model, input) { asked.push(JSON.stringify(input)); return { response: 'I want to connect with people who like K-pop' } } },
    TRANSLATE_GOOGLE: 'off',
  }
  const deps = {
    cache: fakeCache(),
    fetchPost: async ref => ({
      ref, canonical: `https://www.instagram.com/reel/${code}/`,
      author: { name: 'Jake Sing Chan', handle: 'jakesing_', url: 'https://www.instagram.com/jakesing_/' },
      text: NOTED, createdAt: new Date('2026-10-28T16:00:45Z'), counts: {}, sensitive: true,
      media: [{ kind: 'image', url: `https://scontent.cdninstagram.com/${code}_cover.jpg`, w: 0, h: 0 }],
    }),
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
  }
  const html = await (await handle(new Request(`https://mbedfx.app/reel/${code}/`, { headers: { 'user-agent': DISCORD } }),
    env, { waitUntil() {} }, deps)).text()
  const order = ['Age-restricted on Instagram', 'I want to connect with people who like K-pop', 'Translated from Japanese', 'NI HOWDY MY FELLOW TOMODATCHI']
  const desc = (html.match(/property="og:description" content="([^"]*)"/) || [])[1] ?? ''
  inOrder(desc, order)

  const link = html.match(/activity\+json" href="([^"]+)"/)
  assert.ok(link, 'a reel with a cover advertises the activity document')
  const status = await (await handle(new Request(link[1], { headers: { 'user-agent': DISCORD } }), env, { waitUntil() {} }, deps)).json()
  inOrder(String(status.content), order)

  assert.ok(asked.length >= 1, 'the model was asked')
  for (const a of asked) assert.ok(!a.includes('Age-restricted'), `the note reached the model: ${a}`)
})
