import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.filter(e => e.name !== 'node_modules').map(e => e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)]));
  return groups.flat();
}
const pages = (await files(root)).filter(f => extname(f) === '.html');
const cache = new Map(), issues = [];
let links = 0;
for (const page of pages) {
  const html = await readFile(page, 'utf8'); cache.set(page, html);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  if (ids.length !== new Set(ids).size) issues.push(`${page}: duplicate id`);
  if ([...html.matchAll(/<h1\b/g)].length !== 1) issues.push(`${page}: expected one h1`);
  if (!/<title>.+<\/title>/.test(html) || !/<html lang="(ru|en)">/.test(html)) issues.push(`${page}: missing page metadata`);
}
for (const [page, html] of cache) {
  for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(?:https?:|mailto:|data:)/.test(raw)) continue;
    links++;
    const [path, hash] = raw.split('#');
    let target = path ? (path.startsWith('/') ? resolve(root, '.' + path) : resolve(dirname(page), path)) : page;
    try {
      if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      const content = cache.get(target) ?? await readFile(target, 'utf8');
      if (hash && extname(target) === '.html' && !content.includes(`id="${decodeURIComponent(hash)}"`)) issues.push(`${page}: missing anchor ${raw}`);
    } catch { issues.push(`${page}: missing file ${raw}`); }
  }
}
for (const lang of ['', '/en']) {
  const entries = JSON.parse(await readFile(resolve(root, '.' + lang + '/docs/search.json'), 'utf8'));
  for (const entry of entries) {
    const [path, hash] = entry.url.split('#');
    const html = cache.get(resolve(root, '.' + path, 'index.html'));
    if (!html || (hash && !html.includes(`id="${hash}"`))) issues.push(`Invalid search target: ${entry.url}`);
  }
}
for (const [page, html] of cache) {
  for (const [, href] of html.matchAll(/href="(https:\/\/github\.com\/[^"]+\/releases\/download\/[^"]+)"/g)) {
    if (!href.startsWith('https://github.com/D4eNst/tolktak/releases/download/')) issues.push(`${page}: unexpected download URL ${href}`);
  }
}
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${pages.length} HTML pages, ${links} internal links/assets, both search indexes and download URLs.`);
