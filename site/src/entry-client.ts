/** Browser entry: load the prerendered route's page module, then hydrate the same tree the build rendered. */
import { createElement as h } from 'react';
import { hydrateRoot } from 'react-dom/client';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/800.css';
import '@fontsource/bangers/400.css';
import '@fontsource/special-elite/400.css';
import './styles.css';
import { Root } from './app.ts';
import { pageFor } from './content.ts';
import { normalizePath } from './routes.ts';

const path = normalizePath(location.pathname);
const entry = pageFor(path);
const page = entry ? await entry.load() : null;
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root in the prerendered page');
hydrateRoot(root, h(Root, { path, page }));
