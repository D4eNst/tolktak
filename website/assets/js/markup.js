// Shared by the build and the browser.

// Line icons in the desktop app's style (client/src/renderer/ui/common.tsx): 24×24, stroke 2.
const icons = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.9-.8M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z',
  headphonesOff: 'M4 15v-3a8 8 0 0 1 13.7-5.6M20 12v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM17 13h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1zM3 3l18 18',
  video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  videoOff: 'M3 7h9M15 11v6H3V7M15 10l6-3v10l-6-3M3 3l18 18',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  phoneOff: 'M4 14c4-4 12-4 16 0l-2 3-3-1v-2a10 10 0 0 0-6 0v2l-3 1z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  plus: 'M12 5v14M5 12h14',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  speaker: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  x: 'M18 6 6 18M6 6l12 12',
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  reply: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  smile: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  smilePlus: 'M22 11v1a10 10 0 1 1-9-10M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6',
  clip: 'M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  pin: 'M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  play: 'M6 4l14 8-14 8z',
  crown: 'M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  check: 'M20 6 9 17l-5-5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  stop: 'M6 6h12v12H6z',
  wave: 'M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  rack: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
};

// Sample people shown across the pages, in the server's avatar colour order. `look` draws their
// profile picture: skin, hair colour, hairstyle and an optional extra.
export const people = [
  { id: 'alisa', color: '#e5484d', ru: 'Алиса', en: 'Alice', look: ['#f2c6a4', '#5a2a1f', 'long'] },
  { id: 'borya', color: '#f76b15', ru: 'Боря', en: 'Bob', look: ['#e2ad86', '#3b2a22', 'short', 'beard'] },
  { id: 'katya', color: '#ffc53d', ru: 'Катя', en: 'Carol', look: ['#f1c9a6', '#6b3a24', 'bun'] },
  { id: 'dima', color: '#46a758', ru: 'Дима', en: 'Dave', look: ['#c98e68', '#1f1b1a', 'short', 'glasses'] },
  { id: 'ira', color: '#12a594', ru: 'Ира', en: 'Erin', look: ['#a8714f', '#2b1d18', 'curly'] },
  { id: 'pasha', color: '#0090ff', ru: 'Паша', en: 'Paul', look: ['#f0c4a0', '#b8823f', 'side'] },
  { id: 'vera', color: '#6e56cf', ru: 'Вера', en: 'Vera', look: ['#e8b48c', '#3a2621', 'bob', 'headphones'] },
  { id: 'lena', color: '#d6409f', ru: 'Лена', en: 'Lena', look: ['#f3cfb1', '#d9a55a', 'long'] },
  { id: 'gosha', color: '#8e8c99', ru: 'Гоша', en: 'Greg', look: ['#d7a47f', '#57525c', 'buzz', 'beard'] },
];
const you = { ru: 'Вы', en: 'You' };

// The house scene in plan units: seat spots in each voice room, who sits there at first and
// which seat each of them takes. Seat 4 of each room is kept for you.
export const plan = {
  seats: {
    lounge: [[198, 49], [262, 49], [326, 49], [198, 127], [262, 127], [326, 127]],
    game: [[36, 66], [86, 66], [136, 66], [61, 116], [111, 116]],
  },
  people: { lounge: ['alisa', 'borya', 'katya', 'ira', 'pasha'], game: ['dima', 'vera', 'lena', 'gosha'] },
  order: { lounge: [0, 1, 2, 3, 5], game: [0, 1, 2, 3] },
};

// Profile pictures in a 40 × 40 box: hair behind the head, neck, shoulders, head, hair in front.
const ink = '#24191a';
const fringe = 'M12.7 16C13.1 11.2 16.4 9.7 20 9.7C23.8 9.7 26.9 11.2 27.3 16C25.4 13.3 22.4 12.6 19.2 13.3C16.8 12.8 14.4 13.8 12.7 16Z';
const hairBack = {
  long: '<path d="M11.4 17.5C11 9.8 15 7.6 20 7.6S29 9.8 28.6 17.5L29.8 30H10.2Z"/>',
  bob: '<path d="M11.6 17.5C11.2 9.8 15 7.8 20 7.8S28.8 9.8 28.4 17.5L28.6 24.5Q20 26.5 11.4 24.5Z"/>',
  bun: '<circle cx="20" cy="7.6" r="3.6"/>',
  curly: [[13.2, 14.6, 3.6], [15.4, 10.8, 3.8], [20, 9.2, 4], [24.6, 10.8, 3.8], [26.8, 14.6, 3.6], [12.8, 18.6, 2.8], [27.2, 18.6, 2.8]]
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join(''),
};
const hairFront = {
  long: fringe,
  bob: fringe,
  short: 'M12.5 16.4C12.1 10.4 15.7 8.8 20 8.8S27.9 10.4 27.5 16.4C26.6 13.4 24 12.3 20.4 12.5C17 12.3 14.2 13.3 12.5 16.4Z',
  side: 'M12.4 16.8C11.8 10.2 15.6 8.5 20.3 8.5C25.2 8.5 28.5 10.8 27.7 16.8C27 14.4 25.7 13 23.8 12.2C20.6 13.6 16 13.6 12.4 16.8Z',
  bun: 'M12.6 15.6C13 11.2 16.4 9.6 20 9.6S27 11.2 27.4 15.6C25 13.4 15 13.4 12.6 15.6Z',
  buzz: 'M12.9 14.8C13.7 10.6 16.7 9.5 20 9.5S26.3 10.6 27.1 14.8C24.8 12.9 15.2 12.9 12.9 14.8Z',
  curly: 'M13 15.2C14 11 17 10.2 20 10.6C23 10.2 26 11 27 15.2C24.6 13.4 15.4 13.4 13 15.2Z',
};
const extras = {
  beard: hair => `<path d="M13.1 18.4C13.4 24.4 16.9 26.2 20 26.2S26.6 24.4 26.9 18.4C25.6 21 23.2 21.7 20 21.7S14.4 21 13.1 18.4Z" fill="${hair}"/>`,
  glasses: () => `<g fill="none" stroke="${ink}" stroke-width="1.1"><circle cx="17.1" cy="17.4" r="2.3"/><circle cx="22.9" cy="17.4" r="2.3"/><path d="M19.4 17.4h1.2"/></g>`,
  headphones: () => `<path d="M11.8 18a8.2 8.2 0 0 1 16.4 0" fill="none" stroke="${ink}" stroke-width="1.8"/><g fill="${ink}"><rect x="10.4" y="16" width="3.4" height="6" rx="1.5"/><rect x="26.2" y="16" width="3.4" height="6" rx="1.5"/></g>`,
};
const darken = (hex, k) => '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');

export function face(id) {
  const { color, look: [skin, hair, style, extra] } = people.find(p => p.id === id);
  return [
    `<g fill="${hair}">${hairBack[style] || ''}</g>`,
    `<path d="M17.3 21h5.4v6.8a2.7 2.7 0 0 1-5.4 0Z" fill="${darken(skin, 0.86)}"/>`,
    `<path d="M6 41C6.8 31.8 12.6 27.6 20 27.6S33.2 31.8 34 41Z" fill="${darken(color, 0.62)}"/>`,
    `<circle cx="20" cy="17" r="7.4" fill="${skin}"/>`,
    `<g fill="${ink}"><circle cx="17.3" cy="17.6" r="0.9"/><circle cx="22.7" cy="17.6" r="0.9"/></g>`,
    `<path d="M18.1 20.7q1.9 1.3 3.8 0" fill="none" stroke="${ink}" stroke-width="0.9" stroke-linecap="round"/>`,
    `<path d="${hairFront[style]}" fill="${hair}"/>`,
    extra ? extras[extra](hair) : '',
  ].join('');
}

export const picture = id => `<svg viewBox="0 0 40 40">${face(id)}</svg>`;

export const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const icon = (name, size = 20) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]}"/></svg>`;

export function person(id, lang) {
  if (id === 'me') return { id, name: you[lang], color: '#ff8a4c' };
  const p = people.find(p => p.id === id);
  return { id, name: p[lang], color: p.color };
}

// Avatars stand next to a name or inside a labelled control, so they are not read out. Your own
// avatar says "You" instead of a picture, so the demos show where you are.
export function ava(id, lang, size = 40, cls = '') {
  const p = person(id, lang);
  return `<span class="w-ava${id === 'me' ? ' w-ava--you' : ''}${cls ? ' ' + cls : ''}" style="--s:${size}px;--c:${p.color}" data-who="${id}" aria-hidden="true">${id === 'me' ? p.name : picture(id)}</span>`;
}

export const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);
export const clock = (minutes, lang) => new Date(2000, 0, 1, 0, minutes).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', { hour: 'numeric', minute: '2-digit' });
