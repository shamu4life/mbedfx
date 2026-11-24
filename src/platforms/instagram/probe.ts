import { IG_GRAPHQL_DOC_ID, IG_WEB_APP_ID } from './fetch.ts'

/**
 * `/_igprobe`: WHICH INSTAGRAM GRAPHQL QUERY STILL ANSWERS FROM THIS WORKER'S EGRESS (2026-11-24).
 *
 * WHY IT EXISTS. `graphql_recovered` fell from 43-70 a day to zero on 2026-11-19 and stayed there, the
 * day `card_degraded` on `ig` went from 0 to 2-12 a day. The query this Worker sends
 * (fetchInstagramGraphQLMedia: /graphql/query/, PolarisPostRootQuery, doc_id IG_GRAPHQL_DOC_ID) is
 * documented as rotting. yt-dlp 2026.11.23 sends a different one: /api/graphql,
 * PolarisLoggedOutDesktopWWWPostRootContentQuery, `{media_id}` variables, doc_id 27130156389949648, after
 * a homepage load for the `lsd` token and the `csrftoken` cookie and a `get_ruling_for_content` check.
 * From the dev sandbox both answered "Rate limit exceeded", and CLAUDE.md is explicit that a laptop's
 * answer says nothing about a Worker's. So this asks both, from here, and reports what each step got.
 *
 * TAKES NO INPUT: the shortcode is the health check's own reel. Publishes no url, no token and no body,
 * only statuses, sizes, booleans and one short url-free message. Each run makes at most five requests
 * to Instagram, and the route caches its answer for five minutes so a loop cannot spend our egress.
 */

export const IG_PROBE_SHORTCODE = 'DZxLuleoEoC'
export const IG_NEW_DOC_ID = '27130156389949648'
const NEW_FRIENDLY = 'PolarisLoggedOutDesktopWWWPostRootContentQuery'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Instagram's shortcode is the media pk in base64url digits (yt-dlp _id_to_pk). */
export function shortcodeToPk(code: string): string {
  let n = 0n
  for (const ch of code) {
    const v = B64.indexOf(ch)
    if (v < 0) return ''
    n = n * 64n + BigInt(v)
  }
  return n.toString()
}

/** What a body is: `json`, `html` (the 540 KB login/decoy page answers 200), `empty` or `other`. */
export function bodyKind(text: string): string {
  const t = text.trimStart()
  if (!t) return 'empty'
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  return /^<(!doctype|html)/i.test(t) ? 'html' : 'other'
}

/** The first `"message":"..."`, without urls, 80 characters at most; "" when there is none. */
export function probeMessage(text: string): string {
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.){0,200})"/.exec(text)
  return m ? m[1].replace(/(?:https?:)?\/\/\S+/gi, '<url>').slice(0, 80) : ''
}

type Fetch = typeof fetch
interface Step { status: number; bytes: number; ms: number }

async function timed(f: Fetch, url: string, init: RequestInit): Promise<Step & { text: string; res: Response | null }> {
  const t0 = Date.now()
  try {
    const res = await f(url, { ...init, redirect: 'manual' })
    const text = await res.text()
    return { status: res.status, bytes: text.length, ms: Date.now() - t0, text, res }
  } catch {
    return { status: 0, bytes: 0, ms: Date.now() - t0, text: '', res: null }
  }
}

function lsdOf(html: string): string {
  const eqmc = /<script\b[^>]*\bid="__eqmc"[^>]*>(\{.*?\})<\/script>/s.exec(html)
  if (eqmc) {
    try {
      const l = (JSON.parse(eqmc[1]) as { l?: unknown }).l
      if (typeof l === 'string' && l) return l
    } catch { /* fall through to the older shape */ }
  }
  return /\["LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? ''
}

function csrfOf(res: Response | null): string {
  const all = res?.headers.get('set-cookie') ?? ''
  return /(?:^|[\s,;])csrftoken=([^;,\s]+)/.exec(all)?.[1] ?? ''
}

export async function probeInstagramGraphQL(f: Fetch = fetch): Promise<Record<string, unknown>> {
  const code = IG_PROBE_SHORTCODE
  const started = Date.now()

  // 1. THE QUERY THIS WORKER SENDS TODAY, exactly as fetchInstagramGraphQLMedia builds it, asked once.
  const lsd1 = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join('')
  const old = await timed(f, 'https://www.instagram.com/graphql/query/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0',
      'x-fb-friendly-name': 'PolarisPostRootQuery', 'x-fb-lsd': lsd1 },
    body: new URLSearchParams({ doc_id: IG_GRAPHQL_DOC_ID, lsd: lsd1, server_timestamps: 'true',
      variables: JSON.stringify({ shortcode: code, __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false }) }),
  })
  const oldRow = {
    docId: IG_GRAPHQL_DOC_ID, status: old.status, bytes: old.bytes, ms: old.ms, kind: bodyKind(old.text),
    root: /"xdt_api__v1__media__shortcode__web_info"\s*:\s*\{/.test(old.text),
    video: /"video_versions"\s*:\s*\[\s*\{/.test(old.text), message: probeMessage(old.text),
  }

  // 2-4. yt-dlp 2026.11.23's logged-out path, step by step.
  const pk = shortcodeToPk(code)
  const api = { 'x-ig-app-id': IG_WEB_APP_ID, 'x-asbd-id': '359341', 'x-ig-www-claim': '0',
    origin: 'https://www.instagram.com', accept: '*/*', 'user-agent': UA }
  const home = await timed(f, 'https://www.instagram.com/', { headers: { 'user-agent': UA, accept: 'text/html' } })
  const lsd = lsdOf(home.text)
  const csrf = csrfOf(home.res)
  const cookie = csrf ? `csrftoken=${csrf}` : ''
  const ruling = await timed(f, `https://www.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${pk}`,
    { headers: { ...api, ...(cookie ? { cookie } : {}) } })
  const rulingOk = /"status"\s*:\s*"ok"/.test(ruling.text)
  const gql = await timed(f, 'https://www.instagram.com/api/graphql', {
    method: 'POST',
    headers: { ...api, 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': NEW_FRIENDLY,
      ...(csrf && rulingOk ? { 'x-csrftoken': csrf } : {}), 'x-fb-lsd': lsd, 'x-requested-with': 'XMLHttpRequest',
      referer: `https://www.instagram.com/reel/${code}/`, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ lsd, fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: NEW_FRIENDLY,
      server_timestamps: 'true', variables: JSON.stringify({ media_id: pk }), doc_id: IG_NEW_DOC_ID }),
  })
  const newRow = {
    docId: IG_NEW_DOC_ID,
    home: { status: home.status, bytes: home.bytes, ms: home.ms, lsd: !!lsd, csrf: !!csrf },
    ruling: { status: ruling.status, ms: ruling.ms, kind: bodyKind(ruling.text), ok: rulingOk, message: probeMessage(ruling.text) },
    graphql: { status: gql.status, bytes: gql.bytes, ms: gql.ms, kind: bodyKind(gql.text),
      root: /"xig_polaris_media"\s*:\s*\{/.test(gql.text),
      notGated: /"if_not_gated_logged_out"\s*:\s*\{/.test(gql.text),
      video: /"video_versions"\s*:\s*\[\s*\{/.test(gql.text), message: probeMessage(gql.text) },
  }
  return { shortcode: code, ms: Date.now() - started, old: oldRow, new: newRow }
}
