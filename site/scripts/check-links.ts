/**
 * Checks a built site: every same-site `href`/`src` must resolve to a file in `dist`, and every `#fragment` to an `id`
 * on its target page. External URLs are not fetched. Run by `scripts/build.ts`; `node scripts/check-links.ts` re-checks
 * an existing `site/dist`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' };

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|quot|#x27|#39|lt|gt);/g, (entity) => ENTITIES[entity] ?? entity);
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) return dirent.name === 'pagefind' ? [] : htmlFiles(path);
    return dirent.name.endsWith('.html') ? [path] : [];
  });
}

/** The file GitHub Pages serves for a site path, if any. */
function servedFile(dist: string, path: string): string | undefined {
  const local = join(dist, decodeURI(path.split('?')[0] ?? ''));
  const candidates = path.endsWith('/') ? [join(local, 'index.html')] : [local, join(local, 'index.html'), `${local}.html`];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile());
}

export function checkLinks(dist: string): string[] {
  const ids = new Map<string, Set<string>>();
  const idsOf = (file: string): Set<string> => {
    let found = ids.get(file);
    if (!found) {
      found = new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]*)"/g)].map((match) => decodeEntities(match[1] ?? '')));
      ids.set(file, found);
    }
    return found;
  };
  const problems: string[] = [];
  for (const file of htmlFiles(dist)) {
    const where = relative(dist, file);
    for (const match of readFileSync(file, 'utf8').matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const url = decodeEntities(match[1] ?? '');
      if (EXTERNAL.test(url)) continue;
      const hashAt = url.indexOf('#');
      const path = hashAt < 0 ? url : url.slice(0, hashAt);
      const fragment = hashAt < 0 ? '' : decodeURIComponent(url.slice(hashAt + 1));
      if (path && !path.startsWith('/')) {
        problems.push(`${where}: relative link ${url}`);
        continue;
      }
      const target = path ? servedFile(dist, path) : file;
      if (!target) problems.push(`${where}: broken link ${url}`);
      else if (fragment && target.endsWith('.html') && !idsOf(target).has(fragment)) problems.push(`${where}: missing anchor ${url}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  const problems = checkLinks(dist);
  for (const problem of problems) console.error(problem);
  console.log(`check-links: ${problems.length} problem(s) in ${relative(process.cwd(), dist) || '.'}`);
  process.exitCode = problems.length ? 1 : 0;
}
