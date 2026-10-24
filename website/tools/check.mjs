import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { languages, url } from './urls.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const pages = (await readdir(root, { recursive: true })).filter(f => extname(f) === '.html').map(f => resolve(root, f));
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
for (const lang of languages) {
  const entries = JSON.parse(await readFile(resolve(root, '.' + url(lang, 'docs/search.json')), 'utf8'));
  for (const entry of entries) {
    const [path, hash] = entry.url.split('#');
    const html = cache.get(resolve(root, '.' + path, 'index.html'));
    if (!html || (hash && !html.includes(`id="${hash}"`))) issues.push(`Invalid search target: ${entry.url}`);
  }
}
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${pages.length} HTML pages, ${links} internal links/assets and both search indexes.`);
