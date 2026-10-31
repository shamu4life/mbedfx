import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { CARD_NOTES, sourceLanguage, splitNotes, TRANSLATION_MARKER, withTranslation } from '../src/translate.ts'
import { IG_AGE_NOTE, IG_NO_VIDEO_NOTE } from '../src/platforms/instagram/normalize.ts'
import { AGE_NOTE, LENGTH_NOTE } from '../src/platforms/youtube/normalize.ts'

/**
 * OUR OWN NOTES ARE NOT THE AUTHOR'S WORDS (translate.ts CARD_NOTES, splitNotes).
 *
 * THE DEFECT, found 2026-10-31 on production right after IG_AGE_NOTE deployed: /reel/DfCz_wfx2zp/ had shown
 * "🌐 Translated from Japanese" with no note, and with the note in front it showed no translation at all. The
 * note's English letters diluted the caption's Japanese below FOREIGN_RATIO and looksEnglish then read the
 * note's function words. Every card note is prepended the same way, so YouTube's AGE_NOTE did it too.
 */

const CAPTION = 'NI HOWDY MY FELLOW TOMODATCHI 🇺🇸🇯🇵 #kpop好きな人と繋がりたい #nihowdy #asian #america #crush'
const NOTED = `${IG_AGE_NOTE}\n\n${CAPTION}`

test('the reported caption reads as Japanese once the note is split off, and did not with the note in front', () => {
  assert.equal(sourceLanguage(CAPTION), 'ja')
  // The defect itself, kept as a fact about the detector: the note must never reach it.
  assert.equal(sourceLanguage(NOTED), null)
  assert.equal(sourceLanguage(splitNotes(NOTED).body), 'ja')
  assert.equal(sourceLanguage(splitNotes(`${AGE_NOTE}\n\n白菜おいしいね、今日の晩ごはん`).body), 'ja', 'and a YouTube title behind its age note')
})

test('notes are peeled off the front only, stacked ones too, and nothing else is touched', () => {
  assert.deepEqual(splitNotes(NOTED), { notes: IG_AGE_NOTE, body: CAPTION })
  assert.deepEqual(splitNotes(`${AGE_NOTE}\n\n${LENGTH_NOTE}\n\nタイトル`), { notes: `${AGE_NOTE}\n\n${LENGTH_NOTE}`, body: 'タイトル' })
  assert.deepEqual(splitNotes(IG_NO_VIDEO_NOTE), { notes: IG_NO_VIDEO_NOTE, body: '' }, 'a card that is only its note')
  // A note's words in the middle are text, not a note: only what we prepend is ours.
  const quoted = `someone said: ${IG_AGE_NOTE}`
  assert.deepEqual(splitNotes(quoted), { notes: '', body: quoted })
  assert.deepEqual(splitNotes(CAPTION), { notes: '', body: CAPTION })
  for (const junk of [null, undefined, 42, {}]) assert.deepEqual(splitNotes(junk), { notes: '', body: '' })
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
    for (const m of src.matchAll(/^(?:export )?const (\w*_NOTE) = '([^']+)'/gm)) found.push([`${dir.name}:${m[1]}`, m[2]])
  }
  assert.ok(found.length >= 5, `the scan found too few notes to be working: ${JSON.stringify(found)}`)
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

test('a noted Instagram reel renders its translation, and the model never sees the note', async () => {
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
      text: NOTED, createdAt: new Date('2026-10-28T16:00:45Z'), counts: {}, sensitive: true, media: [],
    }),
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
  }
  const html = await (await handle(new Request(`https://mbedfx.app/reel/${code}/`, { headers: { 'user-agent': DISCORD } }),
    env, { waitUntil() {} }, deps)).text()
  assert.ok(asked.length >= 1, 'the model was asked')
  for (const a of asked) assert.ok(!a.includes('Age-restricted'), `the note reached the model: ${a}`)
  const desc = (html.match(/property="og:description" content="([^"]*)"/) || [])[1] ?? ''
  assert.match(desc, /Translated from Japanese/, desc)
  assert.ok(desc.indexOf('Age-restricted') < desc.indexOf('I want to connect'), `the note leads: ${desc}`)
})
