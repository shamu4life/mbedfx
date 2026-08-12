# Facebook post coverage from Cloudflare egress

Measured 2026-08-12 against 35 real public Facebook post urls, from Cloudflare egress under
`npx wrangler dev --remote --enable-containers=false`. Every url is listed below, so the numbers are
checkable by re-running the same sample.

## The headline

| Surface | Cards | Notes |
|---|---|---|
| og: page (`facebookPostCard`) | 17 / 35 | 14 of the 18 misses are a login wall |
| embed plugin (`facebookPluginCard`) | 33 / 35 | both misses are Meta refusing to embed the post |
| the shipped chain, before this work | 33 / 35 | |
| the shipped chain, after this work | 34 / 35 | the remaining one is a deleted post |

Neither surface covers this platform on its own, and the two fail in different places: the plugin
carries every `/photo/?fbid=` url, which the page surface answers with a login wall, and the page
surface carries the two posts the plugin declines to embed. That is why there is an order rather
than a preference, and why removing either surface would cost real cards.

## What the sample was

Seven pages, chosen for different posting styles: NASA, NPR, Humans of New York, National
Geographic, TED, Reuters and WYFF News 4 (a local news station).

Four url shapes, all of them routed today: `/{page}/posts/{id}`, `/photo/?fbid={id}`,
`/{page}/videos/{id}`, and the legacy `1015…` post-id space.

Ages spread across at least twelve years. The recent posts were the pages' own current front-page
posts during the sampling window. The old ones came from the Wayback Machine's CDX index of
`facebook.com/{page}/posts/*`, which dates them by their first archived capture: 2013-11 for
`natgeo/posts/10151763788448951`, 2014-07 and 2015-01 for two NASA posts, 2024-02 for
`NASA/posts/940735780755132`. Four of the old urls returned no CDX timestamp and are left undated
here rather than guessed at.

Media types were classified from what the plugin fragment actually contains rather than from the
url: 21 photo posts (one or more images in the `t39.30808-6` bucket), 6 link shares (a single
`external.*.fbcdn.net` preview image and no photo-bucket image), 4 video posts (a `t15.` poster),
2 posts with no image in the fragment at all, and 2 that Meta will not embed.

Discovery of the urls was done from a laptop, which is a residential client. That affects nothing:
the urls are only inputs, and every reading in this document was taken from Cloudflare egress.

## Where each surface fails

The og: page misses 18 of 35, in three distinct shapes, and the shapes are what make the failure
diagnosable:

- 438,5xx bytes redirecting to `login/?next=…` — a login wall. All 14 `/photo/?fbid=` urls, and
  nothing else. This is the surface Meta walled in 2026-08-08, and as of this measurement the wall
  is specific to the photo permalink rather than universal: ordinary `/{page}/posts/{id}` urls
  answer with a full og: set again.
- 325,5xx bytes with no og tags at all — two urls, one live (`/WYFF4/posts/1602331204848623`) and
  one deleted (`/NASA/posts/10153395671266772`). The same byte size for both is worth noting: a
  stripped page and a deleted post are indistinguishable by shape, which is exactly why the age gate
  reads Meta's own route name instead of inferring anything from absence.
- 830–952 KB carrying `og:title` and `og:description` and no `og:image` — two urls. Both are real
  live posts whose caption was sitting in the metadata the whole time.

The plugin misses 2 of 35, and both are the same thing: a 38 KB fragment reading "This Facebook post
is no longer available. It may have been removed or the privacy settings of the post may have
changed." One of those two urls is live and readable on the page surface, so this is Meta declining
to embed rather than the post being gone.

There is no pattern by page and none by age. Every one of the seven pages has both a url that
renders and a url that does not, and the failures are spread across posts from 2013 to this month.
The pattern is by url shape (the photo permalink is walled on the page surface) and by
embeddability (Meta refuses some individual posts on the plugin surface).

## The reported url

`/NASA/posts/1304655294363177` was reported as a post whose "fragment does not server-render at all,
with the caption appearing only inside a ServerJS blob". Measured, that is not what happens:

```
page    952,579 bytes   og:title "NASA - National Aeronautics and Space Administration"
                        og:description "Go, Comet 3I/ATLAS, go! ☄️ …"
                        og:url present, og:image absent
plugin   38,448 bytes   "This Facebook post is no longer available"
```

Both surfaces answered and neither was walled. The plugin refuses to embed this post, and the page
card refused it for want of a picture — a rule written when the only alternative was rendering the
login shell. The caption was reachable from this egress in `og:description` all along.

## What changed

Four fixes, each measured from this egress and each pinned by a test that fails without it.

1. `facebookCaptionCard` — a third and last read of the og: page that accepts a byline and a caption
   with no picture. It runs after the plugin, so it can only fire where the answer was otherwise the
   failure card. Counted as `caption_recovered`. Worth 2 of the 35 urls.
2. The plugin's `<img>` tag bound went from 1400 to 4000 characters. The old number was sized
   against the signed CDN query; the tag is sized by Facebook's auto-generated alt text, which
   transcribes every word in the picture and is emitted twice (`alt=` and `caption=`). Across the 37
   photo-bucket tags in the sample the lengths run 531 / 1076 median / 1541, and the four over 1400
   were all in one post — NPR's five-photo `/photo/?fbid=1404157071581288`, which shipped one photo.
3. Photo dimensions are now read from `style="width:364px;height:364px"` when the width and height
   attributes are absent. Two of the 37 tags spell it that way, and both of those posts are a single
   picture, so the card was shipping its only image at 0x0 — which `render/mastodon.ts` turns into an
   attachment with no `meta.original` at all.
4. `fbAuthor` no longer copies the page name into `handle`. It emptied that field only on the packed
   `… | Facebook` title shape, and no og:title in the sample ended that way, so all 17 page-surface
   cards rendered `Name (@Name)` — and on the two reel-shaped titles, a view count and a whole
   caption twice.

End to end across the sample: 33 → 34 cards, and 44 → 48 media entries.

## The measured limitation that is not fixed

Twelve of the 33 plugin cards carry no picture at all, because the plugin puts a link share's
preview image on `external.*.fbcdn.net` and a video post's poster in the `t15.` bucket, and this
parser accepts only the `t39.30808-6` photo bucket. The breakdown is 6 link shares, 4 video posts
and 2 posts that genuinely have no image in the fragment.

This is invisible in the coverage number today because the og: page still supplies an `og:image` for
most of those posts and runs first. It becomes visible the moment Meta walls the page surface again,
which it did for a week between 2026-08-01 and 2026-08-08.

Reading those two buckets is a one-step follow-up and the evidence for it is uniform — each affected
fragment carries exactly one such image, in document order after the avatar, and `fbImage` already
range-checks `*.fbcdn.net` so no host allowlist would have to move. It is left undone here because
it changes what media a card carries rather than repairing media it already had, and a video post's
poster is a different decision from a photo (this project has already shipped a degraded still
addressed at a video slot, which Discord drew as nothing). Doing it needs its own measurement of
what the card looks like afterwards, not just of whether an image was found.

## What this measurement cannot say

The container was disabled (`--enable-containers=false`, which is the sanctioned way to measure from
this egress and publishes nothing). In production a Facebook post reaches `yt-dlp` first, so the
four video posts here may render as playable video rather than through any of the three surfaces
above. Nothing in this document measures that path, and the numbers should be read as coverage of
the recovery chain that runs after yt-dlp declines.

The sample is 35 urls on seven pages, all of them large public accounts posting in English. Nothing
here says anything about small pages, groups, or non-English content.

## The full sample

| url | page | kind | page bytes | og: page | plugin bytes | plugin | before | after |
|---|---|---|---|---|---|---|---|---|
| `/NASA/posts/1600685561426814` | NASA | post-recent | 902,891 | card (1 img) | 74,058 | card (1 img) | card | card (1 img) |
| `/NPR/posts/1419818160015179` | NPR | post-recent | 756,557 | card (1 img) | 109,531 | card (0 img) | card | card (1 img) |
| `/humansofnewyork/posts/1608404244183892` | HONY | post-recent | 1,047,587 | card (1 img) | 178,852 | card (0 img) | card | card (1 img) |
| `/natgeo/posts/1632169068280517` | natgeo | post-recent | 817,999 | card (1 img) | 74,466 | card (1 img) | card | card (1 img) |
| `/TED/posts/1685721956460609` | TED | post-recent | 938,474 | card (1 img) | 179,901 | card (0 img) | card | card (1 img) |
| `/Reuters/posts/1637586334898759` | Reuters | post-recent | 872,602 | card (1 img) | 72,638 | card (1 img) | card | card (1 img) |
| `/WYFF4/posts/1602331204848623` | WYFF4 | post-recent | 325,661 | no og tags | 74,037 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1583701686458535` | NASA | photo-recent | 438,635 | login wall | 76,797 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1587644152730955` | NASA | photo-recent | 438,557 | login wall | 75,352 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1404157071581288` | NPR | photo-recent | 438,667 | login wall | 83,059 | card (1 img) | card | card (5 img) |
| `/photo/?fbid=1409108511086144` | NPR | photo-recent | 438,634 | login wall | 86,759 | card (5 img) | card | card (5 img) |
| `/photo/?fbid=1521125769578407` | HONY | photo-recent | 438,554 | login wall | 82,196 | card (5 img) | card | card (5 img) |
| `/photo/?fbid=1547665713591079` | HONY | photo-recent | 438,817 | login wall | 86,863 | card (4 img) | card | card (4 img) |
| `/photo/?fbid=1627803808717043` | natgeo | photo-recent | 438,551 | login wall | 56,444 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1500166015016205` | TED | photo-recent | 438,523 | login wall | 73,831 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1637503058240420` | Reuters | photo-recent | 438,531 | login wall | 73,731 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1602276601520750` | WYFF4 | photo-recent | 438,670 | login wall | 74,036 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1496429658519072` | NASA | photo-older | 438,540 | login wall | 56,239 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1015656923764640` | NPR | photo-older | 438,530 | login wall | 55,810 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1188861009471553` | HONY | photo-older | 438,668 | login wall | 57,641 | card (1 img) | card | card (1 img) |
| `/photo/?fbid=1182307926599969` | natgeo | photo-older | 438,528 | login wall | 56,175 | card (1 img) | card | card (1 img) |
| `/NASA/videos/1004839339219743` | NASA | video | 796,485 | card (1 img) | 181,410 | card (0 img) | card | card (1 img) |
| `/NPR/videos/693451753681216` | NPR | video | 985,468 | card (1 img) | 175,328 | card (0 img) | card | card (1 img) |
| `/NASA/posts/1304655294363177` | NASA | reported | 952,579 | no og:image | 38,448 | not embeddable | failure card | card (0 img) |
| `/NASA/posts/10150113094966772` | NASA | post-old | 830,914 | no og:image | 91,708 | card (0 img) | card | card (0 img) |
| `/NASA/posts/10151968838081772` | NASA | post-old | 849,224 | card (1 img) | 109,607 | card (0 img) | card | card (1 img) |
| `/NASA/posts/10152513619236772` | NASA | post-old | 862,276 | card (1 img) | 108,782 | card (0 img) | card | card (1 img) |
| `/NASA/posts/10152970787581772` | NASA | post-old | 911,419 | card (2 img) | 70,358 | card (2 img) | card | card (2 img) |
| `/NASA/posts/10153395671266772` | NASA | post-old | 325,556 | no og tags | 38,107 | not embeddable | failure card | failure card |
| `/NASA/posts/10155729616161772` | NASA | post-old | 869,653 | card (1 img) | 74,421 | card (1 img) | card | card (1 img) |
| `/NASA/posts/940735780755132` | NASA | post-old | 948,198 | card (1 img) | 75,637 | card (1 img) | card | card (1 img) |
| `/natgeo/posts/10151763788448951` | natgeo | post-old | 858,258 | card (1 img) | 108,407 | card (0 img) | card | card (1 img) |
| `/natgeo/posts/10152458238708951` | natgeo | post-old | 898,810 | card (1 img) | 109,182 | card (0 img) | card | card (1 img) |
| `/natgeo/posts/10152773744248951` | natgeo | post-old | 862,847 | card (1 img) | 108,936 | card (0 img) | card | card (1 img) |
| `/natgeo/posts/579350905412924` | natgeo | post-old | 862,195 | card (1 img) | 108,767 | card (0 img) | card | card (1 img) |

The `og: page` and `plugin` columns are that surface read on its own. The `before` and `after`
columns are the whole shipped chain through `/_api/v1`, so a post the page surface carries shows a
card in both even where the plugin column says the fragment had no picture in it.

## Reproducing this

```
npx wrangler dev --remote --enable-containers=false --port 8811
curl -s 'http://127.0.0.1:8811/_api/v1?url=<the post url>' | jq '.ok, .post.media'
```

Never `wrangler deploy`. `dev --remote` runs the worker on Cloudflare, which is the only client
whose answer these numbers describe, and it publishes nothing.
