import { icon, json, logo } from '../../html.mjs';
import { chat as chatCopy } from '../../../content/home/chat.mjs';
import { workspace as copy } from '../../../content/home/workspace.mjs';
import { chatAvatar } from '../../../assets/js/home/chat-markup.js';
import { themes } from '../../../assets/js/home/themes.js';
import { script } from '../../../assets/js/home/workspace-timeline.js';
import chat, { chatControls } from './chat.mjs';
import voice from './voice.mjs';
import screen from './screen.mjs';
import sound from './sound.mjs';

export default function workspace(ctx) {
  const { lang } = ctx;
  const c = copy[lang], a = chatCopy[lang];
  const chapterIcons = { chat: 'hash', voice: 'speaker', screen: 'speaker', layout: 'screen', sound: 'settings', appearance: 'settings' };
  const row = (id, name, glyph, target = id) => `<a class="w-chat-nav-row" href="#w-${target}" data-story-row="${id}" data-goto="w-${target}" title="${name}">${icon(glyph, 20)}<span>${name}</span>${id === 'voice' ? '<small class="w-live" data-story-live hidden>LIVE</small>' : ''}</a>`;
  const pane = (id, name, content) => `<section class="w-pane" data-pane="${id}" aria-label="${name}" hidden>
    <header class="w-pane-head"><b>${name}</b><span data-pane-menu="${id}" aria-hidden="true">···</span></header>${content}</section>`;
  const links = `<div class="w-extra-chat"><p><b>${a.people.sasha.name}</b></p><p>${c.links[0]}</p><a href="${c.links[1]}" target="_blank" rel="noreferrer">${c.links[1]}</a><div class="w-extra-composer" aria-hidden="true">${a.placeholder(a.channels.links)}${icon('send',20)}</div></div>`;
  const range = (id, min, max, value) => `<label class="w-theme-range"><span>${c[id]}</span><input type="range" data-custom="${id}" min="${min}" max="${max}" value="${value}"><output>${value}</output></label>`;
  const bars = ['58%', '72%', '50%', '66%', '44%', '60%'];
  const entry = ([tab, label], i) => label
    ? `<button type="button" data-setting-tab="${tab}" aria-current="false" aria-label="${label}" title="${label}"><i></i><s style="--w:${bars[i]}"></s></button>`
    : `<span aria-hidden="true"${tab ? ` data-setting-tab="${tab}" aria-current="page"` : ''}><i></i><s style="--w:${bars[i]}"></s></span>`;
  return `<section class="w-workstory" data-workstory aria-label="TolkTak">
  <div class="w-story-pin">
    <div class="w-story-view">
      <div class="w-chat-appframe" data-workspace data-layout="chat">
        <svg class="w-chat-outline" viewBox="0 0 1000 760" preserveAspectRatio="none" aria-hidden="true"><path d="M34 3 Q493 0 966 4 Q995 5 996 34 Q999 384 995 726 Q995 754 965 756 Q490 759 34 756 Q5 755 4 725 Q1 380 4 34 Q4 5 34 3Z"/></svg>
        <div class="w-chat-titlebar"><span class="w-chat-app">${logo(25)}TolkTak</span>
          <div class="w-story-connection" hidden data-story-connection><i></i><span>${a.rooms.voice}</span><button type="button" data-top-mic aria-label="${lang === 'ru' ? 'Микрофон' : 'Microphone'}" aria-pressed="true">${icon('mic',18)}</button><button type="button" data-top-leave aria-label="${lang === 'ru' ? 'Выйти из комнаты' : 'Leave room'}">${icon('phoneOff',18)}</button></div>
          <button class="w-chat-find" type="button" data-chat-find aria-label="${a.find}" title="${a.find}">${icon('search',19)}<span class="w-story-search-placeholder" aria-hidden="true"></span></button>
        </div>
        <div class="w-chat-workspace">
          <aside class="w-chat-nav" aria-label="${a.group}">
            <div class="w-story-nav-tabs"><button type="button" data-nav-tab="groups" aria-pressed="true">${c.groups}</button><button type="button" data-nav-tab="people" aria-pressed="false">${c.people}</button></div>
            <div class="w-chat-group"><span class="w-story-group-avatar" aria-hidden="true">🎲</span><b>${a.group}</b></div>
            <div class="w-chat-nav-scroll" data-nav-groups>
              <p class="w-chat-nav-label">${a.channelsLabel}</p>
              <div class="w-chat-channels">${Object.entries(a.channels).map(([id,name])=>row(id === 'general' ? 'chat' : id,name,'hash','chat')).join('')}</div>
              <p class="w-chat-nav-label">${a.roomsLabel}</p>
              ${row('voice',a.rooms.voice,'speaker','voice')}
              <ul class="w-chat-members" data-story-members>${['sasha','lena','misha'].map(id=>`<li data-story-who="${id}">${chatAvatar(id,a.people,18)}<span>${a.people[id].name}</span></li>`).join('')}<li data-story-you hidden>${chatAvatar('me',a.people,18)}<span>${a.people.me.name}</span><small>${c.here}</small></li></ul>
              ${row('screen',a.rooms.screen,'speaker','voice')}
              <div class="w-chat-nav-links"><a class="w-chat-nav-row" href="#w-server" data-goto="w-server">${icon('home',19)}<span>${a.server}</span></a><a class="w-chat-nav-row" href="#w-download" data-goto="w-download">${icon('download',19)}<span>${a.download}</span></a></div>
            </div>
            <div class="w-story-people" data-nav-people hidden></div>
            <div class="w-chat-me"><span>${a.people.me.name}</span><a href="#w-sound" data-goto="w-sound" aria-label="${a.settings}" title="${a.settings}">${icon('settings',21)}</a></div>
            <span class="w-story-collapse" data-collapse aria-hidden="true">${icon('chevronRight',16)}</span>
          </aside>
          <div class="w-desk" data-desk>
            <div class="w-desk-columns" data-columns></div>
            <div class="w-pane-parking" data-pane-parking>
              ${pane('chat',`# ${a.channels.general}`,chat(ctx))}
              ${pane('links',`# ${a.channels.links}`,links)}
              ${pane('voice',a.rooms.voice,voice(ctx))}
              ${pane('screen',a.rooms.screen,screen(ctx))}
            </div>
            <div class="w-desk-drop" data-desk-drop hidden></div>
            <div class="w-story-picker" data-story-picker aria-hidden="true" hidden>
              <b>${lang === 'ru' ? 'Показать экран' : 'Share screen'}</b>
              <div class="w-story-sources"><span data-story-source><i class="w-variants-thumb"><i></i><i></i></i>${lang === 'ru' ? 'Варианты' : 'Options'}</span><span><i class="w-desktop-thumb"></i>${lang === 'ru' ? 'Весь экран' : 'Entire screen'}</span></div>
              <footer><span>${icon('check',14)}${lang === 'ru' ? 'Передавать звук' : 'Share audio'}</span><b data-story-share>${lang === 'ru' ? 'Начать показ' : 'Start sharing'}</b></footer>
            </div>
            <div class="w-desk-menu" data-desk-menu aria-hidden="true" hidden>
              <span>${c.tabs}</span><span>${c.expand}</span><span data-story-menu-float>${c.float}</span><span>${c.popout}</span>
              <label class="w-script-opacity" data-script-opacity hidden><span>${c.opacity}</span><i><b></b></i><output>100%</output></label>
            </div>
          </div>
        </div>
        <div class="w-story-modal" data-settings hidden>
          <div class="w-story-backdrop"></div>
          <div class="w-story-settings" role="dialog" aria-modal="false" aria-label="${c.settings}">
            <header><b>${c.settings}</b><button type="button" data-close-settings aria-label="${c.closeSettings}">${icon('x',20)}</button></header>
            <div class="w-settings-body">
              <nav class="w-settings-nav" aria-label="${c.settings}">${[['profile'],[],['sound',c.voice],['appearance',c.appearance],[],[]].map(entry).join('')}</nav>
              <div data-setting-page="profile" class="w-settings-profile" aria-hidden="true">${chatAvatar('me',a.people,56)}<i style="--w:42%"></i><i style="--w:64%"></i><b></b><b></b></div>
              <div data-setting-page="sound" hidden>${sound(ctx)}</div>
              <div data-setting-page="appearance" class="w-appearance" hidden>
                <div class="w-theme-swatches">${Object.entries(themes).map(([id,t])=>`<button type="button" data-theme-pick="${id}" aria-pressed="${id === 'petrol'}" style="--swatch:${t['--bg-island']};--swatch-ink:${t['--text']}" title="${id[0].toUpperCase()+id.slice(1)}"><i></i><span>${id[0].toUpperCase()+id.slice(1)}</span></button>`).join('')}<button type="button" data-theme-pick="custom" aria-pressed="false"><i class="w-custom-swatch"></i><span>${c.custom}</span></button></div>
                <div class="w-custom-theme" data-custom-theme hidden>
                  <label class="w-theme-light"><input type="checkbox" data-custom="light">${c.light}</label>
                  ${range('hue',0,360,190)}${range('tint',0,100,40)}${range('depth',0,100,50)}${range('contrast',0,100,50)}
                  <label class="w-theme-range"><span>${c.accent}</span><input type="color" value="#e6b25c" data-custom="accent"></label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="w-story-copy">
        ${c.chapters.map((chapter,i)=>`<div data-chapter-copy="${chapter.id}"${i ? ' hidden' : ''}>
          <p class="w-room">${icon(chapterIcons[chapter.id],15)}${chapter.label}</p>
          <h2 class="w-h2" id="w-${chapter.id}-title">${chapter.title}</h2><p class="w-lead">${chapter.lead}</p>
          ${i===0 ? chatControls(ctx) : ''}
          <button class="w-story-replay" type="button" data-replay="${chapter.id}">${icon('chevronRight',14)}${c.replay}</button>
          <nav class="w-story-chapters" aria-label="${lang === 'ru' ? 'Возможности' : 'Features'}">${c.chapters.map((ch,n)=>`<a href="#w-${ch.id}" data-story-go="${ch.id}" aria-label="${ch.title}" title="${ch.title}"><i></i></a>`).join('')}</nav>
        </div>`).join('')}
      </div>
    </div>
  </div>
  <div class="w-story-steps">${c.chapters.map((ch,i)=>`<div class="w-story-step" id="w-${ch.id}" data-chapter="${ch.id}" aria-labelledby="w-${ch.id}-title" style="height:calc(var(--story-height) * ${script.chapters[i].length / 100})"></div>`).join('')}</div>
  <noscript><style>.w-workstory .w-story-pin,.w-workstory .w-story-steps{display:none}</style><div class="w-story-fallback">${c.chapters.map(ch=>`<section><h2>${ch.title}</h2><p>${ch.lead}</p></section>`).join('')}</div></noscript>
  <span class="w-script-cursor" data-script-cursor aria-hidden="true" hidden><svg viewBox="0 0 24 28"><path d="M3 2 21 17 13 18 9 26Z"/></svg></span>
  <span class="w-script-ghost" data-script-ghost aria-hidden="true" hidden></span>
  ${json('w-workspace-copy',c)}
</section>`;
}
