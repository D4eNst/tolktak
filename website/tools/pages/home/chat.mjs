import { escape, icon, json } from '../../html.mjs';
import { chatAvatar } from '../../../assets/js/home/chat-markup.js';
import { chat as copy } from '../../../content/home/chat.mjs';

const emoji = ['👍', '🔥', '😂', '❤️', '🎉', '👀'];
const messages = [
  { who: 'sasha', line: 'variants', file: true },
  { who: 'lena', line: 'prefer', reactions: [['👍', 2]] },
  { who: 'misha', line: 'question' },
  { who: 'sasha', line: 'show' },
  { who: 'lena', line: 'join' },
];

function message(m, c) {
  const p = c.people[m.who];
  return `<li class="w-chat-msg" data-who="${m.who}" tabindex="0" aria-keyshortcuts="r p">
    ${chatAvatar(m.who, c.people)}
    <div class="w-chat-body">
      <p class="w-chat-meta"><b style="color:${p.color}">${p.name}</b></p>
      <p class="w-chat-text">${escape(c.lines[m.line])}</p>
      ${m.file ? `<span class="w-chat-file">${icon('file', 24)}<b>${c.file.name}</b></span>` : ''}
      <div class="w-chat-reacts">${(m.reactions || []).map(([e, n]) => `<button class="w-chat-react" type="button" data-e="${e}" aria-label="${c.reactWith} ${e}" data-needs-js><span>${e}</span><b>${n}</b></button>`).join('')}</div>
    </div>
  </li>`;
}

export default function chat({ lang }) {
  const c = copy[lang];
  return `        <div class="w-chat-win" data-chat>
          <header class="w-chat-head">${icon('hash', 22)}<b data-chat-name>${c.channels.general}</b></header>
          <div class="w-chat-pins" data-chat-pins hidden>
            <span class="w-chat-pins-icon">${icon('pin', 14)}</span><b>${c.pinned}</b>
            <span class="w-chat-pins-text" data-chat-pin-text></span><span class="w-chat-pins-count" data-chat-pin-count>0</span>
          </div>
          <div class="w-chat-scroll" data-chat-scroll>
            <p class="w-chat-empty" data-chat-empty hidden>${c.empty}</p>
            ${Object.keys(c.channels).map(id => `<ol class="w-chat-list" data-chat-list="${id}"${id !== 'general' ? ' hidden' : ''}>${id === 'general' ? messages.map(m => message(m, c)).join('\n') : ''}</ol>`).join('')}
          </div>
          <div class="w-chat-replying" data-chat-replying hidden>
            ${icon('reply', 14)}<span>${c.replyingTo}</span><b data-chat-reply-who></b><span class="w-chat-replying-text" data-chat-reply-text></span>
            <button type="button" data-chat-reply-cancel aria-label="${c.cancelReply}">${icon('x', 14)}</button>
          </div>
          <div class="w-chat-composer" data-chat-composer>
            <input class="w-chat-input" data-chat-input type="text" maxlength="140" autocomplete="off" placeholder="${c.placeholder(c.channels.general)}" aria-label="${c.message}">
            <button class="w-chat-cbtn" type="button" aria-label="${c.emoji}" data-chat-emoji disabled>${icon('smile', 20)}</button>
            <button class="w-chat-send" type="button" aria-label="${c.send}" data-chat-send disabled>${icon('send', 23)}</button>
          </div>
        </div>
  ${json('w-chat-copy', {
    emoji, people: c.people, channels: c.channels, attachment: c.attachment, pinned: c.pinned,
    reply: c.reply, addReaction: c.addReaction, pin: c.pin, reactWith: c.reactWith, hintPinTouch: c.hintPinTouch, replies: c.replies,
  })}`;
}

export function chatControls({ lang }) {
  const c = copy[lang];
  return `    <div class="w-chat-try">
      <button class="w-chat-write" type="button" data-chat-write data-needs-js>${c.tryMessage}${icon('chevronRight', 18)}</button>
      <div class="w-chat-tray" data-chat-tray role="group" aria-label="${c.reactions}" data-needs-js>
        <p class="w-hint">${c.hintTray}</p>
        <div class="w-chat-tray-row">${emoji.map(e => `<button type="button" class="w-chat-emo" data-e="${e}" aria-label="${c.reactWith} ${e}">${e}</button>`).join('')}</div>
      </div>
      <p class="w-chat-hint" data-chat-hint>${c.hintPin}</p>
    </div>`;
}
