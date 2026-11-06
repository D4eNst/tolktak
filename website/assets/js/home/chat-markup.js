import { escape, picture } from '../markup.js';

const portraits = { sasha: 'pasha', lena: 'lena', misha: 'dima' };

export function chatAvatar(id, people, size = 36) {
  return `<span class="w-chat-avatar" style="--avatar:${escape(people[id].color)};--s:${size}px" aria-hidden="true">${portraits[id] ? picture(portraits[id]) : ''}</span>`;
}
