'use strict';
const i18n = (() => {
  const KEY = 'tolktak.lang';
  let dict = { en: {}, ru: {} };
  let lang = '';
  const listeners = [];
  try { lang = localStorage.getItem(KEY) || ''; } catch { /* storage unavailable */ }
  if (lang !== 'en' && lang !== 'ru') lang = /^ru/i.test(navigator.language || '') ? 'ru' : 'en';

  const has = (key) => dict[lang] && key in dict[lang];
  function t(key, vars) {
    let s = has(key) ? dict[lang][key] : (dict.en[key] ?? key);
    for (const k in vars || {}) s = s.replace('{' + k + '}', vars[k]);
    return s;
  }

  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-lang]').forEach((el) => { el.hidden = el.dataset.lang !== lang; });
    document.querySelectorAll('[data-set-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setLang === lang)));
    listeners.forEach((fn) => fn());
  }

  function init(d) {
    dict = d;
    document.querySelectorAll('[data-set-lang]').forEach((b) => b.addEventListener('click', () => {
      lang = b.dataset.setLang;
      try { localStorage.setItem(KEY, lang); } catch { /* storage unavailable */ }
      apply();
    }));
    apply();
  }

  function errorText(body, fallbackKey) {
    const e = (body && body.error) || {};
    if (e.code && has('err.' + e.code)) return t('err.' + e.code);
    return e.message || t(fallbackKey);
  }

  return { init, t, errorText, onChange: (fn) => listeners.push(fn), get lang() { return lang; } };
})();
