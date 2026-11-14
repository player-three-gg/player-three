// Markdown compiled by @mdx-js/rollup; `title` and `toc` come from plugins/rehype-site.ts.
declare module '*.md' {
  import type { ComponentType } from 'react';
  import type { TocEntry } from '../plugins/rehype-site.ts';
  const Page: ComponentType<{ components?: Record<string, ComponentType<never>> }>;
  export default Page;
  export const title: string;
  export const toc: readonly TocEntry[];
}
