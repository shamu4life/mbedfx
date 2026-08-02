import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  clipDimensions, normalizeTwitchClip, pickRendition, signedClipUrl, twitchSensitive,
} from '../src/platforms/twitch/normalize.ts'
import { twitchForbidden } from '../src/platforms/twitch/fetch.ts'
import { twitchMediaHost, proxyableVideoUrl } from '../src/mediaproxy.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'

/**
 * TWITCH CLIPS — the platform's whole surface, and why it is clips and nothing else.
 *
 * Measured 2026-07-27 against the live public GraphQL endpoint. A clip is the ONE Twitch object that
 * yields a real progressive mp4: `videoQualities[].sourceURL` is a faststart ISO-BMFF file
 * (`ftypisom…iso2avc1mp41`, `moov` at offset 0x28) that Discord can play natively. A VOD is HLS with
 * no progressive fallback, and a live channel is a state rather than a post — both are named as out
 * of scope in the PostRef arm rather than left looking forgotten.
 *
 * ONE UNAUTHENTICATED CALL CARRIES EVERYTHING: metadata, the rendition list AND the playback token.
 * That is why this platform needs no container and no stored credential — unlike Twitter, whose
 * equivalent surface genuinely does.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => JSON.parse(readFileSync(new URL(n, F), 'utf8')).data.clip

const CLIP = load('twitch-clip.json')                 // xQc, 44s, curator != broadcaster
const NASA = load('twitch-clip-nocurator.json')       // NASA, curator: null (2.4% of clips)
const MATURE = load('twitch-clip-maturegame.json')    // auronplay, labels: ['MatureGame']
const MISSING = load('twitch-clip-missing.json')      // the measured miss shape

const REF = { p: 'tw', kind: 'clip', slug: 'DeliciousDelightfulPicklesWOOP' }

/** The fetcher's shape, rebuilt from a captured payload so the normalizer tests need no network. */
const asClip = d => ({
  slug: d.slug,
  title: d.title,
  createdAt: d.createdAt,
  durationSeconds: d.durationSeconds,
  viewCount: d.viewCount,
  thumbnailURL: d.thumbnailURL,
  labels: d.contentClassificationLabels.map(l => l.id),
  broadcaster: d.broadcaster,
  curator: d.curator,
  game: d.game,
  videoQualities: d.videoQualities,
  playbackAccessToken: d.playbackAccessToken,
})

test('THE MISS SHAPE IS HTTP 200 WITH data.clip NULL — assert on content, never on status', () => {
  /**
   * Measured on a nonexistent slug, an EMPTY slug and a path-traversal string: all three answer
   * HTTP 200 with `{"data":{"clip":null}}` and NO `errors` array. So liveness is `data.clip` being an
   * object carrying its own slug, and a status check would pass on every one of them.
   */
  assert.equal(MISSING, null, 'the captured miss really is a null clip at HTTP 200')
})

test('a real clip normalizes to a PLAYABLE video with a poster', () => {
  const post = normalizeTwitchClip(asClip(CLIP), REF)
  assert.equal(post.author.handle, 'xqc')
  assert.equal(post.author.name, 'xQc', 'displayName, not the login')
  assert.equal(post.title, 'xqc makes the wrong choice')
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'video')
  // A posterless video drops Discord's rich card back to plain OpenGraph (types.ts, Media.poster).
  assert.ok(post.media[0].poster, 'a poster is mandatory on a video')
  assert.match(post.media[0].poster, /^https:\/\/static-cdn\.jtvnw\.net\//)
  assert.equal(post.media[0].duration, 44)
  assert.equal(post.canonical, 'https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP')
  assert.equal(post.counts.views, 948422)
})

test('THE RENDITION IS 720, AND THE NUMBER IS MEASURED RATHER THAN TASTE', () => {
  /**
   * Full sizes of this exact clip (44 seconds), 2026-07-27:
   *     1080p  44,778,948   720p  14,054,837   480p  4,225,487   360p  3,274,116
   * 1080p is 3.2x the bytes of 720p. mediaproxy.ts records what a 38MB file did on the Instagram
   * path — Discord drew NO CARD AT ALL — and while Twitch's CDN behaves better (it advertises
   * accept-ranges and the mp4 is faststart), 44MB to preview a joke clip is the wrong default.
   */
  const r = pickRendition(CLIP.videoQualities)
  assert.equal(r.quality, '720', 'the highest at or below 720, not the first Twitch listed (1080)')
})

test('pickRendition FALLS BACK DOWNWARD, never off the end', () => {
  // A clip captured at 480 offers no 720 at all, so an exact '720' match would find nothing. And a
  // hypothetical clip offering only 1080 must still render rather than returning null.
  assert.equal(pickRendition([{ quality: '480', sourceURL: 'https://a1b2c3d4e5.cloudfront.net/x.mp4' }]).quality, '480')
  assert.equal(pickRendition([{ quality: '1080', sourceURL: 'https://a1b2c3d4e5.cloudfront.net/x.mp4' }]).quality, '1080',
    'every rendition above the cap -> the lowest available, not null')
  assert.equal(pickRendition([]), null)
  assert.equal(pickRendition([{ quality: 'chunked', sourceURL: '' }]), null, 'no url is not a rendition')
})

test('THE SIGNED URL IS THE ONLY ONE THAT PLAYS — unsigned is 401 on every rendition', () => {
  /**
   * Measured on 1080/720/480/360 of a healthy public clip: bare sourceURL -> HTTP 401 with a
   * zero-length body from CloudFront's Lambda@Edge; the signed form -> 206 with a real content-range.
   * ONE SIGNATURE COVERS EVERY RENDITION — the token's embedded `clip_uri` names the 360 file, which
   * reads as if it were scoped to it, and it is not.
   */
  const r = pickRendition(CLIP.videoQualities)
  const url = signedClipUrl(r.sourceURL, CLIP.playbackAccessToken)
  assert.ok(url.startsWith(r.sourceURL + '?'), 'the source url is preserved verbatim')
  const q = new URL(url).searchParams
  assert.equal(q.get('sig'), CLIP.playbackAccessToken.signature)
  // The token VALUE is a JSON document (braces, quotes, colons) going into a query parameter, so it
  // must round-trip through percent-encoding intact — a raw interpolation corrupts it.
  assert.equal(q.get('token'), CLIP.playbackAccessToken.value)
  assert.doesNotThrow(() => JSON.parse(q.get('token')), 'the token survives as parseable JSON')
})

test('signedClipUrl REFUSES an off-fleet or non-https source — it feeds a byte proxy', () => {
  const tok = CLIP.playbackAccessToken
  for (const bad of [
    'http://d1ndex63qxojbr.cloudfront.net/x.mp4',              // not https
    'https://evil.example/x.mp4',                              // foreign host
    'https://evil.example.cloudfront.net/x.mp4',               // deeper label under the parent
    'https://production.assets.clips.twitchcdn.net/x.mp4',     // the TOMBSTONE host, see below
  ]) {
    assert.equal(signedClipUrl(bad, tok), null, `${bad} is refused`)
  }
  assert.equal(signedClipUrl(CLIP.videoQualities[0].sourceURL, null), null, 'no token, no url')
})

test('THE TOMBSTONE HOST IS EXCLUDED, AND THAT EXCLUSION IS THE DETECTOR', () => {
  /**
   * A 1015-clip census found `sourceURL` on exactly two hosts: `d1ndex63qxojbr.cloudfront.net`
   * (1003, live) and `production.assets.clips.twitchcdn.net` (12, DEAD — unsigned 404, signed 403
   * with an S3 AccessDenied body, thumbnails 302 to Twitch's own 404_preview.jpg). Blind random
   * n=120 correlated host to liveness at 100%.
   *
   * THE METADATA CANNOT TELL THEM APART. Those twelve return a complete healthy payload — title,
   * broadcaster, game, `isPublished: true`, and a token whose `authorization.forbidden` is FALSE.
   * The host is the only signal there is, which is why the allowlist is narrow enough to exclude it.
   */
  assert.equal(twitchMediaHost('https://d1ndex63qxojbr.cloudfront.net/nauth/x/1080/index.mp4'), true)
  assert.equal(twitchMediaHost('https://production.assets.clips.twitchcdn.net/x.mp4'), false,
    'the tombstone fleet is refused BY HOST — it is indistinguishable any other way')
  // Not pinned to the current label: it is autogenerated and Twitch can reprovision it.
  assert.equal(twitchMediaHost('https://zzzz1111aaaa.cloudfront.net/x.mp4'), true, 'the SHAPE, not the label')
  // But not the parent, which would admit most of the CDN-hosted internet.
  assert.equal(twitchMediaHost('https://cloudfront.net/x.mp4'), false)
  assert.equal(twitchMediaHost('https://attacker.d1ndex63qxojbr.cloudfront.net/x.mp4'), false, 'no deeper labels')
  for (const junk of [null, undefined, 42, '', 'not a url', 'javascript:alert(1)']) {
    assert.equal(twitchMediaHost(junk), false, `${JSON.stringify(junk)} is not a host`)
  }
})

test('A TOMBSTONED CLIP RENDERS A TEXT CARD, NOT A BROKEN IMAGE', () => {
  /**
   * The degradation that matters. On these clips the THUMBNAIL IS DEAD TOO (it 302s to Twitch's
   * 404_preview.jpg), so falling back to the cover — which is what every other "can't play it" path
   * here does — would render a grey Twitch placeholder and read as OUR bug. The title, broadcaster,
   * game and view count are all still real, so a media-less card is the honest answer.
   *
   * SYNTHETIC, and it says so: the twelve tombstoned clips found in the census were not captured, so
   * this rewrites a real payload's rendition host to the measured dead one. It pins the RULE.
   */
  const dead = asClip(CLIP)
  dead.videoQualities = CLIP.videoQualities.map(q => ({
    ...q,
    sourceURL: q.sourceURL.replace(/^https:\/\/[^/]+/, 'https://production.assets.clips.twitchcdn.net'),
  }))
  const post = normalizeTwitchClip(dead, REF)
  assert.equal(post.media.length, 0, 'no video, and NO dead cover either')
  assert.equal(post.title, 'xqc makes the wrong choice', 'the metadata is real and survives')
  assert.equal(post.author.handle, 'xqc')
})

test('NO TOKEN BUT A LIVE FLEET DEGRADES TO THE COVER — the other half of that distinction', () => {
  // Both cases produce a null url; collapsing them would either lose a good cover (here) or ship a
  // broken one (above). This is why the normalizer reads the rendition HOST, not just the url result.
  const noToken = { ...asClip(CLIP), playbackAccessToken: null }
  const post = normalizeTwitchClip(noToken, REF)
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'image', 'the cover, because the thumbnail is live here')
  assert.match(post.media[0].url, /^https:\/\/static-cdn\.jtvnw\.net\//)
})

test('DIMENSIONS ARE DERIVED FROM THE THUMBNAIL, NOT ASSUMED 16:9', () => {
  /**
   * `videoQualities[].quality` is a HEIGHT ('720') and the payload states no width anywhere. The
   * thumbnail url does, in its filename: `…-1920x1080.jpg`. Portrait clips exist (Twitch has had
   * mobile broadcasting since 2019, and 48% of sampled clips carry a RECOMPOSED portrait asset), so
   * hardcoding 16:9 would letterbox them — Discord sizes its player from these numbers.
   */
  assert.deepEqual(clipDimensions('720', 'https://x/thumb-0000000000-1920x1080.jpg'), { w: 1280, h: 720 })
  assert.deepEqual(clipDimensions('1080', 'https://x/thumb-0000000000-1920x1080.jpg'), { w: 1920, h: 1080 })
  // A portrait asset: 1080x1920 is 9:16, so a 720-high rendition is 405 wide, not 1280.
  assert.deepEqual(clipDimensions('720', 'https://x/thumb-0000000000-1080x1920.jpg'), { w: 405, h: 720 })
  // No dimensions in the name -> 16:9, the honest default for a platform whose desktop broadcast is.
  assert.deepEqual(clipDimensions('720', 'https://x/thumb.jpg'), { w: 1280, h: 720 })
  assert.deepEqual(clipDimensions('nonsense', 'https://x/thumb.jpg'), { w: 1280, h: 720 })
})

test('MatureGame IS NOT SPOILERED, AND THAT IS A MEASUREMENT', () => {
  /**
   * Scanned 1154 clips across the 30 channels live at the time (2026-07-27): 176 carried a label, and
   * EVERY ONE of the 176 was `MatureGame` — 15% of all clips, i.e. one in seven. Mapping it to
   * `sensitive` would spoiler one Twitch clip in seven in Discord and make the flag meaningless.
   *
   * The fixture is a real `MatureGame` clip (auronplay, GTA V), so this is the measured negative.
   */
  assert.deepEqual(MATURE.contentClassificationLabels.map(l => l.id), ['MatureGame'], 'the fixture really is labelled')
  assert.equal(normalizeTwitchClip(asClip(MATURE), REF).sensitive, false, 'labelled, but not spoilered')
})

test('SexualThemes and DrugsIntoxication ARE spoilered — the two that match every other platform', () => {
  /**
   * SYNTHETIC, and it says so. 1154 live clips yielded zero of either label, so no real payload was
   * captured; the workflow probe saw both in a wider 48-channel sweep, so the ids are real. This pins
   * the MAPPING RULE, not a capture — and the rule is what the other four exclusions are argued
   * against in SENSITIVE_LABELS.
   */
  assert.equal(twitchSensitive(['SexualThemes']), true)
  assert.equal(twitchSensitive(['DrugsIntoxication']), true)
  assert.equal(twitchSensitive(['MatureGame', 'SexualThemes']), true, 'labels stack; one match is enough')
  for (const advisory of ['MatureGame', 'ProfanityVulgarity', 'DebatedSocialIssuesAndPolitics', 'Gambling']) {
    assert.equal(twitchSensitive([advisory]), false, `${advisory} is advisory, not a content warning`)
  }
  assert.equal(twitchSensitive([]), false)
})

test('twitchForbidden reads a POSITIVE refusal, and is total over junk', () => {
  /**
   * The token's `value` is a JSON *string* carrying `authorization: {forbidden, reason}`. Reading it
   * is a positive signal off Twitch's own payload rather than an inference from a missing rendition —
   * the distinction behind Instagram's false-🔒 defect.
   *
   * NOT VERIFIED AGAINST A REAL REFUSAL. Every clip measured (and every clip the workflow probe
   * sampled, including labelled ones) returned `forbidden: false`; no genuinely forbidden clip was
   * ever found, so the TRUE branch is pinned synthetically and the mapping to 🔞 is unproven live.
   */
  assert.equal(twitchForbidden(CLIP.playbackAccessToken), false, 'the real healthy token')
  assert.equal(twitchForbidden({ value: JSON.stringify({ authorization: { forbidden: true, reason: 'x' } }) }), true)
  for (const bad of [null, undefined, {}, { value: '' }, { value: 'not json' }, { value: '{}' }, { value: '[]' }, 42]) {
    assert.equal(twitchForbidden(bad), false, `${JSON.stringify(bad)} reports no gate`)
  }
  // The field must be read strictly: a truthy string must not become a refusal.
  assert.equal(twitchForbidden({ value: JSON.stringify({ authorization: { forbidden: 'false' } }) }), false)
})

test('A NULL CURATOR IS 2.4% OF CLIPS AND MUST NOT CRASH OR INVENT A NAME', () => {
  const post = normalizeTwitchClip(asClip(NASA), REF)
  assert.equal(NASA.curator, null, 'the fixture really has no curator')
  assert.equal(post.author.handle, 'nasa')
  assert.ok(!/Clipped by/.test(post.text), 'no curator, no credit line')
})

test('THE CURATOR IS CREDITED ONLY WHEN THEY ARE NOT THE BROADCASTER', () => {
  const post = normalizeTwitchClip(asClip(CLIP), REF)
  assert.match(post.text, /Clipped by sopranohh/, 'Twitch itself credits this under "Clipped by"')
  assert.match(post.text, /Cyberpunk 2077/, 'and the game, which a clip title usually omits')
  const self = asClip(CLIP)
  self.curator = { login: 'xqc', displayName: 'xQc' }
  assert.ok(!/Clipped by/.test(normalizeTwitchClip(self, REF).text), 'self-clips credit nobody')
})

test('THE REF ROUND-TRIPS — refKey -> parseRefKey, or /_media/ 404s silently', () => {
  /**
   * cache.ts::isValidRef validates a cached record by refKey -> parseRefKey -> compare, so a ref this
   * project can MINT but not PARSE would deserialize as null on every read: every request re-fetching,
   * with nothing anywhere reporting it. refkey.ts states the rule; this pins it for 'tw'.
   */
  const key = refKey(REF)
  assert.equal(key, 'tw:clip:DeliciousDelightfulPicklesWOOP')
  assert.deepEqual(parseRefKey(key), REF)
  // Slugs are CASE-SENSITIVE upstream (measured: the lowercased slug returns null), so the key must
  // not normalize case.
  const upper = { p: 'tw', kind: 'clip', slug: 'DELICIOUSdelightful' }
  assert.deepEqual(parseRefKey(refKey(upper)), upper)
  // And a slug carrying the delimiter or junk must not deserialize into a different ref.
  for (const bad of ['tw', 'tw:clip', 'tw:clip:', 'tw:video:abc', 'tw:clip:a', 'tw:clip:x:y']) {
    assert.equal(parseRefKey(bad), null, `${bad} must not parse`)
  }
})

test('THE VIDEO IS PROXIED, NOT 302-ED — because the CDN mislabels a real mp4', () => {
  /**
   * Measured on all four renditions: `content-type: binary/octet-stream` for a file whose first bytes
   * are `ftypisom…iso2avc1mp41`. A 302 hands Discord that label and nothing of ours can correct it.
   * Independently, the bytes live under `/nauth/` and 401 without the token, so fetching them
   * ourselves keeps the request on the same egress that minted it.
   */
  const post = normalizeTwitchClip(asClip(CLIP), REF)
  assert.ok(proxyableVideoUrl(post, 0), 'a Twitch clip video is served by us, not redirected to')
  // Images keep the 302 — the media route deliberately does not proxy them.
  assert.equal(proxyableVideoUrl(post, 'avatar'), null)
  assert.equal(proxyableVideoUrl(post, { poster: 0 }), null)
  // And a post whose ref is not ours must not borrow the Twitch decision.
  assert.equal(proxyableVideoUrl({ ...post, ref: { p: 'rd', sub: 'a', id: 'b' } }, 0), null)
})

test('normalizeTwitchClip is TOTAL over a payload with holes', () => {
  // Every optional field absent at once: no game, no curator, no token, no thumbnail, no views.
  const bare = {
    slug: 'x', title: '', createdAt: '', durationSeconds: 0, viewCount: 0, thumbnailURL: '',
    labels: [], broadcaster: { login: 'a', displayName: '', profileImageURL: '' },
    curator: null, game: null, videoQualities: [], playbackAccessToken: null,
  }
  const post = normalizeTwitchClip(bare, REF)
  assert.equal(post.media.length, 0)
  assert.equal(post.text, '')
  assert.equal(post.title, undefined, 'an empty title is absent, not an empty bold block')
  assert.equal(post.counts.views, undefined)
  assert.ok(!post.author.avatar, 'no avatar rather than an empty one')
  // createdAt is a required Date and must be formattable — render/mastodon.ts calls toISOString() on
  // it, and an Invalid Date there is a 500 on the activity route.
  assert.doesNotThrow(() => post.createdAt.toISOString())
})
