import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleTranslate, translateBest } from '../src/translate.ts'

/**
 * GOOGLE TRANSLATE AS THE PRIMARY, m2m100 AS THE FALLBACK.
 *
 * WHY, measured 2026-07-31 on the case the owner reported, against both alternatives:
 *
 *     白菜おいしいね
 *       google          "Chinese cabbage is delicious"      <- what he was comparing us to
 *       m2m100-1.2b     "White is delicious."
 *       LibreTranslate  "White rice"
 *
 * The two small MT models fail identically because they are the same class of thing: they split the
 * compound 白菜 rather than reading it as a word. All eight of our other scripts answered through
 * Google, including the four (Korean, Hebrew, Thai, Greek) that m2m100's own catalog does not
 * advertise. It also COSTS NOTHING, which was the constraint — every translation served here is
 * Workers AI neurons not spent.
 *
 * WHAT IT IS: `client=dict-chrome-ex` is the key Google's Dictionary extension uses. An undocumented
 * internal endpoint, not the paid API. Shipped as the owner's informed decision, with a kill switch
 * (Env.TRANSLATE_GOOGLE='off') and a fallback that means a block degrades rather than breaks.
 *
 * EVERY TEST HERE STUBS fetch. The endpoint is live internet, and a suite that reaches it would be
 * both slow and a liar about whether our code works.
 */

const JA = '白菜おいしいね'

/** Swap global fetch for one call, recording what was asked for. */
function withFetch(impl, fn) {
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (u, init) => { seen.push(String(u)); return impl(String(u), init) }
  return Promise.resolve(fn(seen)).finally(() => { globalThis.fetch = real })
}

const ok = body => async () => new Response(body, { status: 200 })

test('IT ASKS THE ENDPOINT THE ISSUE DOCUMENTS, with the extension client key', async () => {
  await withFetch(ok('["Chinese cabbage is delicious"]'), async seen => {
    const got = await googleTranslate(JA, 'ja')
    // An OBJECT since 2026-08-01: the auto path needs the detected language beside the text, and one
    // return shape for both modes is what keeps the caller from having to know which mode it used.
    assert.deepEqual(got, { text: 'Chinese cabbage is delicious', lang: 'ja' })
    assert.equal(seen.length, 1)
    const u = new URL(seen[0])
    assert.equal(u.origin + u.pathname, 'https://clients5.google.com/translate_a/t')
    assert.equal(u.searchParams.get('client'), 'dict-chrome-ex', 'without this it 403s')
    assert.equal(u.searchParams.get('sl'), 'ja')
    assert.equal(u.searchParams.get('tl'), 'en')
    assert.equal(u.searchParams.get('q'), JA)
  })
})

test('THE URL IS STRIPPED BEFORE IT IS SENT, exactly as it is for the model', async () => {
  // Same reason as translate.ts's modelInput: a t.co link is most of a tweet's characters, carries no
  // meaning, and comes back echoed into the translation as though it were a word.
  await withFetch(ok('["Chinese cabbage is delicious"]'), async seen => {
    await googleTranslate('白菜おいしいね https://t.co/TNMl0cLOY0', 'ja')
    assert.equal(new URL(seen[0]).searchParams.get('q'), '白菜おいしいね')
  })
})

test('A DICTIONARY RESPONSE IS NOT A TRANSLATION — assert on shape, never on status', async () => {
  /**
   * THE SAME URL answers with a dictionary OBJECT for a single word, because that is the Chrome
   * extension's actual purpose. A 200 is therefore not an answer, and taking one at face value would
   * put `[object Object]` on a card.
   */
  for (const body of [
    '{"sentences":[{"trans":"hello"}]}',
    '[]',
    '[null]',
    '[42]',
    '[""]',
    '["   "]',
    'not json at all',
    '',
  ]) {
    await withFetch(ok(body), async () => {
      assert.equal(await googleTranslate(JA, 'ja'), null, `${JSON.stringify(body)} is not a translation`)
    })
  }
})

test('A 403 IS SILENCE, NOT A THROW — the endpoint is documented as touchy', async () => {
  for (const status of [403, 429, 500, 302]) {
    await withFetch(async () => new Response('nope', { status }), async () => {
      assert.equal(await googleTranslate(JA, 'ja'), null, `${status} must degrade`)
    })
  }
  // A thrown fetch (blocked egress, DNS failure) is the same answer.
  await withFetch(async () => { throw new TypeError('blocked') }, async () => {
    assert.equal(await googleTranslate(JA, 'ja'), null)
  })
})

test('AN UNCHANGED ANSWER IS A DECLINE', async () => {
  await withFetch(ok(JSON.stringify([JA])), async () => {
    assert.equal(await googleTranslate(JA, 'ja'), null, 'the same characters back is not a translation')
  })
})

test('A HUGE BODY IS REFUSED', async () => {
  await withFetch(ok('["' + 'x'.repeat(70 * 1024) + '"]'), async () => {
    assert.equal(await googleTranslate(JA, 'ja'), null)
  })
})

test('EMPTY OR URL-ONLY TEXT COSTS NO REQUEST AT ALL', async () => {
  await withFetch(ok('["x"]'), async seen => {
    for (const t of ['', '   ', 'https://t.co/abc', '@someone']) {
      assert.equal(await googleTranslate(t, 'ja'), null)
    }
    assert.equal(seen.length, 0, 'nothing worth translating is nothing worth asking about')
  })
})

// ── the fallback, which is the whole safety story ──────────────────────────

test('GOOGLE FIRST, AND THE MODEL IS NOT EVEN ASKED', async () => {
  let aiCalls = 0
  const ai = { run: async () => { aiCalls++; return { response: 'White is delicious.' } } }
  await withFetch(ok('["Chinese cabbage is delicious"]'), async () => {
    const got = await translateBest(JA, 'ja', { ai, google: true })
    assert.deepEqual(got, { text: 'Chinese cabbage is delicious', via: 'google', lang: 'ja' })
    assert.equal(aiCalls, 0, 'a free answer must not also buy neurons')
  })
})

test('A BLOCKED GOOGLE FALLS BACK TO THE MODEL — the card never regresses', async () => {
  /**
   * THE RISK THIS COVERS. Every quality measurement behind the Google path was taken from a
   * residential IP, and this project has twice found an upstream that answers a laptop and refuses
   * Cloudflare's egress. If that happens here, the feature must degrade to what shipped before, not
   * disappear.
   */
  const ai = { run: async () => ({ response: 'White is delicious.' }) }
  await withFetch(async () => new Response('nope', { status: 403 }), async () => {
    const got = await translateBest(JA, 'ja', { ai, google: true })
    assert.deepEqual(got, { text: 'White is delicious.', via: 'ai', lang: 'ja' },
      'weaker, but still a translation')
  })
})

test('THE KILL SWITCH SKIPS GOOGLE ENTIRELY', async () => {
  // Not a feature flag — a lever for turning off an undocumented endpoint in seconds, whether the
  // reason is a 403 wave or a letter. It must cost no request at all, not merely ignore the answer.
  const ai = { run: async () => ({ response: 'White is delicious.' }) }
  await withFetch(ok('["Chinese cabbage is delicious"]'), async seen => {
    const got = await translateBest(JA, 'ja', { ai, google: false })
    assert.equal(got.via, 'ai')
    assert.equal(seen.length, 0, 'google must not be contacted at all')
  })
})

test('BOTH FAILING IS STILL JUST "NO TRANSLATION"', async () => {
  const ai = { run: async () => ({ response: '' }) }
  await withFetch(async () => new Response('', { status: 500 }), async () => {
    assert.equal(await translateBest(JA, 'ja', { ai, google: true }), null)
  })
})

test('NO AI BINDING AT ALL IS FINE — google needs none', async () => {
  // The arrangement is reversed from where this started: Workers AI used to be required, and is now
  // the fallback. A Worker with no AI binding still translates.
  await withFetch(ok('["Chinese cabbage is delicious"]'), async () => {
    const got = await translateBest(JA, 'ja', { ai: undefined, google: true })
    assert.deepEqual(got, { text: 'Chinese cabbage is delicious', via: 'google', lang: 'ja' })
  })
})

test('translateBest IS TOTAL OVER JUNK', async () => {
  await withFetch(async () => { throw new Error('x') }, async () => {
    for (const junk of [undefined, null, 42, {}, []]) {
      assert.equal(await translateBest(junk, 'ja', { ai: undefined, google: true }), null,
        `${String(junk)} must not throw`)
    }
  })
})

/* ===================== THE AUTO PATH — "everything that is not English" ============
 *
 * Added 2026-08-01 at the owner's request. sl=auto answers with BOTH the translation and
 * the detected language — [["text","pt"]] — so one call classifies and translates, and no
 * detection model is needed. Measured live before building it.
 */

test('AUTO RETURNS THE DETECTED LANGUAGE ALONGSIDE THE TEXT', async () => {
  await withFetch(ok('[["Cuica take in soul bossa nova","pt"]]'), async seen => {
    const got = await googleTranslate('Levada de cuica em soul bossa nova', 'auto')
    assert.deepEqual(got, { text: 'Cuica take in soul bossa nova', lang: 'pt' })
    assert.equal(new URL(seen[0]).searchParams.get('sl'), 'auto')
  })
})

test('ENGLISH IS AN ANSWER, NOT A FAILURE — and it is never a translation', async () => {
  /**
   * THE CASE THE WHOLE AUTO PATH EXISTS TO SETTLE. Google is asked about every Latin post the local
   * filter could not rule out; most of them are English, and the answer must be a clean negative
   * rather than a retry — otherwise an English post gets a "🌐 Translated from …" marker, which is
   * the loudest failure this feature has.
   */
  await withFetch(ok('[["Just posted a new video","en"]]'), async () => {
    const got = await googleTranslate('Just posted a new video', 'auto')
    assert.deepEqual(got, { text: '', lang: 'en' }, 'settled, and settled negatively')
  })
})

test('AN ENGLISH VERDICT NEVER FALLS BACK TO THE MODEL', async () => {
  /**
   * The fallback exists to keep a KNOWN-foreign post translated when Google refuses us. On the auto
   * path the post is only SUSPECTED foreign, and a model asked to translate English returns a
   * paraphrase — which would be marked as a translation. So the auto path is Google-only.
   */
  let aiCalls = 0
  const ai = { run: async () => { aiCalls++; return { response: 'a paraphrase of english' } } }
  await withFetch(ok('[["Just posted a new video","en"]]'), async () => {
    const got = await translateBest('Just posted a new video', 'auto', { ai, google: true })
    assert.deepEqual(got, { text: '', via: 'google', lang: 'en' })
    assert.equal(aiCalls, 0, 'the model must never be asked to confirm English')
  })
})

test('A BLOCKED GOOGLE ON THE AUTO PATH ASKS THE MODEL TO NAME THE LANGUAGE, never to translate blind', async () => {
  /**
   * WHY THIS EXISTS AT ALL: Google's sl=auto answers a laptop and gives our Worker NOTHING. Proven
   * not by guessing but by the ABSENCE of a cache record for a post that should have written one,
   * with no exception logged. Without a second pass the whole Latin-script feature is dead in
   * production while passing every test.
   *
   * WHY IT IS SAFE where "let the model translate an unknown post" is not: a model asked to TRANSLATE
   * English returns a fluent paraphrase and nothing marks it wrong. A model asked to NAME a language
   * returns a token we validate against a two-letter shape. The output is checkable.
   *
   * The prompts are asserted, because the whole safety argument rests on which question is asked.
   */
  const seen = []
  const ai = {
    run: async (_m, i) => {
      seen.push(i.messages[0].content)
      return { response: seen.length === 1 ? 'es' : 'Today the weather is very good for a walk' }
    },
  }
  await withFetch(async () => new Response('nope', { status: 429 }), async () => {
    const got = await translateBest('Hoy hace muy buen tiempo para pasear', 'auto', { ai, google: true })
    assert.deepEqual(got, { text: 'Today the weather is very good for a walk', via: 'ai', lang: 'es' })
  })
  assert.match(seen[0], /identify languages/i, 'the FIRST question is detection, not translation')
  assert.match(seen[1], /translation engine/i, 'and only then, with a language in hand, a translation')
})

test('THE MODEL SAYING "en" IS A CLEAN NEGATIVE — no translation, and it is remembered', async () => {
  let calls = 0
  const ai = { run: async () => { calls++; return { response: 'en' } } }
  await withFetch(async () => new Response('nope', { status: 429 }), async () => {
    const got = await translateBest('Just posted a new video about it', 'auto', { ai, google: true })
    assert.deepEqual(got, { text: '', via: 'ai', lang: 'en' }, 'cacheable, so it is asked once ever')
  })
  assert.equal(calls, 1, 'and it is NEVER asked to translate the English it just identified')
})

test('NO AI AND NO GOOGLE ON THE AUTO PATH IS STILL JUST NO TRANSLATION', async () => {
  // The floor: with nothing able to answer, the behaviour is exactly what it was before this path
  // existed. A suspected-foreign post is never guessed at.
  await withFetch(async () => new Response('nope', { status: 429 }), async () => {
    assert.equal(await translateBest('Hoy hace muy buen tiempo para pasear', 'auto', { ai: undefined, google: true }), null)
  })
})

test('A JUNK DETECTION IS REFUSED — a shape check, not a trusted token', async () => {
  for (const said of ['I think it is Spanish maybe', 'xxxxx', '', '42', 'the language is unclear!!']) {
    const ai = { run: async () => ({ response: said }) }
    await withFetch(async () => new Response('nope', { status: 429 }), async () => {
      const got = await translateBest('Hoy hace muy buen tiempo para pasear', 'auto', { ai, google: true })
      // Either refused outright, or narrowed to a real two-letter code it then used. Never a
      // translation attributed to a language the model did not actually name.
      assert.ok(got === null || /^[a-z]{2}$/.test(got.lang), `junk detection must not become a language: ${said}`)
    })
  }
})

test('A KNOWN SCRIPT STILL FALLS BACK — the auto rule must not disarm the old path', async () => {
  // The control. Japanese is KNOWN foreign, so a Google miss must still reach the model exactly as
  // it did before the auto path existed.
  const ai = { run: async () => ({ response: 'White is delicious.' }) }
  await withFetch(async () => new Response('nope', { status: 429 }), async () => {
    const got = await translateBest(JA, 'ja', { ai, google: true })
    assert.deepEqual(got, { text: 'White is delicious.', via: 'ai', lang: 'ja' })
  })
})

test('A JUNK LANGUAGE CODE IS REFUSED — assert on shape, never on status', async () => {
  for (const body of [
    '[["text",42]]',            // language is not a string
    '[["text",""]]',            // empty
    '[["text","not a language"]]',
    '[[42,"pt"]]',              // text is not a string
    '[["text"]]',               // arity
  ]) {
    await withFetch(ok(body), async () => {
      assert.equal(await googleTranslate('Hoy hace muy buen tiempo', 'auto'), null, `refused: ${body}`)
    })
  }
})
