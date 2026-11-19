// Renders the README art in banners.json (section headers, card grids, badge strip, play button, social images) with
// headless Chromium. Text, icons and colours live in banners.json; layouts in templates.mjs.
//
//   pnpm banners                         render every entry to its committed path
//   pnpm banners --only h-01-byoa,play   render some entries
//   pnpm banners --check                 re-render to a temp dir and fail if a committed image differs
//   pnpm banners --preview               also write <id>.dark.png / <id>.light.png review composites to a temp dir
//
// Output is deterministic: fixed viewport, fixed device scale factor per entry, vendored fonts (fonts/) and icons
// (icons/), fonts loaded before capture. PNGs keep a transparent background, are trimmed to their art plus a 6 px
// margin (as the originals were) and re-encoded losslessly (png.mjs).
// playwright-core: PLAYWRIGHT_CORE (its package directory), else the workspace's node_modules. Chromium: CHROMIUM_PATH,
// else ~/.cache/ms-playwright/chromium-1223, else playwright-core's default.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, diffRatio, encodePng, trim } from './png.mjs';
import * as templates from './templates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const TEMPLATES = { header: templates.header, button: templates.button, badges: templates.badges, 'card-grid': templates.cardGrid, social: templates.social };
/** --check: a pixel differs when a channel moves by more than TOLERANCE; an image fails above MAX_DIFF of its pixels. */
const TOLERANCE = 24, MAX_DIFF = 0.002;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.split(',') : null;
if (only && !only.length) throw new Error('usage: --only <id>[,<id>…]');
const check = flag('--check'), preview = flag('--preview');

const { palettes, banners } = JSON.parse(readFileSync(join(here, 'banners.json'), 'utf8'));
const entries = only ? only.map((id) => banners.find((b) => b.id === id) ?? fail(`unknown banner id ${id}`)) : banners;

function fail(message) { throw new Error(message); }

function playwrightCore() {
  if (process.env.PLAYWRIGHT_CORE) return join(process.env.PLAYWRIGHT_CORE, 'index.mjs');
  try { return join(dirname(createRequire(join(root, 'package.json')).resolve('playwright-core/package.json')), 'index.mjs'); } catch {}
  const store = join(root, 'node_modules/.pnpm');
  const dir = existsSync(store) && readdirSync(store).find((d) => d.startsWith('playwright-core@'));
  if (!dir) throw new Error('playwright-core not found: run pnpm install, or set PLAYWRIGHT_CORE to its package directory');
  return join(store, dir, 'node_modules/playwright-core/index.mjs');
}

const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const MIME = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const fonts = { bangers: dataUrl(join(here, 'fonts/bangers-latin-400.woff2'), MIME['.woff2']), elite: dataUrl(join(here, 'fonts/special-elite-latin-400.woff2'), MIME['.woff2']) };
const ctx = {
  /** A vendored Lucide icon (icons/<name>.svg), restyled. */
  icon(name, { size, color, stroke }) {
    const svg = readFileSync(join(here, `icons/${name}.svg`), 'utf8');
    return svg.replace(/<svg[^>]*>/, `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" style="flex:none">`);
  },
  /** A repository file as a data URL; a path ending in `*<ext>` picks the single matching file in that directory. */
  asset(path) {
    let file = join(root, path);
    if (basename(path).startsWith('*')) {
      const dir = dirname(file), ext = basename(path).slice(1), hits = readdirSync(dir).filter((f) => f.endsWith(ext));
      if (hits.length !== 1) throw new Error(`${path}: expected exactly one match, found ${hits.length}`);
      file = join(dir, hits[0]);
    }
    return dataUrl(file, MIME[extname(file)]);
  },
};

/**
 * An output path containing `{hash}` is content-addressed (the first 12 hex digits of the file's SHA-256); the
 * committed file is the one in that directory matching the pattern.
 */
function committedPath(entry) {
  if (!entry.out.includes('{hash}')) return join(root, entry.out);
  const [pre, post] = basename(entry.out).split('{hash}'), dir = dirname(join(root, entry.out));
  const hits = readdirSync(dir).filter((f) => f.startsWith(pre) && f.endsWith(post) && /^[0-9a-f]{12}$/.test(f.slice(pre.length, f.length - post.length)));
  if (hits.length > 1) throw new Error(`${entry.out}: several committed files match (${hits.join(', ')})`);
  return hits.length ? join(dir, hits[0]) : null;
}

const { chromium } = await import(pathToFileURL(playwrightCore()).href);
const pinned = join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(pinned) ? pinned : undefined);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--disable-font-subpixel-positioning'],
});
const tmp = check || preview ? mkdtempSync(join(tmpdir(), 'readme-art-')) : null;
const failures = [];
try {
  for (const entry of entries) {
    const render = TEMPLATES[entry.type] ?? fail(`${entry.id}: unknown type ${entry.type}`);
    const palette = palettes[entry.palette] ?? fail(`${entry.id}: unknown palette ${entry.palette}`);
    const scale = entry.scale ?? 2, fixed = entry.type === 'social';
    const page = await browser.newPage({ deviceScaleFactor: scale, viewport: fixed ? { width: entry.size[0], height: entry.size[1] } : { width: 1400, height: 700 } });
    await page.setContent(`<!doctype html><html><head><style>${templates.css(palette, fonts)}</style></head><body>${render(entry, ctx)}</body></html>`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map((f) => f.load()));
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
      // Shrink text marked data-fit="<px>" until it is at most that wide.
      for (const el of document.querySelectorAll('[data-fit]')) {
        const max = Number(el.dataset.fit), size = parseFloat(getComputedStyle(el).fontSize);
        for (let s = size; el.getBoundingClientRect().width > max && s > 6; s -= 0.5) el.style.fontSize = `${s}px`;
      }
    });
    const jpeg = extname(entry.out) === '.jpg';
    let bytes;
    if (fixed) {
      bytes = await page.screenshot({ type: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality: entry.quality ?? 92 } : {}), clip: { x: 0, y: 0, width: entry.size[0], height: entry.size[1] } });
      if (!jpeg) bytes = encodePng(decodePng(bytes));
    } else {
      const box = await page.locator('.stage').boundingBox();
      const shot = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: Math.ceil(box.x + box.width) + 16, height: Math.ceil(box.y + box.height) + 16 } });
      bytes = encodePng(trim(decodePng(shot), 6));
    }
    await page.close();

    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const target = join(root, entry.out.replace('{hash}', hash));
    const committed = committedPath(entry);
    if (check) {
      const file = join(tmp, basename(target));
      writeFileSync(file, bytes);
      const ratio = !committed ? 1 : jpeg ? await jpegDiff(committed, file) : diffRatio(decodePng(readFileSync(committed)), decodePng(bytes), TOLERANCE);
      const ok = ratio <= MAX_DIFF;
      if (!ok) failures.push(entry.id);
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${entry.id}: ${(ratio * 100).toFixed(3)}% of pixels differ (${file})`);
      continue;
    }
    writeFileSync(target, bytes);
    if (committed && committed !== target) {
      // Content-addressed file renamed: drop the old one and point every reference at the new name.
      rmSync(committed);
      for (const ref of entry.refs ?? []) {
        const file = join(root, ref);
        writeFileSync(file, readFileSync(file, 'utf8').replaceAll(basename(committed), basename(target)));
      }
    }
    console.log(`${entry.out.replace('{hash}', hash)}  ${(bytes.length / 1024).toFixed(1)} KB`);
    if (preview && !jpeg) await composites(entry.id, bytes);
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`readme-art: ${failures.length} image(s) differ from banners.json: ${failures.join(', ')}. Run pnpm banners and commit.`);
  process.exitCode = 1;
}

/** Compares two JPEGs decoded by Chromium (node has no JPEG decoder). */
async function jpegDiff(a, b) {
  const page = await browser.newPage();
  const decode = (file) => page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let s = ''; for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { width: c.width, height: c.height, data: btoa(s) };
  }, dataUrl(file, MIME['.jpg']));
  const [x, y] = [await decode(a), await decode(b)];
  await page.close();
  const img = (d) => ({ width: d.width, height: d.height, data: Buffer.from(d.data, 'base64') });
  return diffRatio(img(x), img(y), TOLERANCE);
}

/** Review copies on GitHub's dark (#0d1117) and light (#ffffff) page colours: the art must read on both themes. */
async function composites(id, bytes) {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const { width } = decodePng(bytes);
  for (const [theme, colour] of [['dark', '#0d1117'], ['light', '#ffffff']]) {
    await page.setContent(`<body style="margin:0;background:${colour};display:inline-block;padding:24px"><img src="data:image/png;base64,${bytes.toString('base64')}" style="display:block;width:${width / 2}px"></body>`);
    await page.evaluate(() => document.images[0].decode());
    const file = join(tmp, `${id}.${theme}.png`);
    await page.locator('body').screenshot({ path: file });
    console.log(`  ${file}`);
  }
  await page.close();
}
