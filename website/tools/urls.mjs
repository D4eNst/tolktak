export const origin = 'https://tolktak.d4enst.ru';
export const languages = ['ru', 'en'];
export const base = lang => lang === 'en' ? '/en/' : '/';
export const url = (lang, path = '') => base(lang) + path;
export const docUrl = (lang, id) => url(lang, 'docs/' + (id === 'index' ? '' : id + '/'));
export const other = lang => lang === 'ru' ? 'en' : 'ru';
