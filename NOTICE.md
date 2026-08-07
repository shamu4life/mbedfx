# Third-party notices

## FxEmbed

`src/platforms/twitter/fetch.ts` carries the `rwebTweetFeatureKeys` subset of the GraphQL
feature-flag table used by [FxEmbed](https://github.com/FixTweet/FxEmbed) (formerly FxTwitter), with
each key's value inlined, read at FxEmbed HEAD 9f57d264. Twitter 400s the request when a required
flag is missing, and the set drifts as Twitter rotates it. Re-copy the table from FxEmbed when a
request starts 400ing.

FxEmbed is MIT licensed:

```
MIT License

Copyright (c) 2022 dangered wolf

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The guest bearer token and query ids in the same file come from Twitter and carry no licence
obligation.

## Simple Icons

The brand marks in `public/index.html` are from [Simple Icons](https://simpleicons.org) 16.27.1,
released under CC0 1.0. Attribution is not required under CC0 and is given anyway. The marks
themselves remain their owners' trademarks and only identify which sites are supported.

## yt-dlp, FFmpeg and Deno

None of these are vendored here. The media container installs
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), [FFmpeg](https://ffmpeg.org) and a
[Deno](https://github.com/denoland/deno) binary (MIT; yt-dlp needs a JS runtime for YouTube) at
build time and invokes them as separate processes.
