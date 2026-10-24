import { copy } from './copy.mjs';
import { github } from './github.mjs';
import { escape, icon, json, logo } from './html.mjs';
import { origin, base, url, docUrl, other } from './urls.mjs';

function header(lang, page, self, alternate) {
  const c = copy[lang];
  return `<a class="w-skip" href="#main">${c.skip}</a>
<header class="w-top">
  <div class="w-wrap">
    <a class="w-brand" href="${base(lang)}" aria-label="${c.home}">${logo()}<span>TolkTak</span></a>
    <nav class="w-nav" aria-label="${c.nav.menu}">
      <a href="${base(lang)}#w-house">${c.nav.features}</a>
      <a href="${base(lang)}#w-server">${c.nav.server}</a>
      <a href="${docUrl(lang, 'index')}"${page === 'docs' ? ' aria-current="page"' : ''}>${c.nav.docs}</a>
      <a href="${github}">${icon('code', 16)}GitHub</a>
    </nav>
    <div class="w-top-end">
      <button class="w-find" type="button" data-switch-open>${icon('search', 16)}<span>${c.find}</span></button>
      <div class="w-lang" role="group" aria-label="${c.language.label}">
        <a href="${lang === 'ru' ? self : alternate}" lang="ru" hreflang="ru"${lang === 'ru' ? ' aria-current="page"' : ''}>RU</a>
        <a href="${lang === 'en' ? self : alternate}" lang="en" hreflang="en"${lang === 'en' ? ' aria-current="page"' : ''}>EN</a>
      </div>
      <a class="w-btn w-btn--primary w-btn--sm" href="${url(lang, 'download/')}">${icon('download', 18)}<span>${c.download}</span></a>
      <button class="w-burger" type="button" data-switch-open aria-label="${c.switcher.label}">${icon('search', 18)}</button>
    </div>
  </div>
</header>`;
}

function footer(lang, alternate) {
  const c = copy[lang];
  return `<footer class="w-foot">
  <div class="w-wrap w-foot-in">
    <a class="w-foot-brand" href="${base(lang)}" aria-label="${c.home}">${logo(22)}<span>TolkTak</span></a>
    <nav class="w-foot-nav" aria-label="${c.footer.nav}">
      <a href="${github}">GitHub</a>
      <a href="${github}/blob/main/LICENSE">${c.footer.license}</a>
      <a href="${docUrl(lang, 'index')}">${c.footer.docs}</a>
      <a href="${url(lang, 'releases/')}">${c.releaseNotes}</a>
      <a href="${alternate}" lang="${other(lang)}" hreflang="${other(lang)}">${c.footer.language}</a>
    </nav>
  </div>
</footer>`;
}

function switcher(lang) {
  const c = copy[lang].switcher;
  return `<div class="w-switch" id="w-switch" role="dialog" aria-modal="true" aria-label="${c.label}" hidden>
  <div class="w-switch-box">
    <div class="w-switch-field">${icon('search', 18)}<input type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="w-switch-list" aria-label="${c.label}" placeholder="${c.placeholder}" autocomplete="off" spellcheck="false"><kbd class="w-kbd">Esc</kbd></div>
    <div class="w-switch-list" id="w-switch-list" role="listbox" data-empty="${c.empty}"></div>
  </div>
</div>`;
}

// The quick switcher ends with the main pages, after the current page's own entries.
const mainPages = lang => [
  { icon: 'chat', label: copy[lang].switcher.home, note: 'TolkTak', href: base(lang) },
  { icon: 'download', label: copy[lang].downloadApp, note: copy[lang].platforms, href: url(lang, 'download/') },
  { icon: 'file', label: copy[lang].docs.title, note: '', href: docUrl(lang, 'index') },
  { icon: 'file', label: copy[lang].releases.title, note: '', href: url(lang, 'releases/') },
  { icon: 'code', label: 'GitHub', note: 'D4eNst/tolktak', href: github },
];

// One page of the site. `switch` lists the page's own quick switcher entries; `data` is merged
// into the page's JSON for its script.
export function page({ lang, page, path = '', title, description, alternate = url(other(lang), path), body, head = '', styles = [], switch: entries = [], data = {}, downloads, indexed = true }) {
  const c = copy[lang];
  const canonical = origin + url(lang, path);
  const seo = indexed ? `<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="${lang}" href="${canonical}">
<link rel="alternate" hreflang="${other(lang)}" href="${origin}${alternate}">
<meta property="og:url" content="${canonical}">` : '<meta name="robots" content="noindex">';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description || c.description)}">
<meta name="color-scheme" content="${page === 'docs' ? 'dark light' : 'dark'}">
<meta name="theme-color" content="#111015">
${head}
${seo}
<meta property="og:type" content="website">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description || c.description)}">
<meta property="og:image" content="${origin}/img/stage.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<link rel="icon" href="/img/logo.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/golos-text.woff2" as="font" type="font/woff2" crossorigin>
${['site', ...styles, page].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('\n')}
<script type="module" src="/js/${page}.js"></script>
<noscript><style>.w-find, .w-burger, .w-rail-search, .w-hint, [data-needs-js] { display: none !important; }</style></noscript>
</head>
<body class="w-page w-page--${page}">
${header(lang, page, url(lang, path), alternate)}
${body}
${footer(lang, alternate)}
${switcher(lang)}
${json('w-site', { lang, downloads, switch: [...entries, ...mainPages(lang).filter(entry => entry.href !== url(lang, path))], ...data })}
</body>
</html>
`;
}
