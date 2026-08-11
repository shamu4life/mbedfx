import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardVerdict, runSmoke, smokeOutcome, SMOKE_CHECKS } from '../src/smoke.ts'

/**
 * THE OUTAGE NOBODY NOTICED, which is what this detector is for.
 *
 * Facebook embeds were completely broken for up to a week — Meta walled the post surfaces from
 * datacenter egress between 2026-08-01 and 2026-08-08 — and the way it was discovered was the OWNER
 * pasting a link and seeing a failure card. The counters would have shown it to anyone who went
 * looking; nobody had a reason to look.
 *
 * The rule these pin is the one the whole service turns on: ASSERT ON CONTENT, NEVER ON STATUS. Every
 * interesting failure here answers HTTP 200 — the failure card is a 200, Meta's login wall is a 200,
 * TikTok's 404 page is a 200 — so a monitor that watched status codes would have reported perfect
 * health for the entire week Facebook was down.
 */

const REAL_MEDIA_CARD = '<html><head>'
  + '<meta property="og:title" content="Someone (@someone)"/>'
  + '<meta property="og:description" content="a caption"/>'
  + '<link rel="alternate" type="application/activity+json" href="https://mbedfx.app/users/x/statuses/1"/>'
  + '</head><body></body></html>'

const REAL_IMAGE_CARD = '<html><head>'
  + '<meta property="og:title" content="Someone (@someone)"/>'
  + '<meta property="og:image" content="https://scontent.cdninstagram.com/x.jpg"/>'
  + '</head><body></body></html>'

/** The exact shape render/fail.ts emits, which is the thing being detected. */
const FAILURE_CARD = '<html><head>'
  + '<meta property="og:title" content="Couldn\'t load this Facebook post"/>'
  + '<meta property="og:description" content="It may be private, removed, or unavailable."/>'
  + '<meta name="theme-color" content="#657786"/>'
  + '</head><body></body></html>'

test('THE FAILURE CARD IS CAUGHT, and it answers 200 with a title like any healthy card', () => {
  // This is the whole point. A monitor that checked status, or merely checked that og:title exists,
  // would have called the week Facebook was down a week of perfect health.
  assert.equal(cardVerdict(FAILURE_CARD), 'failure-card')
  assert.equal(smokeOutcome(cardVerdict(FAILURE_CARD)), 'smoke_fail')
})

test('BOTH HEALTHY HEAD SHAPES PASS — a media post deliberately carries NO og:image', () => {
  // render/discord.ts forbids og:image on a post WITH media, because Discord draws that from the
  // Mastodon-shaped document behind the activity link instead. A check that required og:image would
  // fail every working video post on the service, which is the opposite of useful.
  assert.equal(cardVerdict(REAL_MEDIA_CARD), 'ok')
  assert.equal(cardVerdict(REAL_IMAGE_CARD), 'ok')
})

test('cardVerdict IS TOTAL OVER JUNK — a monitor must not throw on a bad answer', () => {
  // It runs unattended on a timer. A throw here is an alert nobody receives.
  for (const bad of [null, undefined, 42, '', {}, [], '<html></html>', '<!doctype html>']) {
    assert.equal(cardVerdict(bad), 'no-card', `${JSON.stringify(bad)} is not a card`)
  }
})

test('EVERY CHECK IS RUN AND EACH VERDICT IS REPORTED, so one broken platform cannot mask another', () => {
  // Not `Promise.all` with a throwing member, and not a loop that stops at the first failure: the
  // question is which platforms are broken, not whether any is.
  const seen = []
  const render = async (u) => {
    seen.push(u)
    return new Response(u.includes('/WYFF4/') ? FAILURE_CARD : REAL_MEDIA_CARD, { status: 200 })
  }
  return runSmoke('https://mbedfx.app', render).then(results => {
    assert.equal(results.length, SMOKE_CHECKS.length, 'every check ran')
    assert.equal(seen.length, SMOKE_CHECKS.length)
    const fb = results.find(r => r.platform === 'fb')
    assert.equal(fb.verdict, 'failure-card', 'the broken platform is named')
    assert.ok(results.filter(r => r.platform !== 'fb').every(r => r.verdict === 'ok'),
      'and the healthy ones are still reported as healthy')
  })
})

test('A RENDER THAT THROWS IS A FAILED CHECK, not a dead run', () => {
  // An upstream that hangs up mid-render is exactly the kind of outage this exists to catch, so a
  // throw must be counted rather than propagated.
  let calls = 0
  const render = async () => { calls++; throw new Error('connection reset') }
  return runSmoke('https://mbedfx.app', render).then(results => {
    assert.equal(calls, SMOKE_CHECKS.length, 'it kept going after the first throw')
    assert.ok(results.every(r => r.verdict === 'threw'))
    assert.ok(results.every(r => smokeOutcome(r.verdict) === 'smoke_fail'))
  })
})

test('THE CHECK LIST TAKES NO INPUT, which is what makes the endpoint safe to expose', () => {
  /**
   * `/_smoke` renders these paths and nothing else. The property that keeps it from being an open
   * fetch relay wearing a monitoring badge is that a caller cannot influence the target: the paths
   * are constants and the origin is the request's own. A future version that accepted `?url=` would
   * hand the internet a proxy on our egress, which reaches surfaces a stranger's IP cannot.
   */
  for (const c of SMOKE_CHECKS) {
    assert.ok(c.path.startsWith('/'), 'a check is a PATH on our own origin, never a url')
    assert.ok(!/^https?:/i.test(c.path), 'and never an absolute url')
    assert.ok(!c.path.includes('..'), 'and cannot traverse')
    assert.match(c.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, 'each entry records when it was last seen working')
  }
  assert.ok(SMOKE_CHECKS.length >= 4, 'a detector covering one platform is not a detector')
})
