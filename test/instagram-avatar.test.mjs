import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { markupAvatar, normalizeInstagram } from '../src/platforms/instagram/normalize.ts'
import { hasEmbedPayload } from '../src/platforms/instagram/fetch.ts'

/**
 * THE AUTHOR'S PICTURE ON A SINGLE-IMAGE POST, out of the embed header (normalize.ts markupAvatar).
 *
 * Two of ten fresh posts probed from production on 2026-11-26 rendered with no avatar, because the
 * header was read with `class="Avatar"` exactly. One was an account with an active story; the other
 * was a collaboration post. Both are single images, the one shape that has no blob and so no
 * `owner.profile_pic_url`.
 *
 * THE TWO NEW FIXTURES are cut from those posts' /embed/captioned/ pages, fetched with the crawler UA
 * from a residential host that day, both from large public accounts. Kept: the post's opening tag, the
 * header exactly as served, the image frame, the like count and the caption's shape. Replaced: every
 * handle, every id, the request id, every CDN url and the caption text. An avatar url is renamed after
 * the account whose link holds it (`avatar-of-{handle}.jpg`), so an assertion can say whose picture
 * came back.
 *
 *   instagram-avatar-story-ring.html  `<a class="Avatar InsideRing" href=".../stories/{handle}/">`
 *   instagram-avatar-collab.html      two `CollabAvatar` links, the collaborator's FIRST, then the
 *                                     author's as `CollabAvatar SecondCollabAvatar`. The first link's
 *                                     data-ios-link names the author although its picture is the
 *                                     collaborator's, exactly as captured.
 */

const fixture = n => readFileSync(new URL(`./fixtures/instagram-${n}.html`, import.meta.url), 'utf8')
const RING = fixture('avatar-story-ring')
const COLLAB = fixture('avatar-collab')
const REEL = fixture('reel')
const CAROUSEL = fixture('carousel')
const avatarOf = handle => `https://scontent.cdninstagram.com/v/t51.2885-19/avatar-of-${handle}.jpg?stp=dst-jpg_s150x150&_nc_cat=1&oh=00_fixture`

test('the cut fixtures are real single-image pages: the fetcher would accept them and the markup path reads them', () => {
  for (const [page, code] of [[RING, 'DFixtureRng'], [COLLAB, 'DFixtureCol']]) {
    assert.ok(hasEmbedPayload(page), code)
    const post = normalizeInstagram(page, { p: 'ig', kind: 'p', code })
    assert.ok(post, code)
    assert.equal(post.media.length, 1, code)
    assert.equal(post.media[0].kind, 'image', code)
  }
})

test('AN ACCOUNT WITH AN ACTIVE STORY KEEPS ITS AVATAR: class="Avatar InsideRing", linked to the story', () => {
  const post = normalizeInstagram(RING, { p: 'ig', kind: 'p', code: 'DFixtureRng' })
  assert.equal(post.author.handle, 'fixture_ring_user')
  assert.equal(post.author.avatar, avatarOf('fixture_ring_user'))
  assert.ok(!post.author.avatar.includes('&amp;'), 'decoded, as every signed CDN url must be')
})

test('A COLLAB POST GETS THE AUTHOR\'S OWN PICTURE, paired by href, never the first link\'s', () => {
  // The first CollabAvatar is the collaborator's. Taking it would put the wrong face over the
  // author's name, and the card would still look right, which is why position is not the rule.
  const post = normalizeInstagram(COLLAB, { p: 'ig', kind: 'p', code: 'DFixtureCol' })
  assert.equal(post.author.handle, 'fixture_collab_owner')
  assert.equal(post.author.avatar, avatarOf('fixture_collab_owner'))
  assert.equal(markupAvatar(COLLAB, 'fixture_collab_guest'), avatarOf('fixture_collab_guest'),
    'each link holds its own account\'s picture')
})

test('THE HREF PAIRING AGREES WITH INSTAGRAM\'S OWN OWNER FIELD on both July collab captures', () => {
  // The reel and carousel fixtures (2026-07-19) carry the collab header AND a blob whose
  // owner.profile_pic_url is Instagram's own answer to "whose picture is the author's". In both,
  // `alt` names the author on BOTH links, the collaborator's included, so alt cannot be the rule;
  // the href picks the same url the blob does.
  for (const [page, code] of [[REEL, 'Da5ynsiuAZ_'], [CAROUSEL, 'DaQ5CPTki4E']]) {
    const post = normalizeInstagram(page, { p: 'ig', kind: 'p', code })
    assert.ok(post.author.avatar, code)
    assert.equal(markupAvatar(page, post.author.handle), post.author.avatar, code)
  }
})

test('NO LINK NAMING THE AUTHOR IS NO AVATAR, never the other account\'s', () => {
  // The author's link pointed somewhere else: the card goes without a picture rather than borrow the
  // collaborator's. An absent avatar degrades; a wrong one is a wrong value.
  const moved = COLLAB.replace(
    'class="CollabAvatar SecondCollabAvatar" href="https://www.instagram.com/fixture_collab_owner/',
    'class="CollabAvatar SecondCollabAvatar" href="https://www.instagram.com/fixture_third/')
  assert.notEqual(moved, COLLAB, 'fixture sanity: the replace found its target')
  const post = normalizeInstagram(moved, { p: 'ig', kind: 'p', code: 'DFixtureCol' })
  assert.equal(post.author.handle, 'fixture_collab_owner', 'the byline is unchanged')
  assert.equal(post.author.avatar, undefined)
})

test('markupAvatar is total over junk and compares handles without case', () => {
  for (const [h, who] of [[null, 'a'], [42, 'a'], [RING, undefined], [RING, ''], [RING, 7], ['', 'a'], ['<a class="Avatar" href="https://www.instagram.com/a/">', 'a']]) {
    assert.equal(markupAvatar(h, who), null, JSON.stringify([typeof h, who]))
  }
  assert.equal(markupAvatar(RING, 'Fixture_Ring_User'), avatarOf('fixture_ring_user'))
})
