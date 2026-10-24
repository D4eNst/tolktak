import { readFile, readdir, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copy, docGroups } from './copy.mjs';
import { loadReleases } from './github.mjs';
import { loadDocs, searchIndex } from './docs.mjs';
import { downloadTargets } from './release.mjs';
import { languages, base, url, docUrl, origin } from './urls.mjs';
import { home } from './pages/home.mjs';
import { download } from './pages/download.mjs';
import { docPage } from './pages/docs.mjs';
import { history } from './pages/releases.mjs';
import { missing } from './pages/missing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(root, '..');
const dist = resolve(root, 'dist');
const { latest, releases } = await loadReleases();
const docs = await loadDocs(docGroups);

async function output(path, content) {
  const dest = resolve(dist, '.' + path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content);
}

await rm(dist, { recursive: true, force: true });
await cp(resolve(root, 'assets'), dist, { recursive: true });
// Each folder in assets/css is one page's stylesheet split by section.
for (const entry of await readdir(resolve(root, 'assets/css'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const folder = resolve(root, 'assets/css', entry.name);
  const parts = (await readdir(folder)).filter(name => name.endsWith('.css')).sort();
  const css = await Promise.all(parts.map(name => readFile(resolve(folder, name), 'utf8')));
  await output(`/css/${entry.name}.css`, css.join('\n'));
  await rm(resolve(dist, 'css', entry.name), { recursive: true });
}

const routes = [];
async function route(path, content) {
  routes.push(path);
  await output(path + 'index.html', content);
}

for (const lang of languages) {
  const ctx = { lang, release: latest, releases, docs: docs[lang], downloads: downloadTargets(latest, lang, copy[lang]) };
  await route(base(lang), home(ctx));
  await route(url(lang, 'download/'), download(ctx));
  await route(url(lang, 'releases/'), history(ctx));
  for (const doc of docs[lang].pages) await route(docUrl(lang, doc.id), docPage(ctx, doc));
  await output(url(lang, 'docs/search.json'), JSON.stringify(searchIndex(lang, docs[lang].pages)));
  await output(url(lang, '404.html'), missing(ctx));
}
await cp(resolve(repo, 'deploy/nginx.conf.example'), resolve(dist, 'docs/nginx.conf.example'));
await output('/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
await output('/sitemap.xml',`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>${origin}${route}</loc></url>`).join('')}</urlset>\n`);
console.log(`Built ${routes.length} pages for ${latest.tag}. Documentation: ${docs.ru.pages.length} pages in Russian, ${docs.en.pages.length} in English.`);
