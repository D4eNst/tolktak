'use strict';
// The docs body is written in both languages, only the header needs a dictionary.
i18n.onChange(() => { document.title = i18n.t('title') + ' · TolkTak'; });
document.querySelectorAll('.server-addr').forEach((el) => { el.textContent = location.origin; });
i18n.init({
  en: { 'nav.docs': 'Docs', 'nav.admin': 'Admin', 'title': 'Docs' },
  ru: { 'nav.docs': 'Документация', 'nav.admin': 'Администрирование', 'title': 'Документация' },
});
