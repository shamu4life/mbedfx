/**
 * THE ACCOUNT POOLS FOR AGE-GATED POSTS — reading them, and nothing else.
 *
 * Age gates are the one class of failure this project cannot degrade its way out of. Twitter's
 * TweetTombstone, Instagram's `failure_reason:MA`, and a YouTube video with `age_limit:18` and
 * `formats: 0` are all unreachable credential-free; that was measured on both egresses, and the
 * honest cards those produce are the correct answer WITHOUT accounts, not a bug to be fixed in the
 * fetchers. What changes the answer is being logged in, and nothing else does.
 *
 * WHY PLAINTEXT SECRETS RATHER THAN AN ENCRYPTED BUNDLE. FxEmbed keeps an AES-256-GCM blob decrypted
 * with a key at request time, and this project briefly declared `CREDENTIAL_KEY`/`CREDENTIAL_BUNDLE`
 * to match. That design exists because FxEmbed self-hosts, where the bundle sits on a disk somebody
 * else may read. Ours does not: a Cloudflare Worker secret is encrypted at rest, is not readable back
 * from the dashboard, and is not in the repo. Encrypting it again buys no attacker-resistance and
 * costs a key that has to live in exactly the same place as the thing it protects — plus a bespoke
 * encryption step every time an account is rotated, which is the step most likely to be skipped.
 *
 * ONE SECRET PER PLATFORM, each a JSON array, so the pool size is data rather than code and a third
 * account needs no deploy.
 *
 * WHAT MUST NEVER HAPPEN TO THESE VALUES, and it is the whole reason the reading is isolated in one
 * small module: a cookie or token must never reach a log line, an analytics blob, a card, an error
 * message, or a cache key. `count()` in analytics.ts takes only fixed enum strings, and the container
 * writes its cookie jar to a private temp file it deletes. Nothing here returns a value that is safe
 * to print, so nothing here should ever be handed to something that prints.
 */

/**
 * ONE ACCOUNT. Every field optional because the three platforms need different artifacts and a pool
 * is validated by its CONSUMER rather than here — see cookiesFor and twitterAccounts.
 *
 * `label` is the only field that is safe to log, and it exists for exactly that: rotating a dead
 * account requires knowing WHICH one died, and the alternative to a nickname is printing a token.
 */
export type Account = {
  /** A nickname for the operator. Never a credential; the only field safe to surface. */
  label?: string
  /** Netscape cookies.txt CONTENTS, for the platforms whose gate is beaten inside yt-dlp. */
  cookies?: string
  /** Twitter's session pair, for the gate that is beaten in the Worker instead. */
  auth_token?: string
  ct0?: string
}

/** The three pools, and the secret each is read from. */
export type CredentialEnv = {
  /** JSON array of Account. Twitter's gate is beaten in the WORKER (GraphQL), not the container. */
  X_ACCOUNTS?: string
  /** JSON array of Account. Instagram's gate is beaten inside yt-dlp, so these want `cookies`. */
  IG_ACCOUNTS?: string
  /** JSON array of Account. YouTube likewise — see container/server.py's cookie jar. */
  YT_ACCOUNTS?: string
}

export type CredentialPlatform = 'x' | 'ig' | 'yt'

const SECRET: Record<CredentialPlatform, keyof CredentialEnv> = {
  x: 'X_ACCOUNTS',
  ig: 'IG_ACCOUNTS',
  yt: 'YT_ACCOUNTS',
}

/**
 * PARSE A POOL, TOTALLY. Every failure is an empty pool, and that is a deliberate refusal to have an
 * opinion: a malformed secret means the age-gated posts keep producing the honest cards they produced
 * before anyone set it, which is exactly the behaviour of an unset secret.
 *
 * IT MUST NOT THROW, and this is the load-bearing property rather than a nicety. These pools are read
 * on the request path for ordinary posts too, so a stray comma in a secret nobody has looked at for a
 * month would otherwise 500 every card on the platform — turning a credential typo into an outage on
 * the one path that has nothing to do with credentials.
 *
 * A NON-ARRAY IS NOT COERCED. A bare object is a plausible thing to paste, and accepting it would
 * mean a pool of one that silently never rotates; refusing is louder, in the only way available here.
 */
export function parseAccounts(raw: unknown): Account[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Account[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined
    const acct: Account = {}
    const label = str(e.label)
    const cookies = str(e.cookies)
    const authToken = str(e.auth_token)
    const ct0 = str(e.ct0)
    if (label !== undefined) acct.label = label
    if (cookies !== undefined) acct.cookies = cookies
    if (authToken !== undefined) acct.auth_token = authToken
    if (ct0 !== undefined) acct.ct0 = ct0
    // An entry carrying no credential at all is not an account. Dropping it here keeps every
    // consumer from having to ask, and keeps `poolSize` honest about what is actually usable.
    if (acct.cookies || acct.auth_token) out.push(acct)
  }
  return out
}

/** The pool for one platform, straight from the secret. Empty when unset or unparseable. */
export const accountPool = (env: CredentialEnv, platform: CredentialPlatform): Account[] =>
  parseAccounts(env[SECRET[platform]])

/**
 * PICK ONE, AT RANDOM PER REQUEST, which is the entire reason a pool is a pool.
 *
 * Round-robin would need state the edge does not share between isolates, and picking the first would
 * put the whole load on one account — the fastest way to get that one account flagged, which costs
 * more than it saves. Random is stateless and spreads well enough at this volume.
 *
 * `pick` is injectable so tests can be deterministic without stubbing global Math.random, which in a
 * suite that runs files concurrently is a shared mutable nobody should be reaching for.
 */
export function pickAccount(pool: Account[], pick: () => number = Math.random): Account | null {
  if (pool.length === 0) return null
  if (pool.length === 1) return pool[0] ?? null
  const i = Math.floor(pick() * pool.length)
  // A pick() of exactly 1 (or a hostile stub) must not index off the end.
  return pool[Math.min(Math.max(i, 0), pool.length - 1)] ?? null
}

/**
 * THE COOKIE JAR FOR A CONTAINER CALL, or null when there is nothing to send.
 *
 * Only `ig` and `yt` can use this: their gates are beaten inside yt-dlp, so the credential has to
 * travel to the container. Twitter's is beaten in the Worker and must NOT be sent — shipping a
 * Twitter session to a subprocess that has no use for it is a pure widening of where it can leak.
 */
export function cookiesFor(
  env: CredentialEnv, platform: CredentialPlatform, pick: () => number = Math.random,
): string | null {
  if (platform === 'x') return null
  const account = pickAccount(accountPool(env, platform), pick)
  return account?.cookies ?? null
}

/** Accounts usable for Twitter's Worker-side path: a session pair, not a cookie jar. */
export const twitterAccounts = (env: CredentialEnv): Account[] =>
  accountPool(env, 'x').filter(a => !!a.auth_token && !!a.ct0)

/**
 * IS A POOL SET BUT UNUSABLE BY THE CODE THAT WOULD USE IT?
 *
 * The predicate this replaces (`credentialSeamArmed`) was written for exactly the right reason —
 * "a variable that looks live and is inert is worse than one that does not exist" — and then was
 * never called from anywhere, so it made nothing visible at all. This one is counted, in the arm that
 * would have used the credential, so filling a secret and seeing no change is a number rather than a
 * mystery.
 *
 * TRUE IS NOT AN ERROR. Twitter's pool is legitimately in this state right now: the secret can be
 * filled today, and the Worker-side GraphQL call that would spend it is a later phase. That is a
 * deliberate staging decision, and the counter is how it stays visible rather than being rediscovered.
 */
export const poolSetButUnused = (env: CredentialEnv, platform: CredentialPlatform): boolean =>
  accountPool(env, platform).length > 0
