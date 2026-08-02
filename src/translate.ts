import type { Post } from './types.ts'

/**
 * TRANSLATION — Workers AI, opt-in, and never load-bearing.
 *
 * Requested 2026-07-30 on a Japanese post (mission_shige/status/2082797559819432173), which rendered
 * correctly and unreadably: 今夜はラテちゃんお昼寝サービス動画😊
 *
 * THE AUTHOR'S WORDS COME FIRST AND ARE NEVER REPLACED. A machine translation printed as if it were
 * the post puts words in a real person's mouth, and a reader cannot tell a bad translation from
 * something they actually said. So the original leads, the translation follows a marker, and the
 * marker names the source language — the owner's call, and the right one.
 *
 * THE BINDING IS OPTIONAL, exactly as MEDIA_RESOLVER is. `env.AI` absent means every post renders
 * precisely as it does today; there is no code path where a missing or failing binding costs a card.
 * That is what makes this safe to deploy before Workers AI is enabled on the account.
 */

/**
 * WHICH TEXT NEEDS TRANSLATING — decided by SCRIPT, not by a language-detection model.
 *
 * The request was literally "contains non-english script", and script detection is the one form of
 * this that is free, deterministic, testable offline and impossible to get confidently wrong. An AI
 * detection call would cost a second inference on every post in the world to catch the Latin-script
 * cases, and would sometimes be wrong about English.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH, stated so nobody assumes otherwise: Spanish, French, German,
 * Portuguese, Turkish, Vietnamese — every language written in Latin script. A Spanish post is not
 * translated. Extending to those needs real language detection and is a separate decision with a
 * separate cost, not something to sneak in behind a script check.
 *
 * The ranges are the writing systems, not the languages: Han covers Chinese AND Japanese kanji, so
 * `ja` vs `zh` is decided by the presence of kana below rather than by the Han block.
 *
 * DETECTING A SCRIPT IS NOT THE SAME AS BEING ABLE TO TRANSLATE IT, and four entries here are on the
 * wrong side of that line. Cloudflare's catalog states this model's languages as "english, chinese,
 * french, spanish, arabic, russian, german, japanese, portuguese, hindi" — so ja/zh/ru/ar/hi are
 * advertised and KO/HE/TH/EL ARE NOT. They are kept anyway, deliberately, for two reasons: no `enum`
 * constrains the parameter, so nothing rejects them up front; and the upstream M2M100 family does
 * cover all four, though the 1.2B checkpoint Cloudflare serves is trained on a REDUCED pair set, so
 * "the family covers it" is not proof this checkpoint does.
 *
 * The honest position is that those four are UNVERIFIED, not broken. If the model declines them the
 * result is null, which renders the card exactly as it does today — the cost of being wrong here is a
 * missing translation, never a missing card, which is why guessing generously is safe.
 */
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ja', /[぀-ゟ゠-ヿ]/],        // kana — checked FIRST, see the Han note above
  ['ko', /[가-힯ᄀ-ᇿ]/],        // hangul
  ['zh', /[一-鿿㐀-䶿]/],        // han without kana
  ['ru', /[Ѐ-ӿ]/],                     // cyrillic
  ['ar', /[؀-ۿݐ-ݿ]/],        // arabic
  ['he', /[֐-׿]/],                     // hebrew
  ['th', /[฀-๿]/],                     // thai
  ['el', /[Ͱ-Ͽ]/],                     // greek
  ['hi', /[ऀ-ॿ]/],                     // devanagari
]

/**
 * A URL is not prose and must not reach the model: t.co links are most of a Twitter post's character
 * count, they translate to garbage, and paying to translate them is paying for noise. Handles and
 * hashtags are stripped for the same reason — a translated @name is a broken mention.
 */
const NOISE = /https?:\/\/\S+|[@#][\w.]+/g

/** The share of non-ASCII needed before a post counts as foreign rather than as decorated English. */
const FOREIGN_RATIO = 0.15

/**
 * The source language, or null when the post is (as far as script can tell) already readable.
 *
 * THE RATIO IS WHAT STOPS AN ENGLISH POST WITH ONE EMOJI OR ONE KANJI FROM BEING "JAPANESE". Emoji
 * are stripped before measuring — they are not script — and a single foreign character in an English
 * sentence is a quotation, not a language.
 */
/**
 * THE SENTINEL FOR "PROSE WE CANNOT CLASSIFY OURSELVES" — Latin script, which is every language from
 * Spanish to Vietnamese AND English itself. Asking Google with sl=auto is what resolves it, because
 * the answer includes the detected language; see googleTranslate.
 */
export const AUTO = 'auto'

/**
 * ENOUGH PROSE TO BE WORTH ASKING ABOUT, for the Latin-script path only.
 *
 * Script detection is free, so a two-character Japanese post costs nothing to classify. Latin script
 * costs a network round trip, so the bar is higher: "lol", "nice" and a row of emoji are not worth a
 * request, and a one-word Latin string is exactly where a detector is least reliable anyway. Two
 * words and twelve letters is a sentence-ish shape.
 */
const LATIN_MIN_CHARS = 12
const LATIN_MIN_WORDS = 2
/** Latin letters, including the accented ranges — the script test, not a language test. */
const LATIN = /[A-Za-z\u00c0-\u024f]/

/**
 * DOES THIS LATIN TEXT LOOK ENGLISH ENOUGH TO NOT BOTHER ASKING?
 *
 * READ THE ASYMMETRY FIRST, because it is the entire justification and it is what makes this
 * acceptable in a file that otherwise refuses to guess at languages:
 *
 *   - Wrong in the "looks English" direction (it was Spanish)  -> no translation, which is EXACTLY
 *     the behaviour before the auto path existed. Costs nothing that was not already lost.
 *   - Wrong in the "ask" direction (it was English)            -> one request, Google says `en`, the
 *     negative is cached forever, nothing renders. Costs one call, once.
 *
 * So this is not deciding a language — it decides only whether the QUESTION IS WORTH A ROUND TRIP,
 * and both of its errors are cheap. The actual English/not-English verdict still comes from a
 * detector, never from here.
 *
 * WHY IT IS NEEDED AT ALL: without it every English post on the site buys an upstream request on
 * first render. Measured in the test suite as a second fetch on unrelated fixtures. Worse than the
 * volume is what the volume THREATENS — Google rate-limits bursts (measured: HTTP 429 on ~30 requests
 * in a few seconds), so spending the budget on English posts is how the genuinely foreign ones stop
 * being translated.
 *
 * DIACRITICS ARE THE STRONGEST SIGNAL and are checked first: English essentially does not use them,
 * while Spanish, Portuguese, French, German, Turkish and Vietnamese are full of them.
 */
const DIACRITIC = /[\u00c0-\u024f]/
/** Whole-word function words. Multi-character and distinctive on purpose — "a", "e", "o", "y" are shared. */
const EN_WORDS = new Set([
  'the', 'and', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'that',
  'this', 'it', 'its', 'be', 'have', 'has', 'from', 'by', 'you', 'your', 'my', 'we', 'they', 'not',
  'but', 'or', 'as', 'if', 'so', 'out', 'up', 'about', 'just', 'new', 'get', 'all', 'can', 'will',
  'what', 'when', 'how', 'why', 'who', 'do', 'does', 'did', 'been', 'more', 'some', 'them', 'there',
  'here', 'now', 'one', 'like', 'into', 'over', 'after', 'our', 'their', 'his', 'her', 'she', 'he',
])
const FOREIGN_WORDS = new Set([
  // es / pt
  'de', 'la', 'el', 'que', 'en', 'un', 'una', 'para', 'con', 'por', 'del', 'los', 'las', 'como',
  'mas', 'nao', 'uma', 'dos', 'das', 'ao', 'aos', 'pelo', 'pela', 'seu', 'sua', 'meu', 'minha',
  // fr
  'je', 'le', 'les', 'des', 'du', 'est', 'pour', 'dans', 'avec', 'sur', 'pas', 'vous', 'nous',
  'ce', 'cette', 'mais', 'tout', 'plus', 'bien', 'sont',
  // de
  'der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'mit', 'fur', 'nicht', 'auf', 'auch', 'sich',
  'wir', 'aber', 'sind', 'oder', 'wie', 'zum', 'zur',
  // it
  'di', 'che', 'per', 'non', 'sono', 'anche', 'come', 'alla', 'nel', 'gli',
  // nl / other
  'het', 'een', 'van', 'zijn', 'niet', 'ook',
])

function looksEnglish(prose: string): boolean {
  if (DIACRITIC.test(prose)) return false
  const words = prose.toLowerCase().match(/[a-z']+/g) || []
  if (!words.length) return true
  let en = 0
  let foreign = 0
  for (const w of words) {
    if (EN_WORDS.has(w)) en++
    else if (FOREIGN_WORDS.has(w)) foreign++
  }
  // A foreign function word outweighs an English one: the overlap between the lists is empty, so a
  // hit on the foreign side is a positive signal rather than an absence of an English one.
  if (foreign > en) return false
  // No English function words at all in a sentence-length string is itself suspicious — that is what
  // a foreign sentence made of words neither list knows looks like.
  return en > 0
}

export function sourceLanguage(text: unknown): string | null {
  if (typeof text !== 'string') return null
  // Strip urls, handles, and everything outside the Basic Multilingual plane's letter ranges that is
  // decoration rather than script — emoji, symbols, whitespace, punctuation.
  const prose = text.replace(NOISE, ' ').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
  const meaningful = prose.replace(/[\s\p{P}\p{S}\d]/gu, '')
  if (meaningful.length < 4) return null
  for (const [lang, re] of SCRIPTS) {
    if (!re.test(meaningful)) continue
    const hits = (meaningful.match(new RegExp(re.source, 'gu')) || []).length
    if (hits / meaningful.length >= FOREIGN_RATIO) return lang
  }
  /**
   * LATIN SCRIPT — WE CANNOT TELL, SO WE ASK. Extended 2026-08-01 at the owner's request, after an
   * Instagram reel captioned in Portuguese rendered untranslated and he asked "I thought we were
   * going to implement for all non-english?".
   *
   * This is the "separate decision with a separate cost" the docstring above has always named, taken
   * deliberately rather than snuck in. The cost is a network round trip per DISTINCT post, and what
   * makes it affordable is that Google's sl=auto returns the DETECTED LANGUAGE beside the
   * translation — so one call both classifies and translates, and a post it calls English is cached
   * as "no translation" and never asked about again.
   *
   * IT DOES NOT GUESS. Nothing here decides a language; it decides only that the question is worth
   * asking. Deciding English-or-not locally is the thing this file has always refused to do, and the
   * refusal stands — the answer comes from a detector, not from a heuristic in here.
   */
  if (!LATIN.test(meaningful)) return null
  if (meaningful.length < LATIN_MIN_CHARS) return null
  if (prose.trim().split(/\s+/).filter(Boolean).length < LATIN_MIN_WORDS) return null
  // The cheap local filter, and see looksEnglish for why guessing here is legitimate when guessing
  // at the LANGUAGE is not: both of its errors are already-acceptable outcomes.
  if (looksEnglish(prose)) return null
  return AUTO
}

/** Discord truncates a description long before this; translating more is paying to be cut off. */
const MAX_INPUT = 600

/**
 * EXACTLY WHAT THE MODEL IS ASKED, and therefore exactly what the cache must be keyed on.
 *
 * Exported for that second reason. The R2 cache is content-addressed, and the first version hashed
 * the RAW post text — so when url-stripping changed what we send, every already-cached translation
 * kept its old key and kept being served. Verified in production: after the stripping fix deployed,
 * x:2082851272315834575 still rendered "It is delicious https://t.co/TNMl0cLOY0", because the poisoned
 * answer was still the value under the unchanged key. The cache must map WHAT WE ASKED to WHAT WE GOT;
 * keying it on anything else means a change to the question cannot invalidate a stale answer.
 *
 * Truncation happens after stripping, so the cap counts prose rather than a url that was never going
 * to be translated.
 */
export function modelInput(text: unknown): string {
  // TOTAL OVER JUNK, like every other entry point here. This is reached from two callers now, and a
  // corrupt cache record can put a non-string in `post.text` — a throw inside a request is the one
  // thing this file's contract forbids.
  if (typeof text !== 'string') return ''
  return text.replace(NOISE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT)
}

export type Translator = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

/** How the marker reads, and — see LANG_FORMS — also how the model is asked. */
const LANGUAGE_NAME: Record<string, string> = {
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', ar: 'Arabic',
  he: 'Hebrew', th: 'Thai', el: 'Greek', hi: 'Hindi',
  /**
   * THE LATIN-SCRIPT LANGUAGES, added 2026-08-01 with the auto path. These are never DETECTED here —
   * Google detects, this only names — so the list is about the marker reading "Translated from
   * Portuguese" rather than "Translated from pt".
   *
   * It does not need to be exhaustive and deliberately is not: an unmapped code falls back to the
   * code itself (see withTranslation), which is honest rather than wrong. These are the ones a card
   * is actually likely to carry.
   */
  es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian',
  nl: 'Dutch', pl: 'Polish', tr: 'Turkish', vi: 'Vietnamese', id: 'Indonesian',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech',
  ro: 'Romanian', hu: 'Hungarian', uk: 'Ukrainian', tl: 'Tagalog', ms: 'Malay',
  ca: 'Catalan', hr: 'Croatian', sk: 'Slovak', sl: 'Slovenian', et: 'Estonian',
  lv: 'Latvian', lt: 'Lithuanian', sw: 'Swahili', af: 'Afrikaans',
}

/**
 * THE FALLBACK MODEL, CHOSEN BY MEASUREMENT — every engine Workers AI offers, same inputs, run from a
 * Worker (bakeoff/, 2026-07-31). m2m100-1.2b held this slot until then and was the WORST of the five:
 *
 *     白菜おいしいね              m2m100 "White is delicious."        gemma "Napa cabbage is delicious"
 *     このラーメン屋さんは…       m2m100 "This ROOMMATE is as         gemma "This ramen shop is so
 *                                        popular as you can."               popular that there are lines."
 *     新しいゲーム機を…積んでる   m2m100 "it's loaded."               gemma "I have a backlog."
 *
 * m2m100 is a small MT model: it splits compounds it does not know (白菜 → "white") and mangles any
 * sentence with structure. Gemma reads them. The two cheaper/faster candidates were rejected on
 * evidence, not price: granite-4.0-h-micro hallucinated ("Carrots are delicious" for 白菜) and SILENTLY
 * TRUNCATED — it rendered 오늘 날씨가 정말 좋네요 산책하러 갈까요 as "Today's weather is really nice",
 * dropping the question entirely, which is the one failure mode a reader cannot detect. qwen3 matched
 * Gemma's quality at up to 9.6s.
 *
 * GEMMA IS SLOW (3.4-7.0s) AND THAT IS AFFORDABLE HERE, because of two properties this file did not
 * have when m2m100 was chosen:
 *
 *   1. GOOGLE ANSWERS FIRST, in 13-16ms, and is free. This model runs only when Google declines — a
 *      429 burst — so it is the rare path, not the common one.
 *   2. A LOST RACE STILL CACHES. withTranslated hands the attempt to ctx.waitUntil with the R2 write
 *      INSIDE the raced work, and reports `pending` so the untranslated card is not response-cached.
 *      Missing the 1500ms deadline therefore costs the FIRST render a marker, not the translation.
 *
 * A wrong translation is permanent and invisible; a late one repairs itself. That trade is why the
 * slowest good model beats the fastest bad one in this slot.
 */
const FALLBACK_MODEL = '@cf/google/gemma-4-26b-a4b-it'

/**
 * ROOM TO ANSWER. Gemma reasons before replying, and the first bake-off run capped it at 400 — it
 * spent the entire budget thinking, got cut off before emitting a word, and reported an EMPTY response
 * while still billing for 412 output tokens. That read as "the model is broken" when it meant "the
 * ceiling is too low", and it nearly eliminated the winning candidate. modelInput caps the prompt at
 * 600 characters, so this bounds the answer, not the question.
 */
const MAX_OUTPUT_TOKENS = 1024

/**
 * ONLY the translation, because anything else becomes card text. A model that opens with "Here is the
 * translation:" has billed for words nobody wants AND put them under someone's post.
 */
const SYSTEM_PROMPT = 'You are a translation engine. Reply with ONLY the English translation of the '
  + "user's message. No preamble, no explanation, no quotation marks, no notes, no romanisation. "
  + 'Preserve line breaks. Translate idioms and slang to their English sense rather than word-by-word.'

/**
 * TWO RESPONSE SHAPES, ONE BINDING. Workers AI passes the OpenAI chat-completions envelope straight
 * through for this model ({id, object, choices, usage}), while m2m100 and the older text-generation
 * models answer with a flat {response}. Reading only one field reported Gemma as returning nothing at
 * all — with a token bill proving otherwise — so both are read here rather than trusting either doc.
 */
function answerOf(out: unknown): string {
  const o = out as {
    response?: unknown
    choices?: ReadonlyArray<{ message?: { content?: unknown } }>
  } | null
  const direct = typeof o?.response === 'string' ? o.response : ''
  const chat = typeof o?.choices?.[0]?.message?.content === 'string' ? o.choices[0].message.content : ''
  return direct || chat
}

/** Strip the wrapper an instruction-following model adds anyway, however firmly it was told not to. */
function unwrap(s: string): string {
  return s
    .replace(/^\s*(?:here(?:'s| is)[^:\n]*:|translation:)\s*/i, '')
    .replace(/^\s*["'“”](.*)["'“”]\s*$/s, '$1')
    .trim()
}

/**
 * Translate to English, or return null. NEVER THROWS — every failure mode (no binding, a model error,
 * a shape we do not recognise, a timeout upstream) is "no translation", which renders as today.
 */
export async function translateToEnglish(
  ai: Translator | undefined,
  text: string,
  source: string,
): Promise<string | null> {
  if (!ai || typeof ai.run !== 'function') return null
  /**
   * URLS ARE STRIPPED BEFORE THE MODEL SEES THEM, not just before detection.
   *
   * MEASURED 2026-07-31 on x:2082851272315834575. We sent the raw body —
   * `白菜おいしいね https://t.co/TNMl0cLOY0` — and m2m100 handed back
   * `It is delicious https://t.co/TNMl0cLOY0`: the link echoed into the translation as though it
   * were a word, and 白菜 ("Chinese cabbage") dropped entirely. A t.co link is most of a tweet's
   * characters, carries no meaning, and competes for the model's attention with the sentence.
   *
   * The same NOISE the detector already removes, applied one layer later. Truncation happens AFTER,
   * so the cap counts prose rather than a url that was never going to be translated.
   */
  const input = modelInput(text)
  if (!input) return null
  /**
   * ONE CALL, NOT TWO. The previous model took the language as a `source_lang` field whose spelling
   * Cloudflare's own docs contradicted ("japanese" in every example, "ja" in the schema), so this
   * asked twice — names, then codes — because guessing wrong renders as "no foreign posts today".
   * A chat model is simply TOLD the language in English, so the ambiguity no longer exists and the
   * worst case is halved.
   */
  const language = LANGUAGE_NAME[source] || source
  let out: unknown
  try {
    out = await ai.run(FALLBACK_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Translate this ${language} text to English:\n\n${input}` },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
    })
  } catch {
    return null
  }
  // ASSERT ON THE SHAPE, like every upstream in this project. The official types make the answer
  // optional and union the result with an async-queue response carrying a `request_id` instead, so a
  // model that answers with something we do not recognise must not become a card.
  const got = unwrap(answerOf(out))
  if (!got) return null
  // A "translation" identical to the input is the model declining, not a result worth a marker.
  return got === input.trim() ? null : got
}

/** How the marker reads. Named once so the renderer and the tests cannot disagree about it. */
export const TRANSLATION_MARKER = '🌐 Translated'

/**
 * Compose the translated card: ENGLISH FIRST, then the marker, then the author's original.
 *
 *     Chinese cabbage is delicious, isn't it?
 *
 *     🌐 Translated from Japanese
 *     白菜おいしいね
 *
 * THE ORDER IS REVERSED FROM WHAT THIS SHIPPED WITH, at the owner's request 2026-08-01, matching
 * lgb45.com. Original-first was also the owner's call originally, so this is a preference changing
 * rather than a rule being broken — and the property that call was protecting is untouched: THE
 * AUTHOR'S WORDS ARE STILL THERE, VERBATIM, AND STILL LABELLED. Nothing is replaced or paraphrased.
 * A reader can always see what was actually written, which is what stops a machine translation from
 * being attributed to a real person.
 *
 * IT ALSO SURVIVES TRUNCATION BETTER, which is the practical argument. Discord cuts a description off
 * at a few hundred characters, so on a long post original-first spent the whole budget on text the
 * reader already could not read, and the translation — the entire point — was the part that got cut.
 * Whichever half survives is now the half that helps.
 *
 * THE MARKER SITS BETWEEN THEM rather than on top, because it reads as a label for what FOLLOWS: the
 * English needs no announcement, and the line the reader needs explained is the original beneath it.
 *
 * Returns the SAME object reference when there is nothing to add, matching withUploadDate's contract
 * — a caller can always assign the result without checking whether anything happened.
 */
export function withTranslation(post: Post, translated: unknown, source: string): Post {
  if (!post || typeof translated !== 'string' || !translated.trim()) return post
  const cur = typeof post.text === 'string' ? post.text : ''
  const name = LANGUAGE_NAME[source] || source
  const marker = `${TRANSLATION_MARKER} from ${name}`
  // IDEMPOTENT, and it must stay that way: withTranslation is reachable from both render seams (the
  // HTML head and the Mastodon spoof), and a post that has already been composed must not be
  // composed again into a card carrying two translations.
  if (cur.includes(TRANSLATION_MARKER)) return post
  const english = translated.trim()
  /**
   * WITH NO ORIGINAL, THE MARKER LEADS INSTEAD. It is a label for the line beneath it, so on a
   * body-less post a TRAILING marker would announce nothing at all — and a card ending in
   * "🌐 Translated from Japanese" with nothing after it reads as truncation.
   */
  return { ...post, text: cur ? `${english}\n\n${marker}\n${cur}` : `${marker}\n${english}` }
}

/**
 * GOOGLE TRANSLATE, VIA THE ENDPOINT ITS OWN DICTIONARY EXTENSION USES.
 *
 * WHY IT IS THE PRIMARY. Measured 2026-07-31 against the case that prompted all of this, plus the
 * two alternatives:
 *
 *     白菜おいしいね
 *       google          "Chinese cabbage is delicious"      <- what the owner was comparing us to
 *       m2m100-1.2b     "White is delicious."
 *       LibreTranslate  "White rice"
 *
 * The small MT models fail the same way as each other — they split a compound like 白菜 or drop
 * 日向ぼっこ entirely — because they are the same class of thing. All eight of our other scripts
 * answered, including the four (Korean, Hebrew, Thai, Greek) that m2m100's own catalog does not even
 * advertise. 217-798ms measured.
 *
 * IT ALSO COSTS NOTHING, which is the owner's stated constraint: every translation served here is
 * Workers AI neurons NOT spent, so this makes the feature cheaper rather than dearer.
 *
 * WHAT IT IS, STATED PLAINLY RATHER THAN LEFT TO BE DISCOVERED. `client=dict-chrome-ex` is the key
 * Google's own Dictionary extension uses. This is an undocumented internal endpoint, not the paid
 * Cloud Translation API, and using it is automated access outside Google's terms. It was shipped as
 * a deliberate, informed decision by the owner, and it can be turned off with one env var — see
 * Env.TRANSLATE_GOOGLE. It is also touchy: py-googletrans#268, where this endpoint is documented,
 * calls it "annoying touchy with 403s".
 *
 * NOTHING ABOUT A READER IS SENT. The only thing that leaves is the post's own public text, from OUR
 * egress — no IP, no user agent, nothing about who is looking.
 *
 * UNVERIFIED FROM CLOUDFLARE EGRESS, and that is the live risk rather than a theoretical one: every
 * measurement above is from a residential IP, and this project has already been bitten twice by
 * exactly that gap (Facebook withholds its 302 from our egress; Reddit blocks anonymous reads). The
 * `translate_fallback` counter exists so a datacenter-wide block is VISIBLE instead of silent — if it
 * runs level with `translated` at zero, Google is refusing us and Gemma is carrying the feature.
 *
 * MEASURED 2026-07-31, from a Worker, which is the only place this question can be settled: Google
 * answers in 13-16ms and is NOT blocked from Cloudflare's egress. It does rate-limit BURSTS — a
 * bake-off firing ~30 requests in a few seconds drew HTTP 429 on every one, and the same endpoint
 * answered instantly once spaced out. Production traffic is spread and cached, so the ratio should
 * sit near zero; a sustained climb means something changed, not that a burst happened.
 */
const GOOGLE = 'https://clients5.google.com/translate_a/t'

/** A translation response is small; anything large is not one, and must not be read into memory. */
const MAX_RESPONSE = 64 * 1024

/**
 * Translate, and say WHICH LANGUAGE it was.
 *
 * TWO RESPONSE SHAPES, ONE ENDPOINT, and the difference is the whole reason the Latin-script path
 * works. Measured 2026-08-01:
 *
 *     sl=ja    -> ["Chinese cabbage is delicious"]
 *     sl=auto  -> [["Chinese cabbage is delicious","ja"]]
 *
 * With an explicit language we already know it and the flat form is enough. With sl=auto the SECOND
 * element is the DETECTED language — which is what makes "translate everything that is not English"
 * possible without a detection model: one call classifies and translates together, and a post Google
 * calls English is one we can cache as needing nothing.
 *
 * `lang` is echoed back for the explicit case too, so callers have exactly one shape to handle.
 */
export async function googleTranslate(
  text: string, source: string,
): Promise<{ text: string; lang: string } | null> {
  const input = modelInput(text)
  if (!input) return null
  const url = `${GOOGLE}?client=dict-chrome-ex&sl=${encodeURIComponent(source)}&tl=en&q=${encodeURIComponent(input)}`
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } })
  } catch {
    return null
  }
  if (res.status !== 200) {
    void res.body?.cancel()
    return null
  }
  let body: string
  try {
    body = await res.text()
  } catch {
    return null
  }
  if (body.length > MAX_RESPONSE) return null
  /**
   * ASSERT ON THE SHAPE. The endpoint answers `["translated text"]` for a plain query, but the same
   * url returns a DICTIONARY OBJECT for a single dictionary word (the extension's actual purpose), so
   * "it was 200" is not "it was a translation" — the house rule, applied to one more upstream.
   */
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const first = Array.isArray(parsed) ? parsed[0] : null
  /**
   * BOTH SHAPES, ASSERTED RATHER THAN ASSUMED. A dictionary object, a bare number, a nested array of
   * the wrong arity — none of them is a translation, and the house rule is that a 200 is not an
   * answer. The auto form must carry a STRING language beside the text or we do not know what we are
   * looking at, which on this path is the difference between translating a post and mislabelling an
   * English one.
   */
  let out: string | null = null
  let lang = source
  if (typeof first === 'string') {
    out = first
  } else if (Array.isArray(first) && typeof first[0] === 'string' && typeof first[1] === 'string') {
    out = first[0]
    lang = first[1]
  }
  if (out === null) return null
  const clean = out.trim()
  if (!clean) return null
  const code = lang.trim().toLowerCase()
  if (!code || !/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(code)) return null
  /**
   * ENGLISH IS AN ANSWER, AND THE ANSWER IS "NOTHING TO DO". It is not a failure and must not be
   * retried against a model: this is the case sl=auto exists to settle, and the caller caches it so
   * the same English post is never asked about twice.
   */
  if (code === 'en') return { text: '', lang: 'en' }
  // Unchanged input is the endpoint declining, exactly as it is for the model.
  return clean === input.trim() ? null : { text: clean, lang: code }
}

/**
 * NAME THE LANGUAGE. Detection only — it never translates, and that distinction is the entire reason
 * this is allowed to exist in a file that refuses to let a model decide what English is.
 *
 * WHY IT IS NEEDED. Google's sl=auto answers a laptop and gives our Worker NOTHING — proven not by
 * guessing but by the absence of a cache record for a post that should have written one, with no
 * exception logged. Every measurement behind the auto path was residential, which is the exact gap
 * this project has been bitten by three times.
 *
 * WHY IT IS SAFE, when "let the model translate an unknown post" is not. A model asked to TRANSLATE
 * English returns a fluent paraphrase and nothing marks it as wrong — that is the failure the auto
 * path was built to avoid. A model asked to NAME a language returns a token we can validate against a
 * two-letter shape, and its "en" answer is a clean negative. The output is checkable; a paraphrase is
 * not.
 *
 * IT ONLY RUNS WHEN GOOGLE HAS ALREADY DECLINED, so a working Google costs nothing.
 */
export async function detectLanguage(ai: Translator | undefined, text: string): Promise<string | null> {
  if (!ai || typeof ai.run !== 'function') return null
  const input = modelInput(text)
  if (!input) return null
  let out: unknown
  try {
    out = await ai.run(FALLBACK_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'You identify languages. Reply with ONLY the two-letter ISO 639-1 code for the '
            + "language of the user's message — for example: en, es, pt, fr, de, ja. "
            + 'No explanation, no punctuation, no other words.',
        },
        { role: 'user', content: input },
      ],
      max_tokens: 300,
    })
  } catch {
    return null
  }
  const said = unwrap(answerOf(out)).toLowerCase()
  // The LAST two-letter run, because a reasoning model may narrate before answering. Validated
  // against a shape rather than trusted: anything that is not a language code is no answer at all.
  const hits = said.match(/\b[a-z]{2}\b/g)
  const code = hits && hits.length ? hits[hits.length - 1] : ''
  return code || null
}

/**
 * The best translation available, and WHICH SOURCE GAVE IT — the caller counts that, because a silent
 * fall back to the weaker model is the failure mode this whole arrangement has to make visible.
 */
export async function translateBest(
  text: string,
  source: string,
  opts: { ai?: Translator; google?: boolean },
): Promise<{ text: string; via: 'google' | 'ai'; lang: string } | null> {
  if (opts.google !== false) {
    const g = await googleTranslate(text, source)
    // English: settled, and settled NEGATIVELY. Returned rather than swallowed so the caller can
    // cache the negative and stop asking about this text forever.
    if (g && g.lang === 'en') return { text: '', via: 'google', lang: 'en' }
    if (g) return { text: g.text, via: 'google', lang: g.lang }
  }
  /**
   * NO MODEL FALLBACK WHEN WE DO NOT KNOW THE LANGUAGE, and this is the load-bearing half of the
   * Latin-script design.
   *
   * The fallback exists to keep a KNOWN-foreign post translated when Google refuses us. On the auto
   * path the post is only SUSPECTED foreign — it is far more likely to be English — and a translation
   * model asked to translate English happily returns a paraphrase. That would put a
   * "🌐 Translated from ..." marker on an English post, which is the loudest failure this feature has
   * and the exact thing the original script-only design existed to avoid.
   *
   * So a Google miss on the auto path degrades to NO TRANSLATION, which is precisely the behaviour
   * before this path existed. Nothing regresses; the new path simply does not fire.
   */
  if (source === AUTO) {
    /**
     * GOOGLE COULD NOT TELL US, SO ASK THE MODEL TO NAME IT — then start over with a language in
     * hand. This is a SECOND PASS, not a fallback translation: once the language is known the post is
     * no longer "suspected foreign", so the ordinary Google-then-model ladder applies and all of its
     * existing protections come back with it.
     *
     * An English verdict is a clean negative and is cached as one, exactly as Google's would be.
     */
    const detected = await detectLanguage(opts.ai, text)
    if (!detected) return null
    if (detected === 'en') return { text: '', via: 'ai', lang: 'en' }
    if (opts.google !== false) {
      const g2 = await googleTranslate(text, detected)
      if (g2 && g2.lang === 'en') return { text: '', via: 'google', lang: 'en' }
      if (g2) return { text: g2.text, via: 'google', lang: g2.lang }
    }
    const a2 = await translateToEnglish(opts.ai, text, detected)
    return a2 ? { text: a2, via: 'ai', lang: detected } : null
  }
  const a = await translateToEnglish(opts.ai, text, source)
  return a ? { text: a, via: 'ai', lang: source } : null
}
