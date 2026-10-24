import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { copy } from './copy.mjs';
import { github } from './github.mjs';
import { origin, docUrl, languages } from './urls.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const roots = { ru: resolve(repo, 'docs/ru'), en: resolve(repo, 'docs') };
const md = new MarkdownIt({ html: false, linkify: true });
const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
const exists = path => access(path).then(() => true, () => false);
export const sourceUrl = path => `${github}/blob/main/${relative(repo, path).split(sep).join('/')}`;

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
  const description = source.split(/\r?\n\r?\n/).map(t => t.trim()).find(t => /[.!?]$/.test(t) && !/^(?:#|[-*] |\d+\. |\||```|>)/.test(t))
    ?.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ');
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
  const nav = Map.groupBy(order, groupOf);
  const rank = key => key === 'project' ? Infinity : keys.includes(key) ? keys.indexOf(key) : keys.length;
  return [...nav].sort(([a], [b]) => rank(a) - rank(b)).map(([key, list]) => ({ key, label: groups[key] || key, pages: list }));
}

export async function loadDocs(groups) {
  const docs = {};
  for (const lang of languages) {
    const pages = [];
    for (const file of await readdir(roots[lang], { recursive: true })) {
      if (!file.endsWith('.md') || (lang === 'en' && file.startsWith('ru' + sep))) continue;
      const id = file.split(sep).join('/').replace(/\.md$/, '').replace(/^README$/, 'index');
      const path = resolve(roots[lang], file);
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
    return [lang, { pages: ordered, nav, all }];
  }));
}

md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const token = tokens[i];
  let href = token.attrGet('href');
  if (href?.startsWith(origin + '/')) {
    href = href.slice(origin.length);
    token.attrSet('href', href);
  }
  if (href && !/^(https?:|mailto:|#|\/)/.test(href)) {
    const [pathname, anchor] = href.split('#');
    const target = resolve(dirname(env.doc.path), pathname);
    const found = env.all.find(doc => doc.path === target);
    token.attrSet('href', (found ? docUrl(found.lang, found.id) : sourceUrl(target)) + (anchor ? '#' + anchor : ''));
  }
  return self.renderToken(tokens, i, options);
};
md.renderer.rules.table_open = (_tokens, _i, _options, env) => `<div class="table-scroll" tabindex="0" role="region" aria-label="${copy[env.doc.lang].docs.table}"><table>\n`;
md.renderer.rules.table_close = () => '</table></div>\n';
md.renderer.rules.heading_close = (tokens, i, options, env, self) => {
  if (tokens[i].tag === 'h1') return self.renderToken(tokens, i, options);
  const id = tokens[i - 2].attrGet('id');
  return `<a class="heading-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${self.renderToken(tokens, i, options)}`;
};

export const renderDoc = (doc, all) => md.renderer.render(doc.tokens, md.options, { doc, all });

// The part of a page under one h2, without the heading. Other pages quote the docs this way
// instead of repeating their text.
export function renderSection(doc, all, anchor) {
  const isH2 = token => token.type === 'heading_open' && token.tag === 'h2';
  const start = doc.tokens.findIndex(token => isH2(token) && token.attrGet('id') === anchor);
  if (start < 0) throw new Error(`${doc.path} has no section #${anchor}`);
  const end = doc.tokens.findIndex((token, i) => i > start && isH2(token));
  return md.renderer.render(doc.tokens.slice(start + 3, end < 0 ? undefined : end), md.options, { doc, all });
}
const plain = new MarkdownIt({ html: false, linkify: true });
// Release notes sit under their release's h2, so their own headings go one level lower.
plain.renderer.rules.heading_open = plain.renderer.rules.heading_close = (tokens, i, options, _env, self) => {
  tokens[i].tag = `h${Math.min(6, Number(tokens[i].tag[1]) + 1)}`;
  return self.renderToken(tokens, i, options);
};
export const renderMarkdown = source => plain.render(source);

// One entry for the top of each page and one per h2 section, linked to the anchors parse() gave them.
// Heading text is the entry's title, so it is left out of the text.
export function searchIndex(lang, pages) {
  return pages.flatMap(doc => {
    const entries = [{ title: doc.title, anchor: '', text: [] }];
    doc.tokens.forEach((token, i) => {
      if (token.type === 'heading_open' && token.tag === 'h2') {
        const anchor = token.attrGet('id');
        entries.push({ title: doc.headings.find(h => h.anchor === anchor).text, anchor, text: [] });
      } else if (token.children && doc.tokens[i - 1].type !== 'heading_open') {
        entries.at(-1).text.push(...token.children.filter(t => t.type === 'text' || t.type === 'code_inline').map(t => t.content));
      } else if (token.type === 'fence' || token.type === 'code_block') {
        entries.at(-1).text.push(token.content);
      }
    });
    return entries.map(({ title, anchor, text }) => ({
      title, page: doc.title, url: docUrl(lang, doc.id) + (anchor ? '#' + anchor : ''), text: text.join(' ').replace(/\s+/g, ' ').trim(),
    }));
  });
}
