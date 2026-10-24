// Builds web/ into dist/web, which Express serves; there is no Vite dev server.
// Every web/*.html is a page, served at /<name>.html.

import { defineConfig } from 'vite';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const webDir = resolve(import.meta.dirname, 'web');
const pages = Object.fromEntries(
  readdirSync(webDir)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [file.replace(/\.html$/, ''), resolve(webDir, file)]),
);

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: { input: pages },
  },
});
