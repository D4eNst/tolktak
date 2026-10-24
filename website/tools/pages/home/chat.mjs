import { ava, clock, escape, icon, json, person } from '../../html.mjs';
import { chat as copy } from '../../../content/home/chat.mjs';

const emoji = ['👍', '🔥', '😂', '❤️', '🎉', '👀'];

const messages = [
  { who: 'dima', at: 20 * 60 + 41, line: 'ask' },
  { who: 'katya', at: 20 * 60 + 42, line: 'evening' },
  { who: 'borya', at: 20 * 60 + 43, line: 'update', reactions: [['👍', 3], ['🎉', 1]] },
  { who: 'alisa', at: 20 * 60 + 44, line: 'rules', pinned: true, file: true },
  { who: 'ira', at: 20 * 60 + 45, sticker: true },
  { who: 'dima', at: 20 * 60 + 46, line: 'then', quote: { who: 'katya', line: 'evening' }, reactions: [['🔥', 2]] },
];


const sticker = label => `<svg class="w-chat-sticker" viewBox="0 0 120 120" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="w-chat-sticker-fill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff6a63"/>
      <stop offset="0.55" stop-color="#ff8a4c"/>
      <stop offset="1" stop-color="#ffbe4b"/>
    </linearGradient>
  </defs>
  <g fill="#fff" stroke="#fff" stroke-width="9" stroke-linejoin="round">
    <circle cx="60" cy="64" r="37"/>
    <path d="M 25 60 A 35 35 0 0 1 95 60" fill="none"/>
    <rect x="15" y="52" width="16" height="26" rx="7"/>
    <rect x="89" y="52" width="16" height="26" rx="7"/>
    <circle cx="99" cy="95" r="10"/>
  </g>
  <circle cx="60" cy="64" r="37" fill="url(#w-chat-sticker-fill)"/>
  <path d="M 25 60 A 35 35 0 0 1 95 60" fill="none" stroke="#2a2731" stroke-width="7" stroke-linecap="round"/>
  <rect x="15" y="52" width="16" height="26" rx="7" fill="#2a2731"/>
  <rect x="89" y="52" width="16" height="26" rx="7" fill="#2a2731"/>
  <ellipse cx="48" cy="62" rx="4.6" ry="6.2" fill="#1d0f12"/>
  <ellipse cx="72" cy="62" rx="4.6" ry="6.2" fill="#1d0f12"/>
  <circle cx="49.6" cy="59.6" r="1.7" fill="#fff"/>
  <circle cx="73.6" cy="59.6" r="1.7" fill="#fff"/>
  <ellipse cx="40" cy="75" rx="6" ry="3.6" fill="#ff6a63" opacity="0.55"/>
  <ellipse cx="80" cy="75" rx="6" ry="3.6" fill="#ff6a63" opacity="0.55"/>
  <path d="M 52 76 Q 60 85 68 76" fill="none" stroke="#1d0f12" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="99" cy="95" r="10" fill="url(#w-chat-sticker-fill)"/>
  <path d="M 95 90 L 96 95 M 100 88 L 100 94 M 104 90 L 103 95" stroke="#1d0f12" stroke-width="1.6" stroke-linecap="round" opacity="0.5"/>
</svg>`;

function message(m, c, lang) {
  const p = person(m.who, lang);
  const classes = ['w-chat-msg', m.pinned && 'is-pinned', m.quote && 'has-quote'].filter(Boolean).join(' ');
  const quoted = m.quote && person(m.quote.who, lang);
  return `<li class="${classes}" data-who="${m.who}" tabindex="0" aria-keyshortcuts="r p">
  ${ava(m.who, lang, 36)}
  <div class="w-chat-body">
    ${m.pinned ? `<p class="w-chat-pinmark">${icon('pin', 12)}${c.pinned}</p>` : ''}
    ${quoted ? `<p class="w-chat-quote">${ava(m.quote.who, lang, 16)}<b>${quoted.name}</b><span>${escape(c.lines[m.quote.line])}</span></p>` : ''}
    <p class="w-chat-meta"><b style="color:${p.color}">${p.name}</b><time>${clock(m.at, lang)}</time></p>
    ${m.line ? `<p class="w-chat-text">${escape(c.lines[m.line])}</p>` : ''}
    ${m.file ? `<span class="w-chat-file">
      <span class="w-chat-file-icon">${icon('file', 20)}</span>
      <span class="w-chat-file-name"><b>${c.file.name}</b><small>${c.file.size}</small></span>
      <span class="w-chat-file-dl">${icon('download', 16)}</span>
    </span>` : ''}
    ${m.sticker ? sticker(c.sticker) : ''}
    <div class="w-chat-reacts">${(m.reactions || []).map(([e, n]) => `<button class="w-chat-react" type="button" data-e="${e}" aria-label="${c.reactWith} ${e}" data-needs-js><span>${e}</span><b>${n}</b></button>`).join('')}</div>
  </div>
</li>`;
}

export default function chat({ lang }) {
  const c = copy[lang];
  const pinned = messages.find(m => m.pinned);
  return `<section class="w-scene w-chat" id="w-chat" aria-labelledby="w-chat-title">
  <div class="w-scene-text">
    <p class="w-room">${icon('hash', 15)}${c.room}</p>
    <h2 class="w-h2" id="w-chat-title">${c.title}</h2>
    <p class="w-lead">${c.lead}</p>
    <ul class="w-facts">
      <li>${icon('reply', 18)}${c.facts.reply}</li>
      <li>${icon('pin', 18)}${c.facts.pin}</li>
      <li>${icon('clip', 18)}${c.facts.clip}</li>
      <li>${icon('user', 18)}${c.facts.dm}</li>
    </ul>
  </div>
  <div class="w-stage">
    <div class="w-chat-stage">
      <div class="w-chat-win w-win" data-chat>
        <div class="w-chat-titlebar">
          <span class="w-chat-app">TolkTak <i>·</i> ${c.group}</span>
          <button class="w-chat-find" type="button" data-chat-find data-needs-js>${icon('search', 13)}<span>${c.find}</span></button>
        </div>
        <header class="w-chat-head">
          <span class="w-chat-hash">${icon('hash', 18)}</span>
          <div class="w-chat-title"><b>${c.room}</b><span>${c.members}</span></div>
          <span class="w-chat-tools" aria-hidden="true">${icon('users', 17)}${icon('pin', 17)}${icon('search', 17)}</span>
        </header>
        <div class="w-chat-pins" data-chat-pins>
          <span class="w-chat-pins-icon">${icon('pin', 14)}</span>
          <b>${c.pinned}</b>
          <span class="w-chat-pins-text" data-chat-pin-text><em>${person(pinned.who, lang).name}:</em> ${escape(c.lines[pinned.line])}</span>
          <span class="w-chat-pins-count" data-chat-pin-count>1</span>
        </div>
        <div class="w-chat-scroll" data-chat-scroll>
          <p class="w-chat-day"><span>${c.today}</span></p>
          <ol class="w-chat-list" data-chat-list>
            ${messages.map(m => message(m, c, lang)).join('\n')}
          </ol>
        </div>
        <div class="w-chat-replying" data-chat-replying hidden>
          ${icon('reply', 14)}
          <span>${c.replyingTo}</span>
          <b data-chat-reply-who></b>
          <span class="w-chat-replying-text" data-chat-reply-text></span>
          <button type="button" data-chat-reply-cancel aria-label="${c.cancelReply}">${icon('x', 14)}</button>
        </div>
        <div class="w-chat-composer" data-chat-composer>
          <button class="w-chat-cbtn" type="button" aria-label="${c.attach}" tabindex="-1">${icon('plus', 18)}</button>
          <input class="w-chat-input" data-chat-input type="text" maxlength="140" autocomplete="off" placeholder="${c.placeholder}" aria-label="${c.message}">
          <button class="w-chat-cbtn" type="button" aria-label="${c.emoji}" data-chat-emoji disabled>${icon('smile', 18)}</button>
          <button class="w-chat-send" type="button" aria-label="${c.send}" data-chat-send disabled>${icon('send', 16)}</button>
        </div>
      </div>
      <p class="w-hint w-chat-hint" data-chat-hint>${c.hintPin}</p>
      <div class="w-chat-tray" data-chat-tray role="group" aria-label="${c.reactions}" data-needs-js>
        <p class="w-hint">${c.hintTray}</p>
        <div class="w-chat-tray-row">
          ${emoji.map(e => `<button type="button" class="w-chat-emo" data-e="${e}" aria-label="${c.reactWith} ${e}">${e}</button>`).join('')}
        </div>
      </div>
    </div>
  </div>
  ${json('w-chat-copy', {
    emoji, clock: messages.at(-1).at, sticker: c.sticker, attachment: c.attachment, pinned: c.pinned,
    reply: c.reply, addReaction: c.addReaction, pin: c.pin, reactWith: c.reactWith, hintPinTouch: c.hintPinTouch, replies: c.replies,
  })}
</section>`;
}
