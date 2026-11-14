/**
 * Builds playerthree.gg into `site/dist` for GitHub Pages:
 * API reference (TypeDoc) → client bundle → SSR bundle → one prerendered HTML file per route plus `404.html`,
 * `sitemap.xml` and `robots.txt` → repository images the docs reference → Pagefind index → link check.
 * `public/CNAME` (playerthree.gg) is copied by Vite. Any broken internal link or anchor fails the build.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { close as closePagefind, createIndex } from 'pagefind';
import { build } from 'vite';
import { REPO_ASSET_PREFIX } from '../plugins/rehype-site.ts';
import { SITE_URL } from '../src/routes.ts';
import { generateApi } from './api.ts';
import { checkLinks } from './check-links.ts';

const site = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(site, '..');
const dist = join(site, 'dist');
const ssrOut = join(site, 'generated', 'ssr');

interface ServerEntry {
  readonly ROUTES: readonly string[];
  readonly NOT_FOUND_ROUTE: string;
  render(path: string): Promise<{ html: string; title: string; description: string }>;
  colorSchemeScript(): string;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

await generateApi();
await build({ root: site, logLevel: 'warn' });
await build({ root: site, logLevel: 'warn', build: { ssr: 'src/entry-server.ts', outDir: ssrOut, emptyOutDir: true, copyPublicDir: false } });

// The SSR bundle was emitted by the build above, so it can only be imported now.
const server = (await import(pathToFileURL(join(ssrOut, 'entry-server.js')).href)) as ServerEntry;
const template = readFileSync(join(dist, 'index.html'), 'utf8');
const colorScheme = server.colorSchemeScript();

/**
 * Latin web fonts to preload, so the first paint uses them instead of swapping in later and moving the page: Poppins
 * (headings) everywhere, plus the landing hero's Bangers and Special Elite on `/`.
 */
const fonts = readdirSync(join(dist, 'assets')).filter((name) => /^[a-z-]+-latin-\d+-normal-[\w-]+\.woff2$/.test(name));
const preload = (names: readonly string[]) => names.map((name) => `<link rel="preload" href="/assets/${name}" as="font" type="font/woff2" crossorigin />`);
const docFonts = preload(fonts.filter((name) => name.startsWith('poppins-')));
const landingFonts = preload(fonts);

async function prerender(route: string, file: string): Promise<string> {
  const page = await server.render(route);
  const notFound = route === server.NOT_FOUND_ROUTE;
  const head = [
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}" />`,
    notFound ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${SITE_URL}${route}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="PlayerThree" />',
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    notFound ? '' : `<meta property="og:url" content="${SITE_URL}${route}" />`,
    `<meta property="og:image" content="${SITE_URL}/og.png" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    ...(route === '/' ? landingFonts : docFonts),
    colorScheme,
  ].filter(Boolean).join('\n    ');
  // Function replacements: page HTML may contain `$` sequences that string replacement would expand.
  const html = template.replace('<!--site-head-->', () => head).replace('<!--site-app-->', () => page.html);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return html;
}

const rendered: string[] = [];
for (const route of server.ROUTES) rendered.push(await prerender(route, join(dist, route, 'index.html')));
rendered.push(await prerender(server.NOT_FOUND_ROUTE, join(dist, '404.html')));

writeFileSync(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${server.ROUTES.map((route) => `  <url><loc>${SITE_URL}${route}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
copyFileSync(join(repo, 'docs', 'social-preview.png'), join(dist, 'og.png'));

// Images the docs reference stay in the repository; copy exactly those.
const assets = new Set(rendered.flatMap((html) => [...html.matchAll(new RegExp(`src="${REPO_ASSET_PREFIX}([^"]+)"`, 'g'))].map((match) => match[1] ?? '')));
for (const asset of assets) {
  const target = join(dist, REPO_ASSET_PREFIX, asset);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(repo, asset), target);
}

const { index, errors } = await createIndex({});
if (!index) throw new Error(`pagefind: ${errors.join('; ')}`);
const added = await index.addDirectory({ path: dist });
if (added.errors.length) throw new Error(`pagefind: ${added.errors.join('; ')}`);
await index.writeFiles({ outputPath: join(dist, 'pagefind') });
await closePagefind();

const problems = checkLinks(dist);
for (const problem of problems) console.error(problem);
if (problems.length) throw new Error(`check-links: ${problems.length} broken link(s)`);
console.log(`site: ${server.ROUTES.length} pages + 404.html, ${added.page_count} indexed for search → ${dist}`);
