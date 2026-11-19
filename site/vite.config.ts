import { createReadStream, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeTypes } from '@mdx-js/mdx';
import mdx from '@mdx-js/rollup';
import rehypeShiki from '@shikijs/rehype';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { defineConfig, type Plugin } from 'vite';
import { SHIKI_OPTIONS, rehypeCodeGroups, remarkCodeFences } from './plugins/code.ts';
import { REPO_ASSET_PREFIX, rehypeAlerts, rehypeExportMeta, rehypeRepoLinks } from './plugins/rehype-site.ts';

/** The repository root: docs/, spec/ and package READMEs are rendered in place, never copied. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

/** Dev only: serve images referenced by docs from the repository (the build copies them into dist/repo/). */
function repoAssets(): Plugin {
  return {
    name: 'playerthree-repo-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(REPO_ASSET_PREFIX, (req, res, next) => {
        const path = join(repoRoot, decodeURIComponent((req.url ?? '').split('?')[0] ?? ''));
        const type = IMAGE_TYPES[extname(path).toLowerCase()];
        if (!type || !path.startsWith(repoRoot) || !existsSync(path)) return next();
        res.setHeader('Content-Type', type);
        createReadStream(path).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // playerthree.gg is a custom domain served from the root.
  base: '/',
  server: { fs: { allow: [repoRoot] } },
  // Docs compiled from outside site/ (docs/, spec/) import `react/jsx-runtime`; resolve it from the site's dependencies.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    target: 'es2023',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      // Mantine marks its modules "use client" for React Server Components; a static site has none.
      onLog(level, log, handler) {
        if (log.code !== 'MODULE_LEVEL_DIRECTIVE') handler(level, log);
      },
    },
  },
  plugins: [
    {
      enforce: 'pre',
      ...mdx({
        // Plain `.md` files compile as CommonMark + GFM (not MDX), so docs keep GitHub semantics.
        format: 'detect',
        remarkPlugins: [remarkGfm, remarkCodeFences],
        rehypePlugins: [
          [rehypeRaw, { passThrough: nodeTypes }],
          rehypeSlug,
          rehypeExportMeta,
          [rehypeAutolinkHeadings, { behavior: 'append', properties: { className: ['heading-anchor'], ariaHidden: true, tabIndex: -1 }, content: { type: 'text', value: '#' } }],
          [rehypeRepoLinks, { repoRoot }],
          rehypeAlerts,
          [rehypeShiki, { ...SHIKI_OPTIONS, addLanguageClass: true }],
          rehypeCodeGroups,
        ],
      }),
    },
    repoAssets(),
  ],
});
