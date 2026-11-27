import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { render } from '../src/render/index.ts'
import { route } from '../src/router.ts'
import { galleryCardJson } from '../src/render/componentembed.ts'
import { CASES, DIRECT, ORIGIN, answerOf, directOf } from './fixtures/gallery-card-matrix.mjs'

/**
 * EVERY OTHER POST'S ANSWER IS BYTE FOR BYTE WHAT IT WAS, and a gallery post's is that plus one script.
 *
 * The gallery card (src/render/componentembed.ts) adds a component embed to the Discord head of a post
 * with more than four pictures and no video. The owner approved today's cards and nothing else on
 * 2026-11-26, so the proof that nothing else moved is the point of this file. Each case in
 * test/fixtures/gallery-card-matrix.mjs is rendered with today's code and held to the answer f449bb5
 * gave, which was rendered before any of this existed (test/fixtures/gallery-card-goldens.json):
 *
 *   - a case that does not take the card: status, every header and the body, byte for byte;
 *   - a head that does: the same, once exactly one component-embed script is taken out, and that script
 *     is the last thing in the head and is the builder's payload for the post;
 *   - a /_card answer that does: the same JSON, once `componentGallery: true` is taken out.
 *
 * So for a gallery post every tag of today's head survives, the activity link included, which is the
 * fallback for a client without component embeds.
 */
globalThis.fetch = async u => { throw new Error(`network touched: ${u}`) }

const GOLDEN = JSON.parse(readFileSync('test/fixtures/gallery-card-goldens.json', 'utf8'))
const SCRIPT = /<script id="discord:component-embed" type="application\/json">([^<]*)<\/script>/g

test('THE GOLDENS ARE f449bb5\'S, and every case has one', () => {
  assert.equal(GOLDEN.generatedFrom, 'f449bb5', 'rendered from the commit before the gallery card; never regenerated to pass')
  assert.deepEqual(Object.keys(GOLDEN.cases).sort(), [...CASES, ...DIRECT].map(c => c.name).sort())
  for (const [name, a] of Object.entries(GOLDEN.cases)) {
    assert.ok(!a.body.includes('discord:component-embed'), `${name}: no golden carries a component embed`)
    assert.ok(!a.body.includes('componentGallery'), `${name}: and no /_card golden the flag`)
  }
  // The two cards the owner approved are among them, and stay exactly as approved.
  for (const name of ['bluesky four images (owner-approved card)', 'x video (owner-approved card)']) {
    assert.ok(CASES.some(c => c.name === name && !c.gallery), name)
  }
})

for (const c of CASES) {
  test(`BYTE FOR BYTE (${c.name})${c.gallery ? ' plus the gallery card' : ''}`, async () => {
    const got = await answerOf(handle, c)
    const want = GOLDEN.cases[c.name]
    assert.equal(got.status, want.status)
    assert.deepEqual(got.headers, want.headers, 'every header as it was')
    if (c.kind === 'card') {
      const j = JSON.parse(got.body)
      assert.equal(j.componentGallery, c.gallery ? true : undefined, 'the flag says exactly what the head carries')
      if (c.gallery) {
        assert.equal(Object.keys(j)[1], 'componentGallery', 'beside `direct`, right after ok')
        delete j.componentGallery
        assert.equal(JSON.stringify(j), want.body, 'and nothing else in the preview\'s answer moved')
      } else {
        assert.equal(got.body, want.body)
      }
      return
    }
    const scripts = [...got.body.matchAll(SCRIPT)]
    if (!c.gallery) {
      assert.equal(scripts.length, 0, 'no component embed')
      assert.equal(got.body, want.body)
      return
    }
    assert.equal(scripts.length, 1, 'exactly one component embed')
    assert.ok(got.body.endsWith(`${scripts[0][0]}</head><body></body></html>`), 'the last thing in the head, where the paste put it')
    assert.equal(got.body.replace(scripts[0][0], ''), want.body,
      'today\'s head with the script taken out: every tag, the activity link and the oEmbed link survive')
    const origin = c.origin || ORIGIN
    const ref = route(new URL(origin + c.path)).ref
    // `false`, the head's own answer: renderPostRoute ran the translation step and it settled (translation
    // is off in this env, so nothing is pending). Added 2026-11-26 with the pending rule. Asked with no
    // fourth argument, the builder judges from the caption alone, and "five, marked sensitive" is Latin
    // text sourceLanguage cannot rule out as foreign, so that call would answer null for a head that
    // rightly carries the card.
    assert.equal(scripts[0][1], galleryCardJson(c.make(ref), origin, 'mbedfx', false), 'the builder\'s payload for this post, on this origin')
  })
}

for (const c of DIRECT) {
  test(`BYTE FOR BYTE through render() (${c.name})`, async () => {
    assert.deepEqual(await directOf(render, c), GOLDEN.cases[c.name])
  })
}

test('THE GALLERY CARD NAMES ITS PICTURES ON THE ORIGIN THAT SERVED THE HEAD, a guest host included', async () => {
  const c = CASES.find(x => x.name === 'instagram nine images, guest host')
  const got = await answerOf(handle, c)
  const json = JSON.parse([...got.body.matchAll(SCRIPT)][0][1])
  const urls = json.component.components.find(n => n.type === 12).items.map(i => i.media.url)
  assert.equal(urls.length, 9)
  assert.ok(urls.every(u => u.startsWith('https://guest.example/_media/')), 'guest hosts answer /_media/, so the card is whole there')
  assert.equal(got.headers['x-mbedfx-guest'], 'served')
})
