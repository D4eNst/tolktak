'use strict';
const lang = document.documentElement.lang;
const ru = lang === 'ru';
const messages = {
  copy: ru ? 'Копировать' : 'Copy', copied: ru ? 'Скопировано' : 'Copied',
  failed: ru ? 'Выделите и скопируйте команду' : 'Select and copy the command',
  hint: ru ? 'Например: микрофон, порты, приглашения' : 'Try: microphone, ports, invites',
  empty: ru ? 'Ничего не найдено. Попробуйте другое слово.' : 'No results. Try another word.',
  loading: ru ? 'Загружаем поиск…' : 'Loading search…',
  error: ru ? 'Не удалось загрузить поиск. Используйте меню документации.' : 'Search could not load. Use the documentation menu.',
};

function toggleMenu(button, panel) {
  if (!button || !panel) return;
  const close = () => { button.setAttribute('aria-expanded', 'false'); panel.classList.remove('open'); };
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('open', open);
  });
  panel.addEventListener('click', event => { if (event.target.closest('a')) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.classList.contains('open')) { close(); button.focus(); }
  });
}
toggleMenu(document.querySelector('.menu-button'), document.getElementById('site-nav'));
toggleMenu(document.querySelector('.docs-menu-button'), document.getElementById('docs-sections'));

const tabs = [...document.querySelectorAll('.gallery-tabs [role=tab]')];
function selectTab(tab, focus = false) {
  tabs.forEach(item => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  });
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next !== null) { event.preventDefault(); selectTab(tabs[next], true); }
  });
});

document.querySelectorAll('.prose pre').forEach(pre => {
  const wrap = document.createElement('div'); wrap.className = 'code-block'; pre.before(wrap); wrap.append(pre);
  const button = document.createElement('button'); button.className = 'copy-button'; button.type = 'button';
  button.textContent = messages.copy; button.setAttribute('aria-label', ru ? 'Копировать блок кода' : 'Copy code block');
  wrap.prepend(button);
});
document.querySelectorAll('.copy-button').forEach(button => {
  button.addEventListener('click', async () => {
    const code = button.closest('.code-block,.terminal')?.querySelector('pre code');
    if (!code) return;
    const label = button.querySelector('span') || button;
    try { await navigator.clipboard.writeText(code.textContent); label.textContent = messages.copied; }
    catch {
      const range = document.createRange(); range.selectNodeContents(code);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      label.textContent = messages.failed;
    }
    button.setAttribute('aria-live', 'polite');
    setTimeout(() => { label.textContent = messages.copy; }, 2500);
  });
});

const os = /Win/i.test(navigator.platform) ? 'windows' : /Mac/i.test(navigator.platform) ? 'mac' : /Linux/i.test(navigator.platform) && !/Android/i.test(navigator.userAgent) ? 'linux' : null;
if (os) {
  const platform = document.querySelector(`[data-platform="${os}"]`);
  platform?.classList.add('recommended');
  const note = platform?.querySelector('.os-recommendation'); if (note) note.hidden = false;
}

const dialog = document.querySelector('.search-dialog');
if (dialog) {
  const input = dialog.querySelector('input'), status = dialog.querySelector('.search-status'), results = dialog.querySelector('.search-results');
  let index, loading, request = 0;
  const normalize = value => value.toLocaleLowerCase().replace(/ё/g, 'е');
  function snippet(text, query) {
    const at = normalize(text).indexOf(query[0]), start = Math.max(0, at - 55);
    return (start ? '…' : '') + text.slice(start, start + 175) + (text.length > start + 175 ? '…' : '');
  }
  async function search() {
    const ticket = ++request, query = normalize(input.value.trim()).split(/\s+/).filter(Boolean);
    results.replaceChildren();
    if (!query.length) { status.textContent = messages.hint; return; }
    status.textContent = messages.loading;
    try {
      if (!index) {
        loading ||= fetch((lang === 'en' ? '/en' : '') + '/docs/search.json').then(response => {
          if (!response.ok) throw new Error('Search index unavailable'); return response.json();
        }).then(data => { index = data; }).catch(error => { loading = null; throw error; });
        await loading;
      }
      if (ticket !== request) return;
      const matches = index.map(item => {
        const title = normalize(item.title + ' ' + item.page), text = normalize(item.text);
        if (!query.every(word => (title + ' ' + text).includes(word))) return null;
        return { ...item, score: query.reduce((sum, word) => sum + (title.includes(word) ? 10 : 1), 0) };
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 15);
      status.textContent = matches.length ? (ru ? `Найдено разделов: ${matches.length}` : `Sections found: ${matches.length}`) : messages.empty;
      matches.forEach(item => {
        const link = document.createElement('a'); link.className = 'search-result'; link.href = item.url;
        const page = document.createElement('small'); page.textContent = item.page;
        const title = document.createElement('strong'); title.textContent = item.title;
        const excerpt = document.createElement('p'); excerpt.textContent = snippet(item.text, query);
        link.append(page, title, excerpt); results.append(link);
      });
    } catch { if (ticket === request) status.textContent = messages.error; }
  }
  const openSearch = () => { if (!dialog.open) dialog.showModal(); input.focus(); };
  document.querySelector('.search-trigger').addEventListener('click', openSearch);
  dialog.querySelector('.close-search').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  input.addEventListener('input', search);
  results.addEventListener('click', event => { if (event.target.closest('a')) dialog.close(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('a')?.focus(); }
    if (event.key === 'Enter') results.querySelector('a')?.click();
  });
  results.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const items = [...results.querySelectorAll('a')], at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (at === 0) input.focus(); else items[at - 1]?.focus();
  });
  document.addEventListener('keydown', event => {
    if (/input|textarea|select/i.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); openSearch(); }
  });
}

if ('IntersectionObserver' in window) {
  const tocLinks = [...document.querySelectorAll('.doc-toc a')];
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting); if (!visible.length) return;
    const id = visible[0].target.id;
    tocLinks.forEach(link => link.classList.toggle('active', decodeURIComponent(link.hash.slice(1)) === id));
  }, { rootMargin: '-100px 0px -55% 0px' });
  document.querySelectorAll('.prose h2,.prose h3').forEach(heading => observer.observe(heading));
}
