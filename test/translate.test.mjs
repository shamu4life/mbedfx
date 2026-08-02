import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sourceLanguage, translateToEnglish, withTranslation, TRANSLATION_MARKER,
} from '../src/translate.ts'

/**
 * TRANSLATION — requested 2026-07-30 on a Japanese post that rendered correctly and unreadably:
 *
 *   出越 茂毅(Shige) (@mission_shige)
 *   今夜はラテちゃんお昼寝サービス動画😊 需要があれば今度ノーカット版もどこかで😙 https://t.co/2kCDlLDAhK
 *
 * THE AUTHOR'S WORDS ARE NEVER REPLACED, which was the owner's explicit call and is the reason the
 * marker exists. A machine translation printed AS the post attributes words to a real person that
 * they did not write, and a reader cannot tell a bad translation from something they actually said.
 *
 * NOTHING HERE IS LOAD-BEARING. No AI binding, a model error, an unrecognised response shape — every
 * one renders exactly as the card did before translation existed. That property is what let this ship
 * before Workers AI was enabled on the account, and these tests pin it.
 */

test('THE REPORTED POST IS DETECTED AS JAPANESE', () => {
  const real = '今夜はラテちゃんお昼寝サービス動画😊 需要があれば今度ノーカット版もどこかで😙 https://t.co/2kCDlLDAhK'
  assert.equal(sourceLanguage(real), 'ja')
})

test('ENGLISH IS NEVER MARKED AS A FOREIGN SCRIPT', () => {
  /**
   * Translating an English post is the loudest possible failure: it prints a redundant, probably
   * mangled second copy under a marker claiming it was foreign.
   *
   * WHAT CHANGED 2026-08-01, and what did NOT. This used to assert `null` for every English string,
   * because Latin script was out of scope entirely. Now Latin prose can return AUTO, which means
   * "ask a detector" — NOT "translate this". The protection did not move, it moved DOWNSTREAM: an
   * AUTO post is sent to Google, Google answers `en`, and nothing is rendered or marked.
   *
   * So the assertion here is the one that still holds locally: English is never given a foreign
   * SCRIPT code. Being handed to a detector is not being translated.
   */
  for (const t of [
    'Just posted a new video, check it out! https://t.co/abc @someone #tag',
    'Great match today 😊',
    '😊😊😊 amazing 😊😊😊',
    'The character 猫 means cat in Japanese',      // quotes one kanji, still English
    'Score: 3-1 (55%) — what a game!!!',
  ]) {
    const got = sourceLanguage(t)
    assert.ok(got === null || got === 'auto', `must not be a foreign script: ${t.slice(0, 40)} -> ${got}`)
  }
})

test('OBVIOUS ENGLISH COSTS NO REQUEST AT ALL — the local filter', () => {
  /**
   * The filter exists so the English majority does not spend the Google budget the genuinely foreign
   * posts depend on — Google rate-limits bursts, so volume spent here is translations lost there.
   *
   * Its errors are deliberately asymmetric and BOTH are acceptable: a missed foreign post degrades to
   * the behaviour before this path existed, and a wrongly-asked English post costs one request whose
   * negative is then cached forever. This pins the cheap direction.
   */
  for (const t of [
    'Just posted a new video, check it out!',
    'The way you drive is the way your patient feels',
    'this is a really good day for it and I am not sorry',
  ]) {
    assert.equal(sourceLanguage(t), null, `no request for: ${t.slice(0, 40)}`)
  }
})

test('NOISE ALONE IS NOT A LANGUAGE', () => {
  // A url is most of a tweet's characters and translates to garbage; paying for it is paying for
  // noise. Handles and hashtags are stripped for the same reason — a translated @name is broken.
  for (const t of ['https://t.co/2kCDlLDAhK', '@mission_shige', '#麻雀', '😊😊😊😊', '   ', '']) {
    assert.equal(sourceLanguage(t), null, `noise-only must not translate: ${JSON.stringify(t)}`)
  }
})

test('THE SCRIPTS IT DOES CATCH', () => {
  assert.equal(sourceLanguage('오늘 날씨가 정말 좋네요 산책하러 갈까요'), 'ko')
  assert.equal(sourceLanguage('Сегодня очень хорошая погода для прогулки'), 'ru')
  assert.equal(sourceLanguage('الطقس اليوم جميل جدا للنزهة'), 'ar')
  assert.equal(sourceLanguage('วันนี้อากาศดีมากสำหรับการเดินเล่น'), 'th')
  // Han WITHOUT kana is Chinese; kana is checked first so Japanese kanji does not read as Chinese.
  assert.equal(sourceLanguage('今天天气很好适合出去散步'), 'zh')
  assert.equal(sourceLanguage('今夜はラテちゃんお昼寝'), 'ja')
})

test('LATIN-SCRIPT LANGUAGES ARE NOW CAUGHT — the scope this file used to refuse', () => {
  /**
   * THE REVERSAL, 2026-08-01, at the owner's request: "so I thought we were going to implement for
   * all non-english?" — after a Portuguese Instagram caption rendered untranslated.
   *
   * This test asserted the OPPOSITE, and the docstring it enforced named the reason: extending to
   * Latin script "needs real language detection ... a separate decision with a separate cost". That
   * decision has now been taken, and the cost turned out to be smaller than the note assumed —
   * Google's sl=auto returns the DETECTED LANGUAGE beside the translation, so one call classifies and
   * translates together. No detection model, no second inference.
   *
   * AUTO is not a language. It means "we cannot classify this ourselves, so ask" — the verdict still
   * comes from a detector.
   */
  for (const t of [
    'Hoy hace muy buen tiempo para pasear por el parque',
    'Il fait très beau aujourd\'hui pour se promener',
    'Heute ist sehr schönes Wetter zum Spazierengehen',
    'Levada de cuica em soul bossa nova quincy Jones',
  ]) {
    assert.equal(sourceLanguage(t), 'auto', `must be asked about: ${t.slice(0, 40)}`)
  }
})

test('sourceLanguage is TOTAL over junk', () => {
  for (const junk of [undefined, null, 0, {}, [], true]) {
    assert.equal(sourceLanguage(junk), null, `${String(junk)} must not throw`)
  }
})

test('NO BINDING, NO TRANSLATION, NO THROW', async () => {
  // The property that lets this ship before Workers AI is enabled on the account.
  assert.equal(await translateToEnglish(undefined, '今夜は', 'ja'), null)
  assert.equal(await translateToEnglish({}, '今夜は', 'ja'), null, 'a binding without .run')
})

test('A MODEL FAILURE OR A STRANGE SHAPE IS "NO TRANSLATION"', async () => {
  const thrower = { run: async () => { throw new TypeError('inference failed') } }
  assert.equal(await translateToEnglish(thrower, '今夜は', 'ja'), null, 'a throw never escapes')

  for (const bad of [
    null, undefined, {}, 'a string',
    { response: 42 }, { response: '' }, { response: '   ' },
    { choices: [] }, { choices: [{}] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: 7 } }] },
  ]) {
    const ai = { run: async () => bad }
    assert.equal(await translateToEnglish(ai, '今夜は', 'ja'), null, `${JSON.stringify(bad)} is not a translation`)
  }
})

test('BOTH RESPONSE SHAPES ARE READ — the bug that reported the best model as empty', async () => {
  /**
   * ONE BINDING, TWO ENVELOPES. Workers AI passes the OpenAI chat-completions shape straight through
   * for Gemma ({id, object, choices, usage}), while m2m100 and the older text-generation models answer
   * with a flat {response}. Nothing in the binding normalises them.
   *
   * MEASURED 2026-07-31: reading only `response` rendered Gemma and Granite as "empty response" WHILE
   * THE TOKEN BILL PROVED THEY HAD ANSWERED — Gemma's real reply, "Napa cabbage is delicious, isn't
   * it?", was sitting in choices[0].message.content the whole time. That reading would have eliminated
   * the winning candidate on the strength of a field name.
   */
  const chat = { run: async () => ({ choices: [{ message: { content: 'Napa cabbage is delicious' } }] }) }
  assert.equal(await translateToEnglish(chat, '白菜おいしいね', 'ja'), 'Napa cabbage is delicious')

  const flat = { run: async () => ({ response: 'Napa cabbage is delicious' }) }
  assert.equal(await translateToEnglish(flat, '白菜おいしいね', 'ja'), 'Napa cabbage is delicious')
})

test('A "TRANSLATION" IDENTICAL TO THE INPUT IS THE MODEL DECLINING', async () => {
  // Marking an unchanged string as translated is worse than not translating: it tells the reader a
  // translation happened and shows them the same characters again.
  const ai = { run: async () => ({ response: '今夜は' }) }
  assert.equal(await translateToEnglish(ai, '今夜は', 'ja'), null)
})

test('THE INPUT IS CAPPED — Discord truncates long before the model would', async () => {
  let seen = ''
  const ai = { run: async (_m, i) => { seen = i.messages.at(-1).content; return { response: 'ok' } } }
  await translateToEnglish(ai, 'あ'.repeat(5000), 'ja')
  assert.ok(seen.length <= 700, `input capped, was ${seen.length}`)
})

test('ONE CALL, NOT TWO — a chat model is TOLD the language, so there is nothing to guess', async () => {
  /**
   * WHAT THIS REPLACED. The previous model took the language as a `source_lang` field whose spelling
   * Cloudflare's own docs contradicted — the schema said "ja", every published example said
   * "japanese", and neither field carried an enum — so this asked TWICE, names then codes, because
   * betting wrong would not look like a bug. It would look like "no foreign posts today", forever.
   *
   * A chat model is told the language in English, so the ambiguity does not exist and the worst case
   * is halved. The assertion is on the CALL COUNT because that is the cost this bought back.
   */
  const calls = []
  const ai = { run: async (model, i) => { calls.push({ model, ...i }); return { response: 'Tonight' } } }
  assert.equal(await translateToEnglish(ai, '今夜は', 'ja'), 'Tonight')
  assert.equal(calls.length, 1, 'exactly one inference, never a second spelling')
  assert.match(calls[0].model, /gemma/, 'chosen by measurement — see FALLBACK_MODEL')
  assert.match(calls[0].messages.at(-1).content, /Japanese/, 'the language is named in English')
  assert.match(calls[0].messages.at(-1).content, /今夜は/, 'and the text is there to translate')
  assert.equal(calls[0].messages[0].role, 'system')
  assert.match(calls[0].messages[0].content, /ONLY the English translation/i)
  assert.ok(calls[0].max_tokens >= 1024, 'a reasoning model starved of tokens returns nothing at all')
})

test('A LANGUAGE WITH NO NAME MAPPING IS STILL ATTEMPTED, using the code as the name', async () => {
  const calls = []
  const ai = { run: async (_m, i) => { calls.push(i); return { response: 'x' } } }
  assert.equal(await translateToEnglish(ai, 'zzz', 'xx'), 'x')
  assert.equal(calls.length, 1)
  assert.match(calls[0].messages.at(-1).content, /xx/, 'an unmapped code is passed through, not dropped')
})

test('A PREAMBLE IS STRIPPED — an obedient prompt is not an obedient model', async () => {
  /**
   * However firmly the system prompt forbids it, instruction-following models still open with "Here is
   * the translation:" some of the time. Unstripped, that preamble is not merely untidy — it is rendered
   * onto the card under someone's post, and it was paid for in output tokens.
   */
  for (const [raw, want] of [
    ['Here is the translation: Napa cabbage is delicious', 'Napa cabbage is delicious'],
    ["Here's the English translation:\nNapa cabbage is delicious", 'Napa cabbage is delicious'],
    ['Translation: Napa cabbage is delicious', 'Napa cabbage is delicious'],
    ['"Napa cabbage is delicious"', 'Napa cabbage is delicious'],
    ['“Napa cabbage is delicious”', 'Napa cabbage is delicious'],
    ['Napa cabbage is delicious', 'Napa cabbage is delicious'],
  ]) {
    const ai = { run: async () => ({ response: raw }) }
    assert.equal(await translateToEnglish(ai, '白菜おいしいね', 'ja'), want, `stripped: ${JSON.stringify(raw)}`)
  }
})

test('A MULTI-LINE TRANSLATION KEEPS ITS LINE BREAKS', async () => {
  // The system prompt asks for them to be preserved, so the unwrapping must not flatten them.
  const ai = { run: async () => ({ response: 'first line\nsecond line' }) }
  assert.equal(await translateToEnglish(ai, '一行目\n二行目', 'ja'), 'first line\nsecond line')
})

test('ENGLISH LEADS, AND THE ORIGINAL IS NEVER REPLACED', () => {
  /**
   * THE ORDER FLIPPED 2026-08-01 at the owner's request, matching lgb45.com. Original-first was also
   * the owner's call, so this is a preference changing rather than a rule being broken — and the
   * property that first call protected is asserted here unchanged: the author's words are still
   * present, VERBATIM, and still labelled. Nothing is replaced or paraphrased.
   *
   * It also survives truncation better, which is the practical argument. Discord cuts a description
   * off at a few hundred characters, so original-first spent that budget on text the reader could not
   * read and lost the translation — the entire point — to the cut.
   */
  const post = { text: '今夜はラテちゃん', ref: { p: 'x', id: '1' } }
  const out = withTranslation(post, 'Tonight, Latte-chan', 'ja')
  assert.ok(out.text.startsWith('Tonight, Latte-chan'), 'the English leads')
  assert.match(out.text, /🌐 Translated from Japanese/)
  assert.ok(out.text.endsWith('今夜はラテちゃん'), 'and the author still has the last word, verbatim')
  // The marker labels what FOLLOWS it, so it must sit between the two, not on top.
  const iEnglish = out.text.indexOf('Tonight, Latte-chan')
  const iMarker = out.text.indexOf(TRANSLATION_MARKER)
  const iOriginal = out.text.indexOf('今夜はラテちゃん')
  assert.ok(iEnglish < iMarker && iMarker < iOriginal, 'english, marker, original — in that order')
})

test('withTranslation is NON-DESTRUCTIVE and IDEMPOTENT', () => {
  const post = { text: '今夜は', ref: { p: 'x', id: '1' } }
  // Same object reference back when there is nothing to add — withUploadDate's contract.
  for (const junk of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(withTranslation(post, junk, 'ja'), post, `${String(junk)} changes nothing`)
  }
  assert.equal(withTranslation(null, 'x', 'ja'), null)
  // Applying it twice must not stack two markers.
  const once = withTranslation(post, 'Tonight', 'ja')
  assert.equal(withTranslation(once, 'Tonight', 'ja'), once, 'not double-marked')
  assert.equal((once.text.match(new RegExp(TRANSLATION_MARKER, 'g')) || []).length, 1)
})

test('THE MARKER NAMES THE LANGUAGE, and degrades to the code for an unmapped one', () => {
  assert.match(withTranslation({ text: 'x' }, 'y', 'ko').text, /from Korean/)
  assert.match(withTranslation({ text: 'x' }, 'y', 'ru').text, /from Russian/)
  assert.match(withTranslation({ text: 'x' }, 'y', 'xx').text, /from xx/, 'never "from undefined"')
})

test('AN EMPTY-BODY POST STILL GETS A READABLE BLOCK', () => {
  const out = withTranslation({ text: '' }, 'Tonight', 'ja')
  assert.equal(out.text, '🌐 Translated from Japanese\nTonight', 'no leading blank lines')
})

test('A URL NEVER REACHES THE MODEL — measured, it poisons the translation', async () => {
  /**
   * MEASURED 2026-07-31 on x:2082851272315834575. We sent the raw body and m2m100 answered:
   *
   *   in   白菜おいしいね https://t.co/TNMl0cLOY0
   *   out  It is delicious https://t.co/TNMl0cLOY0
   *
   * The link echoed into the translation as though it were a word, and 白菜 ("Chinese cabbage")
   * dropped entirely. A t.co link is most of a tweet's characters and carries no meaning, so it
   * competes for the model's attention with the sentence and pays tokens to do it.
   */
  let seen = null
  const ai = { run: async (_m, i) => { seen = i.messages.at(-1).content; return { response: 'Chinese cabbage is delicious' } } }
  const out = await translateToEnglish(ai, '白菜おいしいね https://t.co/TNMl0cLOY0', 'ja')
  assert.ok(seen.includes('白菜おいしいね'), 'the text reaches the model')
  assert.ok(!seen.includes('t.co'), 'the url is gone before the model sees it')
  assert.equal(out, 'Chinese cabbage is delicious')
  assert.ok(!String(out).includes('t.co'), 'and so it cannot come back in the answer')
})

test('A BODY THAT IS ONLY A URL IS NOT TRANSLATED AT ALL', async () => {
  let called = 0
  const ai = { run: async () => { called++; return { response: 'x' } } }
  assert.equal(await translateToEnglish(ai, 'https://t.co/TNMl0cLOY0', 'ja'), null)
  assert.equal(called, 0, 'paying for a url is paying for nothing')
})
