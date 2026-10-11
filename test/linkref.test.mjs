import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkedRef } from '../src/linkref.ts'

/**
 * WHICH LINKED URLS A REDDIT CARD MAY BORROW MEDIA FROM. The url is the poster's choice, so this is a
 * security boundary as much as a mapping: a ref comes out only for a fixed-origin platform the url's own
 * host names, and only when route() agrees with that host. Shapes from 89 real Reddit link posts sampled on
 * 2026-10-11 (YouTube 37, articles 27, Streamable 8, Twitch 4, Bluesky 3, x.com 2).
 */

test('EVERY YOUTUBE SHAPE A REDDIT POST CARRIES maps to the video', () => {
  for (const url of [
    'https://youtu.be/6j7bugx2hvk', 'https://youtu.be/6j7bugx2hvk?si=abc&t=12', 'http://youtu.be/6j7bugx2hvk',
    'https://www.youtube.com/watch?v=6j7bugx2hvk', 'https://youtube.com/watch?v=6j7bugx2hvk&t=1s&is=x',
    'https://m.youtube.com/watch?v=6j7bugx2hvk', 'https://music.youtube.com/watch?v=6j7bugx2hvk',
    'https://www.youtube.com/shorts/6j7bugx2hvk?si=x', 'https://www.youtube.com/live/6j7bugx2hvk',
    'https://www.youtube-nocookie.com/embed/6j7bugx2hvk', 'https://www.youtube.com/watch/6j7bugx2hvk',
  ]) assert.deepEqual(linkedRef(url), { p: 'yt', id: '6j7bugx2hvk' }, url)
})

test('THE OTHER FIXED-ORIGIN PLATFORMS map by host, path and the one query id that names a post', () => {
  const cases = [
    ['https://x.com/jack/status/20', { p: 'x', id: '20' }],
    ['https://twitter.com/jack/status/20?s=21', { p: 'x', id: '20' }],
    ['https://fxtwitter.com/jack/status/20', { p: 'x', id: '20' }],
    ['https://streamable.com/abc123', { p: 'st', id: 'abc123' }],
    ['https://streamable.com/e/abc123', { p: 'st', id: 'abc123' }],
    ['https://www.dailymotion.com/video/x8abc12', { p: 'dm', id: 'x8abc12' }],
    ['https://dai.ly/x8abc12', { p: 'dm', id: 'x8abc12' }],
    ['https://clips.twitch.tv/AbcDefGhiJklMnop-xyz', { p: 'tw', kind: 'clip', slug: 'AbcDefGhiJklMnop-xyz' }],
    ['https://www.twitch.tv/somechan/clip/AbcDefGhiJklMnop-xyz', { p: 'tw', kind: 'clip', slug: 'AbcDefGhiJklMnop-xyz' }],
    ['https://bsky.app/profile/bsky.app/post/3abc', { p: 'bs', handle: 'bsky.app', rkey: '3abc' }],
    ['https://www.tiktok.com/@scout2015/video/6718335390845095173', { p: 'tt', id: '6718335390845095173' }],
    ['https://www.instagram.com/reel/ABCdef123/?igsh=x', { p: 'ig', kind: 'p', code: 'ABCdef123' }],
    ['https://imgur.com/a/abcde12', { p: 'im', kind: 'album', id: 'abcde12' }],
    ['https://i.imgur.com/abcde12.gifv', { p: 'im', kind: 'post', id: 'abcde12' }],
    ['https://www.pinterest.co.uk/pin/123456789/', { p: 'pn', id: '123456789' }],
    ['https://www.facebook.com/watch/?v=1234567890123456', { p: 'fb', kind: 'watch', id: '1234567890123456' }],
  ]
  for (const [url, ref] of cases) assert.deepEqual(linkedRef(url), ref, url)
})

test('A REDDIT URL IS NEVER A LINK — no post borrows another Reddit post, so depth stays one', () => {
  for (const url of [
    'https://www.reddit.com/r/theydidthemath/comments/1mizdfz/removed_by_moderator/',
    'https://old.reddit.com/r/x/comments/abc123/', 'https://redd.it/abc123', 'https://v.redd.it/abc123',
  ]) assert.equal(linkedRef(url), null, url)
})

test('THE HOST DECIDES THE PLATFORM: a stranger host with a post-shaped path is nothing', () => {
  // route() reads paths only, so each of these routes to a real post on its own. The host table is what
  // stops a poster choosing a platform by path while naming an origin of their own.
  for (const url of [
    'https://evil.example/watch?v=6j7bugx2hvk', 'https://evil.example/r/x/comments/abc123/',
    'https://share.google/AbcDefGhiJklMnop-xyz', 'https://mbedfx.app/watch?v=6j7bugx2hvk',
    'https://forsen.sex/jack/status/20', 'https://mastodon.social/@a/1',
  ]) assert.equal(linkedRef(url), null, url)
})

test('A URL THAT DISAGREES WITH ITS HOST IS NOTHING — the router must name the host\'s platform', () => {
  assert.equal(linkedRef('https://www.youtube.com/jack/status/20'), null, 'a tweet path on youtube.com')
  assert.equal(linkedRef('https://x.com/watch?v=6j7bugx2hvk'), null, 'a watch path on x.com')
})

test('ODD URLS ARE REFUSED, not guessed at', () => {
  for (const url of [
    'javascript:alert(1)', 'ftp://youtu.be/6j7bugx2hvk', 'https://user:pw@youtu.be/6j7bugx2hvk',
    'https://youtu.be:8443/6j7bugx2hvk', 'https://youtu.be./6j7bugx2hvk', 'https://www.youtube.com/',
    'https://www.youtube.com/watch', 'https://www.twitch.tv/somechan', 'https://www.twitch.tv/videos/123',
    'https://vm.tiktok.com/ZMabc/', 'not a url', '', null, 42, `https://youtu.be/${'a'.repeat(3000)}`,
    'https://www.instagram.com/stories/someone/123/',
  ]) assert.equal(linkedRef(url), null, String(url).slice(0, 60))
})
