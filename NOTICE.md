# Third-party notices

## FxEmbed

`src/platforms/twitter/fetch.ts` reproduces the GraphQL feature-flag table used by
[FxEmbed](https://github.com/FixTweet/FxEmbed) (formerly FxTwitter). It's copied verbatim because
Twitter 400s the request if a required flag is missing. The set is whatever the endpoint accepts
today.

FxEmbed is MIT licensed and its notice is retained here:

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

The guest bearer token and query ids near it are Twitter-side facts rather than FxEmbed's
authorship, and carry no obligation.

## Simple Icons

The brand marks in `public/index.html` are from [Simple Icons](https://simpleicons.org), released
under **CC0 1.0**. Attribution isn't required, and is given anyway. The marks remain the trademarks
of their respective owners, used nominatively to identify the sites this project supports.

## yt-dlp and FFmpeg

The media container installs [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense) and
[FFmpeg](https://ffmpeg.org) at build time and invokes them as separate processes. Neither is
vendored into this repository.
