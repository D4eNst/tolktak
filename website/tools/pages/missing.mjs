import { page } from '../shell.mjs';
import { copy } from '../copy.mjs';
import { base, docUrl, other } from '../urls.mjs';

export function missing({ lang, downloads }) {
  const c = copy[lang];
  return page({
    lang, page: 'missing', path: '404.html', title: `${c.missing.title} — TolkTak`,
    alternate: base(other(lang)), downloads, indexed: false,
    body: `<main id="main" class="w-wrap w-missing">
  <p class="w-room">404</p>
  <h1 class="w-h2">${c.missing.title}</h1>
  <p class="w-lead">${c.missing.text}</p>
  <p class="w-missing-actions"><a class="w-btn w-btn--primary" href="${base(lang)}">${c.missing.home}</a><a class="w-btn" href="${docUrl(lang, 'index')}">${c.docs.title}</a></p>
</main>`,
  });
}
