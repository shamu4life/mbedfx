/**
 * THE POSTS AND REQUESTS BEHIND test/fixtures/gallery-card-goldens.json, the byte-identity evidence for the
 * gallery card (src/render/componentembed.ts, 2026-11-26).
 *
 * The goldens were rendered ONCE, from origin/main at f449bb5, the commit before the gallery card existed,
 * by feeding every case below through that commit's handle() (or render(), for the one shape handle()
 * cannot produce). They are the heads, documents and oEmbed answers as they stood before this change.
 * test/gallery-card.test.mjs renders the same cases with today's code and holds every answer to its golden:
 * byte for byte where the post does not qualify, and byte for byte less exactly one component-embed script
 * where it does.
 *
 * NEVER REGENERATE THE GOLDENS TO MAKE A RED TEST PASS. A golden that moves with the code proves nothing.
 * If a later change is meant to alter one of these answers, rewrite that case's assertion in the test and
 * say why, as CLAUDE.md asks of every test that pinned old behaviour. Adding a case is fine only if its
 * golden is rendered from f449bb5 too (git worktree add, then the same loop); otherwise the case belongs
 * in the test file with its expectation written out.
 *
 * Every post is a function of the ref the router gave its path, so a case's post carries exactly the ref
 * its own urls are minted from. Dates are fixed, the network is never touched, and each case has its own
 * id, so no cache or in-flight map is shared between cases.
 */
export const ORIGIN = 'https://staging.megapenispoopenfarten.sex'
export const GUEST = 'https://guest.example'
export const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
export const TELEGRAM = 'TelegramBot (like TwitterBot)'
export const SLACK = 'Slackbot-LinkExpanding 1.0'
export const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const when = new Date('2026-10-30T18:00:00Z')
const img = (base, i, extra = {}) => ({ kind: 'image', url: `${base}/${i}.jpg`, w: 1080, h: 1350, ...extra })
const images = (base, n, extra = i => ({})) => Array.from({ length: n }, (_, i) => img(base, i, extra(i)))

const author = (name, handle, url, avatar = `${url}/avatar.jpg`) => ({ name, handle, url, avatar })

/** Shaped like /profile/bsky.app/post/3myx7vphq3s2j, one of the two cards the owner approved on 2026-11-26. */
const bsFour = ref => ({
  ref,
  canonical: `https://bsky.app/profile/bsky.app/post/${ref.rkey}`,
  author: author('Bluesky', 'bsky.app', 'https://bsky.app/profile/bsky.app'),
  text: 'getting our Halloween decorations set up',
  createdAt: when,
  media: [0, 1, 2, 3].map(i => img('https://cdn.bsky.app/img/feed_fullsize/plain/did', i, { alt: `Gravestone ${i}\n\n"Remember websites?"` })),
  counts: { likes: 3800, replies: 232, reposts: 413 },
  sensitive: false,
})

/** Shaped like /X/status/2102147636702634195, the other card the owner approved on 2026-11-26. */
const xVideo = ref => ({
  ref,
  canonical: `https://x.com/X/status/${ref.id}`,
  author: author('X', 'X', 'https://x.com/X', 'https://pbs.twimg.com/profile_images/1/x.jpg'),
  text: 'timeline. ticker. trade. https://t.co/1ufRfdiYpS',
  createdAt: new Date('2026-09-21T21:27:07Z'),
  media: [{ kind: 'video', url: 'https://video.twimg.com/amplify_video/1/vid/x.mp4', w: 1920, h: 1080, poster: 'https://pbs.twimg.com/1.jpg' }],
  counts: { likes: 14700, replies: 1700, reposts: 2100 },
  sensitive: false,
})

const bsText = ref => ({
  ref,
  canonical: `https://bsky.app/profile/bsky.app/post/${ref.rkey}`,
  author: author('Bluesky', 'bsky.app', 'https://bsky.app/profile/bsky.app'),
  text: 'a post with no pictures at all',
  createdAt: when,
  media: [],
  counts: { likes: 12 },
  sensitive: false,
})

const bsOne = ref => ({ ...bsText(ref), text: 'one picture', media: [img('https://cdn.bsky.app/img/one', 0)] })

/** Own media under five, a quote's hoisted in behind it: today's activity gallery holds five. */
const bsQuoteHoist = ref => ({
  ...bsText(ref),
  text: 'two of mine, three of theirs',
  media: images('https://cdn.bsky.app/img/own', 2),
  quote: {
    ref: { p: 'bs', handle: 'other.bsky.social', rkey: '3galquoted01' },
    canonical: 'https://bsky.app/profile/other.bsky.social/post/3galquoted01',
    author: author('Other', 'other.bsky.social', 'https://bsky.app/profile/other.bsky.social'),
    text: 'the quoted post',
    createdAt: when,
    media: images('https://cdn.bsky.app/img/quoted', 3),
    counts: {},
    sensitive: false,
  },
})

const igBase = ref => ({
  ref,
  canonical: `https://www.instagram.com/p/${ref.code}/`,
  author: author('Example Gallery', 'example.gallery', 'https://www.instagram.com/example.gallery/'),
  createdAt: when,
  counts: { likes: 20900, replies: 82 },
  sensitive: false,
})

/** Nine pictures with alt text on three, and a caption carrying the characters Discord markdown reads. */
const igNine = ref => ({
  ...igBase(ref),
  text: 'nine frames from the *weekend* trip_2026 [day one] #film\n\nshot on a 50mm, more soon',
  media: images('https://scontent.cdninstagram.com/v/nine', 9, i => (i < 3 ? { alt: `frame ${i + 1}` } : {})),
})

/** A mixed carousel: four pictures and a video. Has a video, so it keeps today's head. */
const igMixed5 = ref => ({
  ...igBase(ref),
  text: 'four pictures and a clip',
  media: [
    img('https://scontent.cdninstagram.com/v/mix', 0), img('https://scontent.cdninstagram.com/v/mix', 1),
    { kind: 'video', url: 'https://scontent.cdninstagram.com/v/mix/2.mp4', w: 1080, h: 1920, poster: 'https://scontent.cdninstagram.com/v/mix/2.jpg' },
    img('https://scontent.cdninstagram.com/v/mix', 3), img('https://scontent.cdninstagram.com/v/mix', 4),
  ],
})

const igSensitive5 = ref => ({ ...igBase(ref), text: 'five, marked sensitive', sensitive: true, media: images('https://scontent.cdninstagram.com/v/nsfw', 5) })

/** Four usable pictures and a dead entry. Four is not more than four. */
const igFourAndNull = ref => ({ ...igBase(ref), text: 'four and a hole', media: [img('https://x.invalid/h', 0), null, img('https://x.invalid/h', 2), img('https://x.invalid/h', 3), img('https://x.invalid/h', 4)] })

/**
 * Five pictures under an author name no trim shortens. No gallery card fits in 3,000 bytes, so the head
 * must be today's, untouched: the builder answers null and the head carries no script.
 */
const igHugeAuthor = ref => ({ ...igBase(ref), author: author('n'.repeat(3000), 'huge', 'https://www.instagram.com/huge/'), text: 'five', media: images('https://x.invalid/huge', 5) })

/** One picture is the still of a video whose mux had not finished (worker.ts stillOf). Still a video post. */
export const igDegraded5 = ref => ({
  ...igBase(ref),
  text: 'four pictures and a video still muxing',
  media: [
    ...images('https://scontent.cdninstagram.com/v/deg', 4),
    { kind: 'image', url: 'https://scontent.cdninstagram.com/v/deg/4.jpg', poster: 'https://scontent.cdninstagram.com/v/deg/4.jpg', w: 1080, h: 1920, posterOnly: true },
  ],
})

const rdBase = ref => ({
  ref,
  canonical: `https://www.reddit.com/r/${ref.sub}/comments/${ref.id}`,
  author: author('u/example', 'example', 'https://www.reddit.com/user/example'),
  createdAt: when,
  counts: { likes: 4100, replies: 260 },
  sensitive: false,
})

/** A Reddit gallery of twelve, with a title: the card shows the first nine. */
const rdTwelve = ref => ({ ...rdBase(ref), title: 'Twelve photos from the coast', text: '', media: images('https://i.redd.it/twelve', 12) })
const rdGifs5 = ref => ({ ...rdBase(ref), title: 'Five gifs', text: '', media: Array.from({ length: 5 }, (_, i) => ({ kind: 'gif', url: `https://i.redd.it/g/${i}.gif`, w: 480, h: 270 })) })
const rdSpoiler5 = ref => ({ ...rdBase(ref), title: 'Spoilers', text: '[spoiler]', spoiler: true, media: images('https://i.redd.it/sp', 5) })

/** Threads: a reply that quotes a post, with six pictures of its own. */
const thSixReplyQuote = ref => ({
  ref,
  canonical: `https://www.threads.com/@someone/post/${ref.code}`,
  author: author('Someone', 'someone', 'https://www.threads.com/@someone'),
  text: 'six from today',
  createdAt: when,
  media: images('https://scontent.cdninstagram.com/v/th', 6),
  counts: { likes: 51, replies: 3, reposts: 2 },
  sensitive: false,
  replyTo: {
    ref: { p: 'th', code: 'GaLThrParent' },
    canonical: 'https://www.threads.com/@parent/post/GaLThrParent',
    author: author('Parent', 'parent', 'https://www.threads.com/@parent'),
    text: 'show us', createdAt: when, media: [], counts: {}, sensitive: false,
  },
  quote: {
    ref: { p: 'th', code: 'GaLThrQuoted' },
    canonical: 'https://www.threads.com/@quoted/post/GaLThrQuoted',
    author: author('Quoted', 'quoted', 'https://www.threads.com/@quoted'),
    text: 'first line\n\n> not a quote\nlast line', createdAt: when,
    media: [img('https://scontent.cdninstagram.com/v/thq', 0)], counts: {}, sensitive: false,
  },
})

/** Facebook: no handle, and no date (the og: page's epoch). */
const fbFive = ref => ({
  ref,
  canonical: 'https://www.facebook.com/ExamplePage/posts/1000000000000101/',
  author: { name: 'Example Page', url: 'https://www.facebook.com/ExamplePage/' },
  text: 'five photos from the event',
  createdAt: new Date(0),
  media: images('https://scontent.xx.fbcdn.net/v/fb', 5).map(m => ({ ...m, w: 0, h: 0 })),
  counts: {},
  sensitive: false,
})

const ttSlides7 = ref => ({
  ref,
  canonical: `https://www.tiktok.com/@someone/photo/${ref.id}`,
  author: author('someone', 'someone', 'https://www.tiktok.com/@someone'),
  text: 'seven slides',
  createdAt: when,
  media: images('https://p16-sign.tiktokcdn-us.com/slide', 7),
  counts: { likes: 9100, replies: 40, reposts: 12 },
  sensitive: false,
})

const imAlbum5 = ref => ({
  ref,
  canonical: `https://imgur.com/a/${ref.id}`,
  author: { name: 'imgur user', handle: '', url: '' },
  title: 'An album of five',
  text: '',
  createdAt: when,
  media: images('https://i.imgur.com/al', 5),
  counts: {},
  sensitive: false,
})

/**
 * THE MATRIX. `gallery: true` marks a case whose answer now carries the component embed; every other case
 * must come back byte for byte. `kind` is what is asked for: the head, the activity / oEmbed document
 * the head links to (read off the golden head's own ids), or the converter's /_card answer for the path.
 */
export const CASES = [
  { name: 'bluesky text only', path: '/profile/bsky.app/post/3galtext0001', make: bsText },
  { name: 'bluesky one image', path: '/profile/bsky.app/post/3galone00001', make: bsOne },
  { name: 'bluesky four images (owner-approved card)', path: '/profile/bsky.app/post/3galfour0001', make: bsFour },
  { name: 'x video (owner-approved card)', path: '/X/status/2102147636702634101', make: xVideo },
  { name: 'bluesky two own images, three hoisted from the quote', path: '/profile/bsky.app/post/3galquote001', make: bsQuoteHoist },
  { name: 'instagram mixed: four images and a video', path: '/p/GaLMixed0001', make: igMixed5 },
  { name: 'instagram four usable and a dead entry', path: '/p/GaLHole00001', make: igFourAndNull },
  { name: 'instagram five under an author no trim can fit', path: '/p/GaLHuge00001', make: igHugeAuthor },
  { name: 'reddit five gifs', path: '/r/gifs/comments/galgif1/five_gifs/', make: rdGifs5 },
  { name: 'reddit five images, spoiler', path: '/r/pics/comments/galspo1/spoilers/', make: rdSpoiler5 },
  { name: 'instagram nine images', path: '/p/GaLNine00001', make: igNine, gallery: true },
  { name: 'instagram nine images, /p', path: '/p/GaLNine00002/p', make: igNine, gallery: true },
  { name: 'instagram nine images, /v', path: '/p/GaLNine00003/v', make: igNine, gallery: true },
  { name: 'instagram nine images, guest host', path: '/p/GaLNine00004', origin: GUEST, make: igNine, gallery: true },
  { name: 'instagram nine images, telegram', path: '/p/GaLNine00005', ua: TELEGRAM, make: igNine },
  { name: 'instagram nine images, other bot', path: '/p/GaLNine00006', ua: SLACK, make: igNine },
  { name: 'instagram nine images, activity document', path: '/p/GaLNine00007', make: igNine, kind: 'activity' },
  { name: 'instagram nine images, oembed document', path: '/p/GaLNine00008', make: igNine, kind: 'oembed' },
  { name: 'instagram five images, sensitive', path: '/p/GaLNsfw00001', make: igSensitive5, gallery: true },
  { name: 'reddit gallery of twelve with a title', path: '/r/pics/comments/galtw12/twelve_photos/', make: rdTwelve, gallery: true },
  { name: 'reddit gallery of twelve, activity document', path: '/r/pics/comments/galtw13/twelve_photos/', make: rdTwelve, kind: 'activity' },
  { name: 'threads six images, a reply that quotes', path: '/@someone/post/GaLThr0001', make: thSixReplyQuote, gallery: true },
  { name: 'facebook five images, no date', path: '/ExamplePage/posts/1000000000000101', make: fbFive, gallery: true },
  { name: 'tiktok slideshow of seven', path: '/@someone/photo/7000000000000000101', make: ttSlides7, gallery: true },
  { name: 'imgur album of five', path: '/a/GaL0001', make: imAlbum5, gallery: true },
  // THE CONVERTER PREVIEW'S ANSWERS. /_card is fetched by the page, so a browser asks. `gallery: true`
  // here means the answer gains `componentGallery: true` and nothing else.
  { name: 'card: instagram nine images', path: '/p/GaLNine00009', make: igNine, kind: 'card', ua: BROWSER, gallery: true },
  { name: 'card: reddit gallery of twelve', path: '/r/pics/comments/galtw14/twelve_photos/', make: rdTwelve, kind: 'card', ua: BROWSER, gallery: true },
  { name: 'card: bluesky four images', path: '/profile/bsky.app/post/3galfour0002', make: bsFour, kind: 'card', ua: BROWSER },
  { name: 'card: x video', path: '/X/status/2102147636702634102', make: xVideo, kind: 'card', ua: BROWSER },
  { name: 'card: reddit five images, spoiler', path: '/r/pics/comments/galspo2/spoilers/', make: rdSpoiler5, kind: 'card', ua: BROWSER },
  { name: 'card: instagram mixed', path: '/p/GaLMixed0002', make: igMixed5, kind: 'card', ua: BROWSER },
]

/**
 * THE ONE CASE RENDERED THROUGH render() RATHER THAN handle(): a degraded still exists only between
 * settleMux and the renderer (Media.posterOnly is never persisted), so no stubbed fetch can hand one to the
 * head through the worker. render() is the function the worker calls with it.
 */
export const DIRECT = [
  { name: 'instagram four images and a still-muxing video', ref: { p: 'ig', kind: 'p', code: 'GaLDegr00001' }, make: igDegraded5 },
]

const fakeCache = () => {
  const m = new Map()
  return {
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}
const ctx = { waitUntil() {} }
const answer = async res => ({
  status: res.status,
  headers: Object.fromEntries([...res.headers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  body: await res.text(),
})

/**
 * ONE CASE'S ANSWER, through the handle() it is given. Shared by the generator that wrote the goldens
 * (run once, against f449bb5) and by the test, so the two cannot ask the cases different questions.
 */
export async function answerOf(handle, c) {
  const origin = c.origin || ORIGIN
  const env = {
    AE: { writeDataPoint() {} },
    ASSETS: { async fetch() { return new Response('asset', { status: 200 }) } },
    TRANSLATE_GOOGLE: 'off',
    ...(origin === GUEST ? { GUEST_HOSTS: new URL(GUEST).host } : {}),
  }
  const deps = { cache: fakeCache(), fetchPost: async ref => c.make(ref) }
  const ask = path => handle(new Request(origin + path, { headers: { 'user-agent': c.ua || DISCORD } }), env, ctx, deps)
  if (c.kind === 'card') return answer(await ask(`/_card?p=${encodeURIComponent(c.path)}`))
  const head = await answer(await ask(c.path))
  if (!c.kind) return head
  const sid = /activity\+json" href="[^"]*\/statuses\/(1\d+)"/.exec(head.body)[1]
  return answer(await ask(c.kind === 'activity' ? `/api/v1/statuses/${sid}` : `/_oembed/${sid}`))
}

/** A DIRECT case's head, through the render() it is given, as worker.ts calls it for a Discord post. */
export async function directOf(render, c) {
  return answer(render({ kind: 'post', post: c.make(c.ref) }, 'discord', ORIGIN, undefined, 'mbedfx'))
}
