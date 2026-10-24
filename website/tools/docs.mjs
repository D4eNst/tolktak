import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { github } from './github.mjs';
import { docUrl, languages } from './urls.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const roots = { ru: resolve(repo, 'docs/ru'), en: resolve(repo, 'docs') };
const md = new MarkdownIt({ html: false, linkify: true });
const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
const exists = path => access(path).then(() => true, () => false);

async function markdownFiles(dir, skip = []) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function parse(lang, id, path, source) {
  const tokens = md.parse(source, {});
  const headings = [];
  const counts = new Map();
  tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const text = tokens[i + 1].children.filter(t => t.type === 'text' || t.type === 'code_inline').map(t => t.content).join('');
    const stem = slug(text);
    const count = counts.get(stem) || 0;
    counts.set(stem, count + 1);
    const anchor = stem + (count ? '-' + count : '');
    token.attrSet('id', anchor);
    if (token.tag === 'h2' || token.tag === 'h3') headings.push({ level: token.tag, text, anchor });
  });
  const title = source.match(/^# (.+)$/m)?.[1] || id;
  const description = source.split('\n\n').find(t => !/^(?:#|[-*] |\d+\. |\||```)/.test(t))
    ?.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').slice(0, 170);
  return { lang, id, path, source, tokens, headings, title, description };
}

// Pages follow the order in which the docs link to them, starting from the index;
// pages nobody links to come last. Folders become sidebar groups in the order of `groups`.
function navigation(pages, groups) {
  const byPath = new Map(pages.map(page => [page.path, page]));
  const order = [];
  const queue = [pages.find(page => page.id === 'index')];
  const seen = new Set(queue);
  while (queue.length) {
    const page = queue.shift();
    order.push(page);
    for (const [, href] of page.source.matchAll(/\]\(([^)#\s]+\.md)/g)) {
      const target = byPath.get(resolve(dirname(page.path), href));
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  order.push(...pages.filter(page => !seen.has(page)).sort((a, b) => a.title.localeCompare(b.title)));
  const keys = Object.keys(groups);
  const groupOf = page => page.id === 'index' ? keys[0] : page.id.includes('/') ? page.id.split('/')[0] : 'project';
  const nav = new Map();
  for (const page of order) nav.set(groupOf(page), [...(nav.get(groupOf(page)) || []), page]);
  const rank = key => key === 'project' ? Infinity : keys.includes(key) ? keys.indexOf(key) : keys.length;
  return [...nav].sort(([a], [b]) => rank(a) - rank(b)).map(([key, list]) => ({ key, label: groups[key] || key, pages: list }));
}

export async function loadDocs(groups) {
  const docs = {};
  for (const lang of languages) {
    const pages = [];
    for (const path of await markdownFiles(roots[lang], lang === 'en' ? ['ru'] : [])) {
      const id = relative(roots[lang], path).split(sep).join('/').replace(/\.md$/, '').replace(/^README$/, 'index');
      pages.push(parse(lang, id, path, await readFile(path, 'utf8')));
    }
    docs[lang] = pages;
  }
  // GitHub expects SECURITY.md and CONTRIBUTING.md at the repository root, so English copies of
  // top-level Russian pages are looked up there.
  for (const page of docs.ru.filter(p => !p.id.includes('/') && p.id !== 'index')) {
    const path = resolve(repo, page.id.toUpperCase() + '.md');
    if (!docs.en.some(p => p.id === page.id) && await exists(path)) docs.en.push(parse('en', page.id, path, await readFile(path, 'utf8')));
  }
  const all = [...docs.ru, ...docs.en];
  return Object.fromEntries(languages.map(lang => {
    const nav = navigation(docs[lang], groups[lang]);
    const ordered = nav.flatMap(group => group.pages.map(page => ({ ...page, group })));
    return [lang, { pages: ordered, nav, find: id => ordered.find(page => page.id === id), all }];
  }));
}

md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const token = tokens[i];
  let href = token.attrGet('href');
  if (href?.startsWith('https://tolktak.d4enst.ru/')) {
    href = href.replace('https://tolktak.d4enst.ru', '');
    token.attrSet('href', href);
  }
  if (href && !/^(https?:|mailto:|#|\/)/.test(href)) {
    const [pathname, anchor] = href.split('#');
    const target = resolve(dirname(env.doc.path), pathname);
    const found = env.all.find(doc => doc.path === target);
    token.attrSet('href', found ? docUrl(found.lang, found.id) + (anchor ? '#' + anchor : '') : `${github}/blob/main/${posix.relative(repo, target)}${anchor ? '#' + anchor : ''}`);
  }
  return self.renderToken(tokens, i, options);
};
md.renderer.rules.table_open = (_tokens, _i, _options, env) => `<div class="table-scroll" tabindex="0" role="region" aria-label="${env.doc.lang === 'ru' ? 'Таблица с горизонтальной прокруткой' : 'Horizontally scrollable table'}"><table>\n`;
md.renderer.rules.table_close = () => '</table></div>\n';
md.renderer.rules.heading_close = (tokens, i, options, env, self) => {
  if (tokens[i].tag === 'h1') return self.renderToken(tokens, i, options);
  const id = tokens[i - 2].attrGet('id');
  return `<a class="heading-anchor" href="#${id}" aria-label="${env.doc.lang === 'ru' ? 'Ссылка на раздел' : 'Link to section'}">#</a>${self.renderToken(tokens, i, options)}`;
};

export const renderDoc = (doc, all) => md.renderer.render(doc.tokens, md.options, { doc, all });
export const renderMarkdown = source => new MarkdownIt({ html: false, linkify: true }).render(source);
export const escape = md.utils.escapeHtml;
export const sourceUrl = doc => `${github}/blob/main/${posix.relative(repo, doc.path)}`;

export function searchIndex(lang, pages) {
  return pages.flatMap(doc => doc.source.split(/(?=^## )/m).map((section, i) => {
    const title = section.match(/^## (.+)/m)?.[1] || doc.title;
    const text = md.parse(section.replace(/^#{1,6} .+$/gm, ''), {})
      .flatMap(token => token.children
        ? token.children.filter(t => ['text', 'code_inline'].includes(t.type)).map(t => t.content)
        : ['fence', 'code_block'].includes(token.type) ? [token.content] : [])
      .join(' ').replace(/\s+/g, ' ').trim();
    return { title, page: doc.title, url: docUrl(lang, doc.id) + (i ? '#' + slug(title) : ''), text };
  }));
}
