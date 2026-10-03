import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import config from './vite.config';

const here = path.dirname(fileURLToPath(import.meta.url));
export default mergeConfig(config, {
  root: path.join(here, 'preview'),
  base: './',
  build: { outDir: path.join(here, '../preview-dist'), emptyOutDir: true },
  server: { proxy: {} },
});
