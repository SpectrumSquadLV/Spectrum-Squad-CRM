/**
 * Typography that sits on photographs.
 *
 * The promise in the photography brief is that her face and body are never
 * covered. Keeping it is not a layout preference — it is the difference
 * between an editorial page and a ruined portrait — and it cannot be checked
 * by reading the code, because whether a line of type lands on plaster or on
 * her depends on the viewport width.
 *
 * That is exactly how the first build failed. The manifesto band measured
 * perfectly at 1440 and put its second line across her leg at 1280, where the
 * empty half of the frame is narrower than the column sitting in it.
 *
 * So this walks every piece of text that overlaps a photograph, at several
 * widths, and reads the pixels actually behind it:
 *
 *   - CONTRAST, against the mean colour behind the text. Below 4.5 it fails.
 *   - VARIANCE, across that same patch. Plaster is flat; a face, an arm or a
 *     chair is not. A busy patch means the type is on her, and it fails even
 *     when the contrast happens to work out.
 *
 * Run: BASE_URL=http://127.0.0.1:3100 npm run verify:photo-type
 */
import { chromium } from 'playwright'
import { existsSync, readdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const PATHS = (process.env.PATHS ?? '/,/me-vs-her,/the-divine-feminine,/about').split(',')

/** Widths either side of every breakpoint this layout changes at. */
const WIDTHS = [390, 768, 1024, 1280, 1440, 1920]

/** Above this, the ground behind the text is not flat, so it is not ground. */
const MAX_STDDEV = 26

function findChromium(): string | undefined {
  const root = '/opt/pw-browsers'
  if (!existsSync(root)) return undefined
  for (const d of readdirSync(root)) {
    for (const c of [`${root}/${d}/chrome-linux/chrome`, `${root}/${d}/chrome-linux/headless_shell`]) {
      if (existsSync(c)) return c
    }
  }
  return undefined
}

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const exe = findChromium()
const browser = await chromium.launch(exe ? { executablePath: exe } : {})

interface Reading {
  text: string
  width: number
  contrast: number
  stddev: number
}

for (const path of PATHS) {
  console.log(`\n${path}`)

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    await page.evaluate(
      `(() => { for (const i of document.images) { i.loading = 'eager'; i.decoding = 'sync' } })()`,
    )
    await page.evaluate(
      `(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y)
          await new Promise(function (r) { setTimeout(r, 40) })
        }
        window.scrollTo(0, 0)
      })()`,
    )
    await page.waitForTimeout(500)

    /*
     * Passed as a STRING rather than a function.
     *
     * tsx compiles this file with esbuild, which rewrites arrow functions to
     * carry their names through a __name helper. That helper exists in this
     * process and not in the page, so a function handed to evaluate() dies on
     * its first line with "__name is not defined". A string is never compiled.
     */
    const readings: Reading[] = await page.evaluate(
      `(function () {
        const w = ${width}
        const relLum = function (r, g, b) {
          const f = function (c) {
            const v = c / 255
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
          }
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }

        const out = []

        for (const image of Array.from(document.querySelectorAll('section img'))) {
          const section = image.closest('section')
          if (!section || !image.naturalWidth) continue
          const ib = image.getBoundingClientRect()
          if (ib.width === 0) continue

          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          ctx.drawImage(image, 0, 0)

          for (const node of Array.from(section.querySelectorAll('h1,h2,h3,p,span,a'))) {
            if (!node.innerText || !node.innerText.trim() || node.children.length) continue
            const r = node.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue

            const overlaps = !(r.right < ib.left || r.left > ib.right || r.bottom < ib.top || r.top > ib.bottom)
            if (!overlaps) continue

            const sx = image.naturalWidth / ib.width
            const sy = image.naturalHeight / ib.height
            const x = Math.max(0, Math.round((Math.max(r.left, ib.left) - ib.left) * sx))
            const y = Math.max(0, Math.round((Math.max(r.top, ib.top) - ib.top) * sy))
            const cw = Math.max(1, Math.min(canvas.width - x, Math.round(Math.min(r.width, ib.width) * sx)))
            const ch = Math.max(1, Math.min(canvas.height - y, Math.round(Math.min(r.height, ib.height) * sy)))

            const data = ctx.getImageData(x, y, cw, ch).data
            let sum = 0, sumSq = 0, rr = 0, gg = 0, bb = 0, n = 0
            for (let i = 0; i < data.length; i += 4) {
              const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
              sum += grey
              sumSq += grey * grey
              rr += data[i]; gg += data[i + 1]; bb += data[i + 2]
              n++
            }
            const mean = sum / n
            const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean))

            const colour = getComputedStyle(node).color
            const open = colour.indexOf('(')
            if (open < 0) continue
            const parts = colour.slice(open + 1, colour.indexOf(')')).split(',').map(Number)
            if (parts.length < 3) continue
            const L1 = relLum(rr / n, gg / n, bb / n)
            const L2 = relLum(parts[0], parts[1], parts[2])
            const contrast = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)

            out.push({
              text: node.innerText.split(String.fromCharCode(10)).join(' ').slice(0, 40),
              width: w,
              contrast: Math.round(contrast * 100) / 100,
              stddev: Math.round(stddev * 10) / 10,
            })
          }
        }
        return out
      })()`,
    )

    await page.close()

    if (readings.length === 0) {
      console.log(`  ..   ${width}px — no type on a photograph`)
      continue
    }

    for (const r of readings) {
      check(
        `${width}px  "${r.text}"  readable on the photograph`,
        r.contrast >= 4.5 && r.stddev <= MAX_STDDEV,
        `contrast ${r.contrast}:1, texture ${r.stddev}${r.stddev > MAX_STDDEV ? ' — this is on her, not on the ground behind her' : ''}`,
      )
    }
  }
}

await browser.close()

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
