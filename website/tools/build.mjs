import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copy, docGroups } from './copy.mjs';
import { homeCopy } from '../content/home.mjs';
import { downloadCopy } from '../content/download.mjs';
import { github, loadReleases } from './github.mjs';
import { loadDocs, renderDoc, renderMarkdown, searchIndex, sourceUrl, escape } from './docs.mjs';
import { languages, base, url, docUrl } from './urls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(root, '..');
const dist = resolve(root, 'dist');
const { latest: release, releases } = await loadReleases();
const docs = await loadDocs(docGroups);
const notes = async (version, lang) => readFile(resolve(root, `content/releases/${version}.${lang}.md`), 'utf8').catch(() => null);
const icons = {
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  voice: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l1.7-5.1A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8 9h8M8 13h5"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5m-3-14-4 18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  windows: '<path d="m3 5 8-1v7H3Zm10-1 8-1v8h-8ZM3 13h8v7l-8-1Zm10 0h8v8l-8-1Z"/>',
  apple: '<path d="M14 5c0-2 1-3 3-4 0 2-1 4-3 4Zm-2 2C7 3 2 8 5 15c2 5 4 7 7 5 3 2 5 0 7-5-4-2-4-5 0-7-2-3-4-3-7-1Z"/>',
  linux: '<path d="M8 9V6a4 4 0 0 1 8 0v3l3 7-2 4h-3l-2-2-2 2H7l-2-4 3-7Z"/><path d="m9 10 3 2 3-2M10 6v1m4-1v1"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
const brand = `<img src="/img/logo.svg" width="32" height="32" alt=""><span>TolkTak</span>`;

function header(lang, page, other) {
  const c = copy[lang];
  return `<a class="skip" href="#main">${c.skip}</a><header class="site-header"><div class="header-inner">
    <a class="brand" href="${base(lang)}" aria-label="TolkTak">${brand}</a>
    <button class="menu-button" type="button" aria-expanded="false" aria-controls="site-nav">${icon('menu')}<span>${c.menu}</span></button>
    <nav id="site-nav" aria-label="${c.menu}">
      <a href="${base(lang)}#features">${c.nav[0]}</a>
      <a href="${url(lang, 'download/')}" ${page === 'download' ? 'aria-current="page"' : ''}>${c.nav[1]}</a>
      <a href="${docUrl(lang, 'index')}" ${page === 'docs' ? 'aria-current="page"' : ''}>${c.nav[2]}</a>
      <a class="source-link" href="${github}">${icon('code')}<span>GitHub</span></a>
      <a class="language" href="${other}" lang="${lang === 'ru' ? 'en' : 'ru'}" hreflang="${lang === 'ru' ? 'en' : 'ru'}" aria-label="${lang === 'ru' ? 'Read in English' : 'Читать по-русски'}">${lang === 'ru' ? 'EN' : 'RU'}</a>
    </nav></div></header>`;
}

function footer(lang, page) {
  const c = copy[lang];
  return `<footer class="site-footer"><div class="footer-top"><div><a class="brand" href="${base(lang)}">${brand}</a>${page === 'home' ? '' : `<p>${c.footerText}</p>`}</div>
    <div><strong>${c.footerDocs}</strong><a href="${docUrl(lang, 'install/desktop-app')}">${c.desktopGuide}</a><a href="${docUrl(lang, 'install/docker')}">${c.host}</a><a href="${docUrl(lang, 'operations/troubleshooting')}">${lang === 'ru' ? 'Решение проблем' : 'Troubleshooting'}</a></div>
    <div><strong>${c.footerProject}</strong><a href="${github}">GitHub</a><a href="${url(lang, 'releases/')}">${c.releaseNotes}</a><a href="${docUrl(lang, 'contributing')}">${c.contribute}</a><a href="${docUrl(lang, 'security')}">${c.security}</a></div></div>
    <div class="footer-bottom"><span>© TolkTak contributors</span><a href="${github}/blob/main/LICENSE">${c.footerLicense}</a></div></footer>`;
}

function shell({ lang, title, description, path = '', other, page = '', body }) {
  const c = copy[lang];
  const canonical = 'https://tolktak.d4enst.ru' + url(lang, path);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${escape(description || c.description)}">
<meta name="color-scheme" content="light"><meta name="theme-color" content="#f5f7fb">
<link rel="canonical" href="${canonical}"><link rel="alternate" hreflang="${lang}" href="${canonical}"><link rel="alternate" hreflang="${lang === 'ru' ? 'en' : 'ru'}" href="https://tolktak.d4enst.ru${other}">
<meta property="og:type" content="website"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description || c.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="https://tolktak.d4enst.ru/img/stage.webp">
<link rel="icon" href="/img/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"><noscript><link rel="stylesheet" href="/noscript.css"></noscript>
<link rel="preload" href="/fonts/golos-text.ttf" as="font" type="font/ttf" crossorigin>
<script src="/site.js" defer></script></head><body data-page="${page}" data-lang="${lang}">
${header(lang, page, other)}${body}${footer(lang, page)}${page === 'docs' ? searchDialog(lang) : ''}</body></html>\n`;
}

function searchDialog(lang) {
  const c = copy[lang];
  return `<dialog class="search-dialog" aria-label="${c.search}"><div class="search-bar">${icon('search')}<input type="search" id="docs-query" autocomplete="off" placeholder="${c.searchPlaceholder}" aria-label="${c.search}"><button class="close-search icon-button" type="button" aria-label="${c.close}">${icon('close')}</button></div><p class="search-status" role="status">${c.searchHint}</p><div class="search-results"></div></dialog>`;
}

function home(lang) {
  const c = copy[lang];
  const h = homeCopy[lang];
  return shell({
    lang, title: `${h.title} — TolkTak`, description: h.intro,
    other: base(lang === 'ru' ? 'en' : 'ru'), page: 'home',
    body: `<main id="main">
    <section class="hero home-hero wrap">
      <div class="hero-copy">
        <h1>${escape(h.title)}</h1>
        <p class="hero-intro">${escape(h.intro)}</p>
        <div class="actions">
          <a class="button primary" href="${url(lang, 'download/')}">${icon('download')}${h.download}</a>
          <a class="button secondary" href="${docUrl(lang, 'install/docker')}">${h.serverGuide}</a>
        </div>
        <p class="platform-note">${icon('windows')}${icon('apple')}${icon('linux')}<span>${h.platforms}</span></p>
      </div>
      <figure class="hero-product">
        <div class="app-frame">
          <div class="app-frame-bar"><span class="frame-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>TolkTak</span><span>${h.gallery[0].label}</span></div>
          <img src="/img/stage.webp" width="2160" height="1350" alt="${h.gallery[0].alt}" fetchpriority="high">
        </div>
        <figcaption>${h.demo}</figcaption>
      </figure>
    </section>
    <div class="release-strip home-release wrap">
      <span class="release-version">v${release.version}</span><span class="release-status">${h.stage}</span>
      <a href="${url(lang, 'releases/')}">${c.releaseNotes}${icon('arrow')}</a>
    </div>
    <section class="wrap home-gallery" id="features" aria-labelledby="features-title">
      <h2 id="features-title">${h.galleryTitle}</h2>
      <div class="product-gallery">
        <div class="gallery-tabs" role="tablist" aria-label="${h.screenshots}">
          ${h.gallery.map((shot, i) => `<button type="button" role="tab" id="tab-${i}" aria-controls="shot-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${shot.label}</button>`).join('')}
        </div>
        ${h.gallery.map((shot, i) => `<figure id="shot-${i}" role="tabpanel" aria-labelledby="tab-${i}" ${i ? 'hidden' : ''}><img src="/img/${shot.image}.webp" width="2160" height="1350" alt="${shot.alt}" loading="lazy"></figure>`).join('')}
      </div>
    </section>
    <section class="wrap home-server" id="server" aria-labelledby="server-title">
      <div class="home-server-panel">
        <h2 id="server-title">${escape(h.serverTitle)}</h2>
        <div>
          <p>${escape(h.serverText)}</p>
          <div class="text-links">
            <a href="${docUrl(lang, 'install/docker')}">${h.serverGuide}${icon('arrow')}</a>
            <a href="${docUrl(lang, 'install/requirements')}">${h.requirements}${icon('arrow')}</a>
            <a href="${docUrl(lang, 'index')}">${c.docs}${icon('arrow')}</a>
          </div>
        </div>
      </div>
    </section>
  </main>`,
  });
}

function assetRow(asset, label, c) {
  if (!asset) throw new Error(`Missing release asset: ${label}`);
  return `<li><div><strong>${label}</strong><span>${escape(asset.name)} · ${Math.round(asset.size / 1_000_000)} ${c.sizeUnit}</span></div><a class="button secondary download-file" href="${escape(asset.url)}" data-asset="${escape(asset.name)}" aria-label="${c.downloadFile} ${escape(asset.name)}">${icon('download')}${c.downloadFile}</a></li>`;
}

function downloads(lang) {
  const c = downloadCopy[lang];
  const find = re => release.assets.find(a => re.test(a.name));
  const date = new Date(release.published).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
  return shell({ lang, title: `${c.title} — Windows, macOS, Linux`, description: c.description, path: 'download/', other: url(lang === 'ru' ? 'en' : 'ru', 'download/'), page: 'download', body: `<main id="main" class="wrap download-page">
    <div class="page-intro"><h1>${c.title}</h1>
      <div class="release-meta"><strong>${c.version} <span data-release-version>${release.version}</span></strong><span>${c.published}: <time datetime="${release.published}">${date}</time></span><a href="${url(lang, 'releases/')}">${c.release}</a></div>
    </div>
    <div class="download-platforms">${[
      ['windows', 'windows', c.windows, c.windowsNote, assetRow(find(/Setup.*\.exe$/i), 'Windows x64', c)],
      ['mac', 'apple', c.mac, c.macNote, assetRow(find(/mac-arm64\.dmg$/), 'Apple Silicon', c) + assetRow(find(/mac-x64\.dmg$/), 'Intel', c)],
      ['linux', 'linux', c.linux, c.linuxNote, assetRow(find(/\.AppImage$/), 'AppImage · x64', c) + assetRow(find(/\.deb$/), 'Debian / Ubuntu · x64', c)],
    ].map(([os, i, title, note, rows]) => `<section class="platform-download" id="${os}" data-platform="${os}"><div class="platform-heading">${icon(i)}<h2>${title}</h2><span class="os-recommendation" hidden>${c.recommended}</span></div><p>${note}</p><ul class="asset-list">${rows}</ul></section>`).join('')}</div>
    <section class="download-connection"><h2>${c.connectionTitle}</h2><p>${c.connectionText}</p>
      <div class="text-links"><a href="${docUrl(lang, 'install/desktop-app')}#${lang === 'ru' ? 'регистрация-и-вход' : 'registration-and-sign-in'}">${c.connectionGuide}${icon('arrow')}</a><a href="${docUrl(lang, 'install/docker')}">${c.serverGuide}${icon('arrow')}</a></div>
    </section>
  </main>` });
}

function docPage(lang, doc) {
  const c = copy[lang];
  const { pages, nav, all } = docs[lang];
  const at = pages.findIndex(page => page.id === doc.id);
  const [prev, next] = [pages[at - 1], pages[at + 1]];
  const navItem = page => `<a href="${docUrl(lang, page.id)}" ${page.id === doc.id ? 'aria-current="page"' : ''}>${escape(page.title)}</a>`;
  const path = 'docs/' + (doc.id === 'index' ? '' : doc.id + '/');
  return shell({ lang, title: `${doc.title} — TolkTak`, description: doc.description, path, other: docUrl(lang === 'ru' ? 'en' : 'ru', doc.id), page: 'docs', body: `<main id="main" class="docs-layout wrap">
    <aside class="docs-sidebar"><div class="docs-sidebar-head"><a class="docs-label" href="${docUrl(lang, 'index')}">${c.docs}</a><button class="docs-menu-button" type="button" aria-expanded="false" aria-controls="docs-sections">${icon('menu')}<span>${c.docsMenu}</span></button></div><button class="search-trigger" type="button" aria-haspopup="dialog">${icon('search')}<span>${c.search}</span><kbd>/</kbd></button>
    <nav id="docs-sections" aria-label="${c.docsMenu}">${nav.map(group => `<div class="docs-nav-group"><strong>${group.label}</strong>${group.pages.map(navItem).join('')}</div>`).join('')}</nav></aside>
    <div class="doc-main"><div class="breadcrumb"><a href="${docUrl(lang, 'index')}">${c.docs}</a>${icon('arrow')}<span>${doc.group.label}</span></div><article class="prose">${renderDoc(doc, all)}</article><div class="doc-source"><a href="${sourceUrl(doc)}">${c.edit}${icon('code')}</a></div><nav class="doc-pagination" aria-label="${c.docs}">${prev ? `<a href="${docUrl(lang, prev.id)}"><span>${c.previous}</span><strong>${escape(prev.title)}</strong></a>` : '<span></span>'}${next ? `<a href="${docUrl(lang, next.id)}"><span>${c.next}</span><strong>${escape(next.title)}${icon('arrow')}</strong></a>` : ''}</nav></div>
    <aside class="doc-toc"><strong>${c.onPage}</strong><nav>${doc.headings.map(h => `<a class="${h.level}" href="#${h.anchor}">${escape(h.text)}</a>`).join('')}</nav></aside></main>` });
}

async function history(lang) {
  const c = copy[lang];
  const entries = [];
  for (const entry of releases) {
    const text = await notes(entry.version, lang) || entry.notes;
    entries.push(`<article class="release-entry"><div><h2>${entry.tag}</h2><time datetime="${entry.published}">${entry.published.slice(0, 10)}</time></div><div class="prose">${text ? renderMarkdown(text) : ''}<p><a href="${entry.url}">${lang === 'ru' ? 'Релиз на GitHub' : 'Release on GitHub'}</a></p></div></article>`);
  }
  return shell({ lang, title: `${c.releaseNotes} — TolkTak`, path: 'releases/', other: url(lang === 'ru' ? 'en' : 'ru', 'releases/'), page: 'releases', body: `<main id="main" class="wrap release-page"><div class="page-intro"><h1>${c.releaseNotes}</h1></div>${entries.join('')}<div class="actions"><a class="button primary" href="${url(lang, 'download/')}">${c.download}</a><a class="button secondary" href="${github}/releases">${lang === 'ru' ? 'Все релизы на GitHub' : 'All releases on GitHub'}</a></div></main>` });
}

async function output(path, content) {
  const dest = resolve(dist, '.' + path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content);
}

await rm(dist, { recursive: true, force: true });
await cp(resolve(root, 'assets'), dist, { recursive: true });
for (const lang of languages) {
  await output(base(lang) + 'index.html', home(lang));
  await output(url(lang, 'download/index.html'), downloads(lang));
  await output(url(lang, 'releases/index.html'), await history(lang));
  for (const doc of docs[lang].pages) await output(docUrl(lang, doc.id) + 'index.html', docPage(lang, doc));
  await output(url(lang, 'docs/search.json'), JSON.stringify(searchIndex(lang, docs[lang].pages)));
}
const c = copy.ru;
await output('/404.html', shell({ lang: 'ru', title: c.missingTitle + ' — TolkTak', path: '404.html', other: '/en/', body: `<main id="main" class="wrap missing-page"><p>404</p><h1>${c.missingTitle}</h1><p>${c.missingText}</p><div class="actions"><a class="button primary" href="/">${c.home}</a><a class="button secondary" href="/docs/">${c.docs}</a></div></main>` }));
await cp(resolve(repo, 'deploy/nginx.conf.example'), resolve(dist, 'docs/nginx.conf.example'));
await output('/robots.txt', 'User-agent: *\nAllow: /\nSitemap: https://tolktak.d4enst.ru/sitemap.xml\n');
const routes = ['/', '/download/', '/releases/', '/en/', '/en/download/', '/en/releases/', ...languages.flatMap(lang => docs[lang].pages.map(doc => docUrl(lang, doc.id)))];
await output('/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>https://tolktak.d4enst.ru${route}</loc></url>`).join('')}</urlset>\n`);
console.log(`Built ${routes.length} pages for ${release.tag}. Documentation: ${docs.ru.pages.length} pages in Russian, ${docs.en.pages.length} in English.`);
