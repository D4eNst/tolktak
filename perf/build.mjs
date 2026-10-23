// Lives next to client/ so playwright-core, electron and e2e/stack.ts resolve as in the e2e suites.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(here, '..', 'client');
const require = createRequire(path.join(client, 'package.json'));
const esbuild = require('esbuild');

await esbuild.build({
  entryPoints: [path.join(here, 'src', 'run.ts')],
  outfile: path.join(client, '.perf', 'run.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'inline',
  external: ['playwright-core', 'playwright', '@playwright/test', 'electron'],
  logLevel: 'warning',
});
