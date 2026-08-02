import type { PostRef } from '../../types.ts'

const API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread'

/**
 * Bluesky's public AT Protocol: no auth, no anti-bot, no rate wall.
 * The only non-adversarial platform of the six.
 */
export async function fetchBluesky(ref: Extract<PostRef, { p: 'bs' }>): Promise<unknown> {
  const uri = `at://${ref.handle}/app.bsky.feed.post/${ref.rkey}`
  const url = `${API}?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=1`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) return null
  // Never JSON.parse an unvalidated body — platforms return HTML error pages with 200s.
  if (!(res.headers.get('content-type') || '').includes('json')) return null
  return res.json()
}
