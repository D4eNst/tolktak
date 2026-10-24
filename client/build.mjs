import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.env.NODE_ENV === 'production';
mkdirSync('dist', { recursive: true });
cpSync('src/renderer/index.html', 'dist/index.html');
cpSync('src/launch/index.html', 'dist/launch.html');
cpSync('src/renderer/assets', 'dist/assets', { recursive: true });
// DeepFilterNet3 (~19 MB) is read from disk only when chosen.
mkdirSync('dist/assets/dfn', { recursive: true });
cpSync('vendor/deepfilternet/df_bg.wasm', 'dist/assets/dfn/df_bg.wasm');
cpSync('vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz', 'dist/assets/dfn/model.tar.gz');

// TOLKTAK_DEFAULT_SERVER prefills the login form.
const define = { __DEFAULT_SERVER__: JSON.stringify(process.env.TOLKTAK_DEFAULT_SERVER ?? '') };
const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info', target: 'chrome156', define };
// Worklets and fetch() cannot load file:// URLs, so `?text` and `?binary` imports are inlined.
const inlineFiles = {
  name: 'inline-files',
  setup(build) {
    build.onResolve({ filter: /\?(text|binary)$/ }, async (args) => {
      const [file, kind] = args.path.split('?');
      const r = await build.resolve(file, { kind: args.kind, resolveDir: args.resolveDir });
      if (r.errors.length) return { errors: r.errors };
      return { path: r.path, namespace: 'inline', pluginData: kind };
    });
    build.onLoad({ filter: /.*/, namespace: 'inline' }, (args) => ({ contents: readFileSync(args.path), loader: args.pluginData }));
  },
};

const builds = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'koffi', 'electron-updater'] },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/preload/launch.ts'], outfile: 'dist/launch-preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/launch/launch.ts'], outfile: 'dist/launch.js', platform: 'browser', format: 'esm', loader: { '.css': 'css' }, external: ['assets/*'] },
  {
    ...common,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: 'dist/renderer.js',
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'css' },
    external: ['assets/*'],
    plugins: [inlineFiles],
  },
];

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
