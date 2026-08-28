/**
 * ===================================================================================================
 * ONE EXTRA ASK, SHARED — the difference between a bad minute and a permanently bad card.
 * ===================================================================================================
 *
 * WHAT THIS EXISTS FOR. Every platform fetcher in this repo asked its upstream exactly once, and a
 * single refused request produced a failure card. On the open web that would be a bad minute: the
 * reader re-pastes and gets the post. On Discord it is permanent — Discord stores the embed it built
 * INSIDE the message and does not re-unfurl a link it has already drawn (discord-api-docs#1663). The
 * first paste is the only paste, so a card lost to a 300ms hiccup stays lost for everyone who ever
 * scrolls past that message, and nobody re-pastes to heal it.
 *
 * THE FAILURE IT ANSWERS IS MEASURED, not theoretical. Reported 2026-08-28: a public Twitter video
 * post drew the "couldn't load" card here while a self-hosted rival drew the same id correctly,
 * minutes apart, from the same message. Measured that day from residential egress, BOTH of this
 * project's Twitter paths are healthy for that id — syndication answered a full Tweet with video 8
 * times out of 8, and the guest endpoint answered `__typename: Tweet` with `media: ['video']`. The
 * post is not sensitive, not protected and not deleted. Cloudflare's egress was simply refused once.
 * That is the same shape already measured on YouTube's Innertube endpoint, where ~40-50% of
 * Worker-egress calls are refused while every one of them answers perfectly from a residential IP in
 * the same minute — and where a SECOND attempt is exactly what lifted first-paste success from 0/14
 * to 9/10.
 *
 * WHY THE RETRY KEYS ON STATUS, WHICH LOOKS LIKE THE THING CLAUDE.md FORBIDS. It is not. "Assert on
 * content, never on status" governs whether we HAVE an answer, and that rule is untouched here: every
 * caller still runs its own classifier over the body, and a 200 carrying a login wall or a decoy is
 * still a failure. Status is consulted for a DIFFERENT question — is asking again worth one round
 * trip — and it is the only thing that can answer it. A 429 with an HTML body and a 404 with an HTML
 * body are byte-indistinguishable to a content check and want opposite treatment: the first is about
 * our request, the second is about the post.
 *
 * WHAT IS DELIBERATELY NOT RETRIED, because retrying the wrong thing is worse than not retrying:
 *
 *   - ANY 2xx/3xx/4xx that is not in the refusal list. This is the important one, and it is what
 *     keeps the cost bounded: a genuinely dead post answers with a real verdict at HTTP 200 (measured
 *     2026-08-28 on Twitter, a nonexistent id returns a parseable `TweetTombstone` reading "This Post
 *     is from an account that no longer exists"), so dead links still cost exactly one request.
 *   - Instagram's 599 KB decoy, TikTok's login wall, and every other 200-with-a-lie this repo has
 *     catalogued. A second ask returns the same lie. Those are the callers' classifiers' job.
 *   - Media probes and paginated walks inside a time budget. See the call sites left alone in
 *     src/platforms/instagram/fetch.ts and src/platforms/tiktok/fetch.ts, which say why in place.
 *
 * NO BACKOFF, DELIBERATELY. 200ms does not reset a rate-limit window, so a sleep buys nothing against
 * the case it appears to address, while adding latency to every failing card and to every test that
 * exercises these paths. The failure measured is per-REQUEST, not per-window: the very next request
 * out of the same colo succeeds.
 *
 * IF THIS IS EVER "SIMPLIFIED" AWAY, the regression is silent. Cards stop appearing for a fraction of
 * pastes, permanently, with nothing in the logs (Workers Logs are off on purpose — see
 * wrangler.jsonc) and nothing in the counters to tell it apart from a genuinely dead post.
 */

/** One extra ask, not a loop: two attempts total. A third would cost more deadline than it buys. */
export const ASK_ATTEMPTS = 2

/**
 * Does a verdict-less answer deserve one more round trip? PURE, so the policy is testable with no
 * network — the same discipline every `*Outcome` classifier in this repo keeps.
 *
 * True only for the statuses that mean "the endpoint refused THIS REQUEST", which is the case a
 * second ask can win: 429 (rate limited), 5xx (edge or origin trouble), 408/425 (the request itself
 * was dropped or replayed). False for everything else — notably 404, 403 and 410, which are answers
 * about the POST rather than about the request, and where asking twice would only double the cost of
 * every dead link anyone pastes.
 */
export function worthAskingAgain(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * `fetch`, asked a second time when the first attempt was REFUSED or threw. Drop-in: it returns the
 * Response un-consumed, so every caller's existing body handling and classifier are unchanged, and
 * swapping it in is a one-word edit at the call site.
 *
 * A THROWN FETCH IS RE-THROWN after the last attempt rather than swallowed. That preserves the
 * contract worker.ts depends on: a genuine transport failure (reset, DNS) stays a thrown error, which
 * becomes null / `fetch_fail` — a DIFFERENT signal from "the endpoint answered un-parseably"
 * (`assert_fail`), and one that is counted separately. This changes how many times we ask, never what
 * an answer means.
 *
 * The refused Response's body is CANCELLED before the retry. A Response whose body is never read and
 * never cancelled holds its stream open for the life of the request, and this path runs on every
 * refusal on every platform.
 */
export async function askTwice(input: string, init?: RequestInit): Promise<Response> {
  let thrown: unknown
  let threw = false
  for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt++) {
    const last = attempt === ASK_ATTEMPTS - 1
    try {
      const res = await fetch(input, init)
      if (last || !worthAskingAgain(res.status)) return res
      res.body?.cancel().catch(() => {})
    } catch (e) {
      // A reset or DNS failure is the most transient answer there is, and the one most worth asking
      // again. Remembered rather than rethrown here so a successful second ask still wins.
      if (last) throw e
      threw = true
      thrown = e
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt. Present so the function is
  // total to the type checker without an assertion that could mask a future edit.
  throw threw ? thrown : new Error('askTwice: no attempt was made')
}
