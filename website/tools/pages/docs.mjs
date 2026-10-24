import { page } from '../shell.mjs';
import { copy } from '../copy.mjs';
import { renderDoc, sourceUrl } from '../docs.mjs';
import { escape, icon } from '../html.mjs';
import { base, url, docUrl, other } from '../urls.mjs';

// Runs before the first paint so the page never flashes the other theme.
const theme = `<script>try{const t=localStorage.getItem('tolktak-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}catch{}</script>`;

export function docPage(ctx, doc) {
  const { lang } = ctx;
  const c = copy[lang].docs;
  const pages = ctx.docs.pages;
  const at = pages.findIndex(p => p.id === doc.id);
  const [prev, next] = [pages[at - 1], pages[at + 1]];
  const sections = ctx.docs.nav.map(group => `<p class="w-doc-cap">${escape(group.label)}</p>
${group.pages.map(p => `<a class="w-doc-link" href="${docUrl(lang, p.id)}"${p.id === doc.id ? ' aria-current="page"' : ''}>${escape(p.title)}</a>`).join('\n')}`).join('\n');
  const toc = doc.headings.map(h => `<a class="w-doc-toc-${h.level}" href="#${h.anchor}">${escape(h.text)}</a>`).join('\n');
  // A page written in one language only links to the start of the other language's docs.
  const translated = ctx.docs.all.some(p => p.lang === other(lang) && p.id === doc.id);
  return page({
    lang, page: 'docs', styles: ['prose'], head: theme,
    path: docUrl(lang, doc.id).slice(base(lang).length), title: `${doc.title} — TolkTak`, description: doc.description,
    alternate: translated ? undefined : docUrl(other(lang), 'index'),
    downloads: ctx.downloads,
    data: { docs: { searchUrl: url(lang, 'docs/search.json'), placeholder: c.searchPlaceholder, hint: c.searchHint, noResults: c.noResults, error: c.searchError, copy: c.copyCode, copied: copy[lang].copied, copyFailed: copy[lang].copyFailed } },
    body: `<div class="w-doc-page">
  <div class="w-wrap w-doc">
    <aside class="w-doc-side" id="w-doc-side" aria-label="${c.title}">
      <div class="w-doc-side-in">
        <div class="w-doc-side-head">
          <a class="w-doc-home" href="${docUrl(lang, 'index')}"><span class="w-doc-badge">${icon('file', 16)}</span><span>${c.title}</span></a>
          <button class="w-doc-close" type="button" data-doc-close aria-controls="w-doc-side" aria-label="${c.closeMenu}">${icon('x', 18)}</button>
        </div>
        <button class="w-doc-find" type="button" data-switch-open data-needs-js>${icon('search', 15)}<span>${c.search}</span></button>
        <nav class="w-doc-nav" aria-label="${c.menu}">
${sections}
        </nav>
        <div class="w-doc-theme" role="group" aria-label="${c.theme}" data-needs-js>
          <button type="button" data-theme-choice="dark" aria-pressed="false">${c.dark}</button>
          <button type="button" data-theme-choice="light" aria-pressed="false">${c.light}</button>
        </div>
      </div>
    </aside>
    <div class="w-doc-scrim" data-doc-close hidden></div>
    <main class="w-doc-main" id="main">
      <div class="w-doc-bar">
        <nav class="w-doc-crumbs" aria-label="${c.breadcrumbs}"><a href="${docUrl(lang, 'index')}">${c.title}</a>${icon('chevronRight', 14)}<span>${escape(doc.group.label)}</span></nav>
        <button class="w-doc-menu" type="button" aria-expanded="false" aria-controls="w-doc-side" data-doc-open data-needs-js>${icon('hash', 16)}<span>${c.menu}</span></button>
      </div>
${toc ? `      <details class="w-doc-toc-m">
        <summary>${c.onPage}${icon('chevronDown', 16)}</summary>
        <div class="w-doc-toc-list">${toc}</div>
      </details>` : ''}
      <article class="w-prose">
${renderDoc(doc, ctx.docs.all)}
      </article>
      <p class="w-doc-source"><a href="${sourceUrl(doc.path)}">${icon('code', 16)}${c.edit}</a></p>
      <nav class="w-doc-pager" aria-label="${c.pager}">
        ${prev ? `<a class="w-doc-prev" href="${docUrl(lang, prev.id)}"><span>${c.previous}</span><strong>${escape(prev.title)}</strong></a>` : ''}
        ${next ? `<a class="w-doc-next" href="${docUrl(lang, next.id)}"><span>${c.next}</span><strong>${escape(next.title)}</strong></a>` : ''}
      </nav>
    </main>
${toc ? `    <aside class="w-doc-toc">
      <div class="w-doc-toc-in">
        <p class="w-doc-cap" id="w-doc-toc-title">${c.onPage}</p>
        <nav aria-labelledby="w-doc-toc-title">${toc}</nav>
      </div>
    </aside>` : ''}
  </div>
</div>`,
  });
}
