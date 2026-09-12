import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * THE README BANNER, AND THE 72 PIXELS NOBODY MEASURED.
 *
 * Reported three times over two months as "the fx mark is off centre", fixed twice, and still wrong
 * both times — because both fixes measured the GLYPH INSIDE THE TILE and the tile itself was the
 * thing that was off. `translate(512 148)` on a 112-wide tile puts its centre at 568 while every
 * text line on the card is anchored at 640: seventy-two pixels, 5.6% of the width, since the first
 * commit. One attempt measured 0.75px in Chrome and blamed font metrics; the next measured an
 * alpha-weighted centroid to -0.00/+0.00 and shipped a baked PNG. Both were correct about the thing
 * they measured. Neither was pointed at the tile.
 *
 * SO THIS ASSERTS THE INVARIANT RATHER THAN ANY ONE ELEMENT: everything the card centres is centred
 * on the SAME axis, derived from the canvas width in the file rather than from the number 640 typed
 * here. A hand-written expectation is exactly what let 512 look plausible for two months.
 *
 * It is a source test, not a render test. What was wrong was arithmetic in the document, and reading
 * the document catches it in 3ms without a headless browser — the rendering was never in doubt, the
 * geometry was.
 */

const FILES = ['.github/social-preview.svg', '.github/social-preview-light.svg']
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

/** The canvas, from the file itself — never a constant, so a resize cannot make this test lie. */
function canvas(svg) {
  const m = svg.match(/<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/)
  assert.ok(m, 'the svg declares a width and height')
  return { w: Number(m[1]), h: Number(m[2]) }
}

for (const f of FILES) {
  test(`${f}: EVERY CENTRED ELEMENT SHARES ONE AXIS — the 72px the mark sat off for two months`, () => {
    const svg = read(f)
    const { w } = canvas(svg)
    const axis = w / 2

    /**
     * TOP-LEVEL text only. The mark's own `fx` lives inside a translated <g>, so its x is in LOCAL
     * coordinates and 56 is exactly right there — scanning it here would compare a tile-local number
     * against a canvas-absolute axis and fail on correct code. The group is checked below, on the
     * arithmetic that actually governs it, and its interior by the font-metric test.
     */
    const topLevel = svg.replace(/<g transform="translate[^>]*>[\s\S]*?<\/g>/g, '')
    const texts = [...topLevel.matchAll(/<text\s+x="([\d.]+)"[^>]*text-anchor="middle"/g)].map(m => Number(m[1]))
    assert.ok(texts.length >= 3, `expected the card's text lines, found ${texts.length}`)
    for (const x of texts) {
      assert.equal(x, axis, `a middle-anchored text sits at ${x}, not on the ${axis} axis`)
    }

    /**
     * AND SO MUST THE TILE, which is the one that was wrong. Its group is translated and the tile is
     * drawn at the group's origin, so the centre is translate-x + width/2 — the arithmetic nobody
     * did. Read as a pair from the same file so renaming or resizing the tile keeps the check honest.
     */
    const g = svg.match(/<g transform="translate\((-?[\d.]+) (-?[\d.]+)\)">\s*<rect width="([\d.]+)" height="([\d.]+)"/)
    assert.ok(g, 'the mark is a translated group whose first child is the tile rect')
    const [tx, , tw] = [Number(g[1]), Number(g[2]), Number(g[3])]
    assert.equal(tx + tw / 2, axis,
      `the tile spans ${tx}..${tx + tw}, centre ${tx + tw / 2} — the card centres on ${axis}`)
  })

  test(`${f}: IS A VECTOR FILE — no rasterised glyph smuggled in as a data: URI`, () => {
    /**
     * The mark was a 196x150 PNG of the two letters "fx", 3,069 bytes of base64 — 51% of the file —
     * drawn at 49x37.5. It was baked to remove a font dependency that the horizontal axis never had
     * (`text-anchor="middle"` centres on the renderer's own advance width) and that the vertical axis
     * fixes properly with `dominant-baseline="central"`. It also made the card LESS consistent: the
     * wordmark below it is live system-ui text, so a Windows reader got an Apple-rendered tile above
     * a Segoe UI wordmark, and the site's own badge (`.avatar` in public/index.html) is live text too.
     *
     * Owner's preference, stated plainly: "I'd prefer SVGs be SVGs with the proper elements."
     */
    const svg = read(f)
    assert.doesNotMatch(svg, /data:image\//, 'an SVG must not embed a raster image')
    assert.doesNotMatch(svg, /<image\b/, 'and must not carry an <image> element')
    assert.doesNotMatch(svg, /xlink/, 'nor the xlink namespace that only the <image> needed')
    assert.match(svg, /<text[^>]*>fx<\/text>/, 'the mark is live text')
  })

  test(`${f}: THE MARK CARRIES NO HARDCODED FONT METRIC`, () => {
    /**
     * The one thing about the mark that WAS genuinely font-dependent: a pre-bake `y="74"` baseline,
     * hand-tuned to one font, so every reader whose OS supplied a different face got it wrong. The
     * fix is to ask the renderer to centre on the font it actually has, not to freeze one font's
     * answer into the file — as a raster or as a magic number.
     */
    const svg = read(f)
    const mark = svg.match(/<g transform="translate[^>]*>[\s\S]*?<\/g>/)[0]
    assert.match(mark, /text-anchor="middle"/, 'horizontal: the renderer centres the advance width')
    assert.match(mark, /dominant-baseline="central"/, 'vertical: the renderer centres the em box')

    // The text sits at the tile's own centre, computed from the tile, not typed.
    const tile = mark.match(/<rect width="([\d.]+)" height="([\d.]+)"/)
    const t = mark.match(/<text x="([\d.]+)" y="([\d.]+)"/)
    assert.equal(Number(t[1]), Number(tile[1]) / 2, 'text x is the tile centre')
    assert.equal(Number(t[2]), Number(tile[2]) / 2, 'text y is the tile centre')
  })
}

test('THE TWO VARIANTS DIFFER ONLY IN THEIR PALETTE — the geometry is one design', () => {
  /**
   * The light card is the dark card with the background and the two text greys swapped, and the glow
   * dimmed (0.30/0.07 against 0.16/0.04 — a bright halo reads as a smudge on white). The tile keeps
   * its blurple either way, which is why ONE white mark is correct on both.
   *
   * Pinning the geometry as IDENTICAL is what stops a future edit centring one variant and
   * forgetting the other — this file's own failure mode, doubled. Opacity counts as palette here for
   * the same reason colour does: it is what the two cards are ALLOWED to disagree about.
   */
  const strip = f => read(f)
    .replace(/(fill|stop-color)="#[0-9a-fA-F]{3,8}"/g, '$1="COLOUR"')
    .replace(/stop-opacity="[\d.]+"/g, 'stop-opacity="ALPHA"')
  assert.equal(strip(FILES[0]), strip(FILES[1]),
    'the two cards must differ only in colour and opacity values')
})
