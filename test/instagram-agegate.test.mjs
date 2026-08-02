import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  instagramAgeGate, instagramFullPageCard, instagramPrivateGate,
} from '../src/platforms/instagram/normalize.ts'

/**
 * THE WRONG WALL, reported 2026-07-28: instagram.com/reel/DZFDtEhoNPy/ and /reel/DZPWDqmIIld/ both
 * rendered "Couldn't load this Instagram post — It may be private, removed, or unavailable."
 *
 * BOTH POSTS EXIST AND ARE LIVE. The owning account is restricted to 25+, so Instagram refuses them
 * to every logged-out client. The card was not wrong to fail — it was wrong about WHY, and this
 * project already ships a 🔞 card for exactly this on Twitter and TikTok. Instagram simply had no
 * producer for it: `grep -rn 'restricted_age|failure_reason' src/` returned ZERO hits.
 *
 * HOW WE KNOW THEY EXIST, rather than assuming the reporter is right. `/api/v1/oembed/?url=…` with
 * only `user-agent: facebookexternalhit/1.1`, no cookie and no token, discriminates four ways:
 *
 *   DZFDtEhoNPy    400  {"blocks_logging_data":"MIN_AGE_ACCOUNT",
 *                        "title":"People under 25 can't see this content",
 *                        "gating_type":"unappealable","media_igid":3910548142816285682}
 *   DZPWDqmIIld    400  identical, media_igid 3913443610126747997
 *   DbN6SsKum-9    200  the real post (author fixture_user_10)
 *   DZFDtEhoNPz    404  "No Media Match"   <- a well-formed code one character off
 *
 * That last row is the load-bearing one: a neighbouring code gets NO MEDIA MATCH, while ours gets a
 * gating object carrying the CORRECT media id. Instagram resolved the row before refusing it. You
 * cannot gate what does not exist.
 *
 * A CAUTION WORTH RECORDING. The investigation's first pass concluded "genuinely gone, not our bug"
 * and that conclusion SURVIVED three independent adversarial reviewers — because none of them read
 * the error page's `props` blob. Four agents in a row looked at a page that names its own age gate
 * and called it indistinguishable from a deleted post. The fix came from diffing the bytes, not from
 * more argument.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => readFileSync(new URL(n, F), 'utf8')

const AGE_GATED = load('instagram-fullpage-agegated.html')   // /p/DZFDtEhoNPy/, facebookexternalhit
const PUBLIC = load('instagram-fullpage-public.html')        // a live public reel, same surface

test('THE SIGNAL IS INSTAGRAM\'S OWN ERROR FIELD, not an absence', () => {
  /**
   * The full page server-renders a PolarisErrorRoot whose props are verbatim:
   *     "failure_reason":"MA","restricted_age":25,"page_type":"MEDIA"
   * A live public post carries neither key. That makes this a POSITIVE gate — the discipline
   * tiktokGate keeps, and the one instagramPrivateGate structurally cannot.
   */
  assert.match(AGE_GATED, /"failure_reason":"MA"/)
  assert.match(AGE_GATED, /"restricted_age":25/)
  assert.equal(instagramAgeGate(AGE_GATED), 'age_restricted')

  assert.doesNotMatch(PUBLIC, /"failure_reason"/, 'a live post carries no such field')
  assert.equal(instagramAgeGate(PUBLIC), undefined)
})

test('BOTH KEYS ARE REQUIRED — neither alone is the gate', () => {
  assert.equal(instagramAgeGate('{"failure_reason":"MA"}'), undefined, 'no restricted_age')
  assert.equal(instagramAgeGate('{"restricted_age":25}'), undefined, 'no failure_reason')
  assert.equal(instagramAgeGate('{"failure_reason":"MA","restricted_age":25}'), 'age_restricted')
})

test("ONLY 'MA' IS CLAIMED — other failure_reasons fall through rather than being guessed at", () => {
  // 'MA' is the only value measured (n=2, one account). A wrong gate label is worse than a generic
  // one, so an unrecognised reason keeps today's behaviour.
  assert.equal(instagramAgeGate('{"failure_reason":"XX","restricted_age":25}'), undefined)
  assert.equal(instagramAgeGate('{"failure_reason":"MAYBE","restricted_age":25}'), undefined,
    'and the match is on the exact value, not a prefix')
})

test('geoblock_required IS A TRAP AND IS NOT USED', () => {
  /**
   * Meta reuses its GEO-gating transport for age gating: the oEmbed body's `message` literally reads
   * "geoblock_required" while `geo_block_rule_type` is null and the real reason is MIN_AGE_ACCOUNT.
   * Keying on `message` would ship a card claiming "region blocked" for an age wall.
   */
  assert.equal(instagramAgeGate('{"message":"geoblock_required","gating_type":"unappealable"}'), undefined,
    'the geo wording alone must never mint an age gate')
})

test('instagramAgeGate is TOTAL over junk', () => {
  for (const junk of [undefined, null, 0, {}, [], Buffer.from('x')]) {
    assert.equal(instagramAgeGate(junk), undefined, `${String(junk)} is undefined, not a throw`)
  }
  assert.equal(instagramAgeGate(''), undefined)
})

test('THE AGE GATE MUST BE CONSULTED BEFORE THE PRIVATE ONE', () => {
  /**
   * Order is load-bearing. A positive signal must be read before an inferential one — otherwise the
   * weaker rule answers first and its answer sticks, which is exactly how a public reel came to
   * render 🔒 from datacenter egress on 2026-07-26.
   *
   * On THIS page the private gate happens to return undefined, so the two do not currently collide.
   * That is luck, not design: it is true only because Instagram's age-gate page renders no username.
   * If that ever changes, this ordering is what keeps the label right, so it is pinned here rather
   * than left to be rediscovered.
   */
  assert.equal(instagramAgeGate(AGE_GATED), 'age_restricted')
  // A page carrying BOTH shapes must be reported as the age gate, which is only true if the age gate
  // is asked first — this is the assertion that fails if someone reorders worker.ts.
  const both = `${AGE_GATED}{"username":"someaccount"}`
  assert.equal(instagramPrivateGate(both), 'private', 'the private gate WOULD claim this page')
  assert.equal(instagramAgeGate(both), 'age_restricted', 'so the age gate has to win')
})

test('THE FULL-PAGE CARD STILL GOES FIRST — a page with media is not a wall', () => {
  /**
   * The og: card is consulted before either gate (worker.ts). This pins the whole precedence chain:
   * evidence-bearing card > positive gate > inferential gate.
   */
  assert.ok(instagramFullPageCard(PUBLIC, { p: 'ig', kind: 'p', code: 'DZghoo7PAzi' }),
    'a public page yields a card, so neither gate is ever consulted for it')
  assert.equal(instagramFullPageCard(AGE_GATED, { p: 'ig', kind: 'p', code: 'DZFDtEhoNPy' }), null,
    'and the age-gated page yields none — it carries zero og: tags')
})

test('THE LATENT LANDMINE: the private gate can claim a HEALTHY PUBLIC post', () => {
  /**
   * Found while fixing the above. instagramPrivateGate's rule — "a username with no
   * data-media-type" — is TRUE of some perfectly public pages, so it is a false 🔒 waiting for the
   * card in front of it to miss. That is not hypothetical: it is the 2026-07-26 production defect,
   * and it recurs whenever the og: card fails on a page that still names its owner.
   *
   * SCOPE, stated exactly, because an earlier draft of this test overclaimed and failed:
   *   - MEASURED LIVE 2026-07-28: /p/DbN6SsKum-9/ (a public reel by @fixture_user_10 that renders fine)
   *     has NO `data-media-type` and DOES carry `"username":"…"`, so the private gate returns
   *     'private' for it.
   *   - The committed PUBLIC fixture below (@fixture8.example) does NOT carry that username shape, so it
   *     cannot demonstrate the landmine. Asserting it against this fixture is what the earlier draft
   *     got wrong.
   * So the shape is pinned synthetically here, and the fixture is used only for what it does show.
   */
  const publicLooking = '<html>{"username":"fixture_user_10"}<div>a public post with no media marker</div></html>'
  assert.equal(instagramPrivateGate(publicLooking), 'private',
    'the inferential gate is WRONG about a page of this shape')
  assert.equal(instagramAgeGate(publicLooking), undefined,
    'and the age gate correctly declines it — it reasons from a positive field, not an absence')

  // What the committed fixture DOES show: the og: card is what stands between that rule and a user.
  assert.ok(instagramFullPageCard(PUBLIC, { p: 'ig', kind: 'p', code: 'DZghoo7PAzi' }),
    'a public page yields a card, so the private gate is never reached for it')
})
