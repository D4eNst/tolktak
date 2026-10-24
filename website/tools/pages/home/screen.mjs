import { copy as site } from '../../copy.mjs';
import { ava, fill, icon, json, person } from '../../html.mjs';
import { screen as copy } from '../../../content/home/screen.mjs';

export const friends = ['katya'];
const thumbs = { board: '', notes: '<i></i>'.repeat(4), player: '<i></i>' };
// A game in progress: [row, column] of each piece on the dark squares.
const black = [[0, 1], [0, 5], [1, 2], [1, 6], [2, 1], [2, 3], [3, 6]];
const white = [[4, 3], [5, 0], [5, 4], [5, 6], [6, 1], [6, 3], [7, 0], [7, 4]];
const place = ([r, c]) => `left:${c * 12.5}%;top:${r * 12.5}%`;

export default function screen(ctx) {
  const { lang } = ctx;
  const c = copy[lang];
  const pieces = [...black.map(at => ['b', at]), ...white.map(at => ['w', at])];
  const check = `<span class="w-screen-check" aria-hidden="true">${icon('check', 13)}</span>`;
  const live = `<span class="w-live">${site[lang].live}</span>`;
  return `<section class="w-scene w-screen" id="w-screen" aria-labelledby="w-screen-title">
  <div class="w-scene-text w-screen-text">
    <div class="w-screen-head">
      <p class="w-room w-room--voice">${icon('speaker', 15)}${c.room}</p>
      <h2 class="w-h2" id="w-screen-title">${c.title}</h2>
      <p class="w-lead">${c.lead}</p>
    </div>
    <ul class="w-facts">
      <li>${icon('screen', 18)}${c.facts[0]}</li>
      <li>${icon('headphones', 18)}${c.facts[1]}</li>
      <li>${icon('speaker', 18)}${c.facts[2]}</li>
    </ul>
  </div>
  <div class="w-stage w-screen-stage">
    <div class="w-screen-app w-win" data-state="live" data-source="window" data-view="board" data-audio="on">
      <header class="w-screen-bar">
        <span class="w-screen-bar-icon">${icon('speaker', 16)}</span>
        <b>${c.roomTitle}</b>
        <span class="w-screen-sub"><span>${fill(c.inRoom, { n: friends.length + 1 })}</span><span class="w-screen-info"> · ${fill(c.sharing, { name: `<span data-src-name>${c.windows.board}</span>` })} <span data-src-audio>${c.audio.app}</span></span></span>
      </header>
      <div class="w-screen-main">
        <figure class="w-screen-stream" aria-label="${c.yourStream}">
          <div class="w-screen-desk" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="w-screen-window">
            <div class="w-screen-wtitle" aria-hidden="true"><i></i><i></i><i></i><span data-wtitle>${c.windows.board}</span></div>
            <div class="w-screen-game">
              <div class="w-screen-board" data-board tabindex="-1">
                ${pieces.map(([side, at]) => `<button class="w-screen-pc is-${side}" type="button" data-r="${at[0]}" data-c="${at[1]}" style="${place(at)}" aria-label="${side === 'b' ? c.piece.black : c.piece.white}" disabled></button>`).join('\n                ')}
              </div>
              <div class="w-screen-side" aria-live="polite">
                <p class="w-screen-turn" data-turn>${c.turn.yours}</p>
                <p class="w-screen-score"><span data-score-w>0</span> : <span data-score-b>0</span></p>
              </div>
            </div>
            <div class="w-screen-other is-notes" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <div class="w-screen-other is-player" aria-hidden="true"><b>${icon('play', 22)}</b><i></i></div>
          </div>
          <figcaption class="w-screen-tag">${live}<span>${c.yourStream}</span><span class="w-screen-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span></figcaption>
        </figure>
        <div class="w-screen-idle" aria-hidden="true">
          ${[...friends, 'me'].map(id => `<div class="w-screen-tile">${ava(id, lang, 56)}<span class="w-screen-name">${person(id, lang).name}</span></div>`).join('\n          ')}
        </div>
        <div class="w-screen-picker" role="dialog" aria-modal="false" aria-labelledby="w-screen-picker-title" hidden>
          <div class="w-screen-pick">
            <header class="w-screen-pick-head">
              <b id="w-screen-picker-title">${c.picker.title}</b>
              <button class="w-screen-x" type="button" data-pick-cancel aria-label="${c.picker.close}">${icon('x', 16)}</button>
            </header>
            <div class="w-screen-tabs" role="tablist">
              <button type="button" role="tab" id="w-screen-tab-screens" aria-controls="w-screen-list-screens" data-tab="screens" aria-selected="false" tabindex="-1">${c.picker.screens}</button>
              <button type="button" role="tab" id="w-screen-tab-windows" aria-controls="w-screen-list-windows" data-tab="windows" aria-selected="true">${c.picker.windows}</button>
            </div>
            <div class="w-screen-srcs" id="w-screen-list-windows" role="tabpanel" aria-labelledby="w-screen-tab-windows" data-list="windows">
              ${Object.entries(thumbs).map(([view, thumb]) => `<button type="button" class="w-screen-src${view === 'board' ? ' is-picked' : ''}" data-kind="window" data-view="${view}" data-name="${c.windows[view]}"><span class="w-screen-thumb is-${view}" aria-hidden="true">${thumb}</span><span>${c.windows[view]}</span></button>`).join('\n              ')}
            </div>
            <div class="w-screen-srcs" id="w-screen-list-screens" role="tabpanel" aria-labelledby="w-screen-tab-screens" data-list="screens" hidden>
              <button type="button" class="w-screen-src" data-kind="screen" data-view="board" data-name="${c.screens[0]}"><span class="w-screen-thumb is-desk" aria-hidden="true"><i></i></span><span>${c.screens[0]}</span></button>
              <button type="button" class="w-screen-src" data-kind="screen" data-view="board" data-name="${c.screens[1]}"><span class="w-screen-thumb is-desk is-empty" aria-hidden="true"></span><span>${c.screens[1]}</span></button>
            </div>
            <label class="w-screen-audio">
              <input type="checkbox" checked data-pick-audio>
              ${check}
              <span><b>${c.picker.audio}</b><small data-audio-hint>${c.audioHint.app}</small></span>
            </label>
            <footer class="w-screen-pick-foot">
              <button type="button" class="w-btn w-btn--sm" data-pick-cancel>${c.picker.cancel}</button>
              <button type="button" class="w-btn w-btn--sm w-screen-go" data-pick-go>${c.picker.start}</button>
            </footer>
          </div>
        </div>
      </div>
      <div class="w-screen-foot">
        <ul class="w-screen-people" aria-label="${c.people}">
          ${[...friends, 'me'].map(id => `<li>${ava(id, lang, 32)}</li>`).join('')}
        </ul>
        <div class="w-screen-ctrls">
          <span class="w-screen-ctl" aria-hidden="true">${icon('mic', 18)}</span>
          <span class="w-screen-ctl" aria-hidden="true">${icon('headphones', 18)}</span>
          <span class="w-screen-ctl" aria-hidden="true">${icon('videoOff', 18)}</span>
          <button class="w-screen-ctl w-screen-share" type="button" data-share aria-label="${c.share}" title="${c.share}" data-needs-js>${icon('screen', 18)}</button>
          <button class="w-screen-ctl w-screen-stop" type="button" data-stop aria-label="${c.stop}" data-needs-js>${icon('stop', 14)}<span>${c.stop}</span></button>
          <span class="w-screen-ctl is-leave" aria-hidden="true">${icon('phoneOff', 18)}</span>
        </div>
      </div>
      <p class="w-hint w-screen-hint is-off" data-hint></p>
    </div>
    <aside class="w-screen-viewer w-win" data-live="on" data-view="board" aria-label="${c.viewerLabel}">
      <header class="w-screen-vhead">${ava('katya', lang, 22)}<b>${fill(c.viewer, { name: person('katya', lang).name })}</b></header>
      <div class="w-screen-mini" aria-hidden="true">
        <div class="w-screen-mini-board" data-mini>${pieces.map(([side, at]) => `<i class="is-${side}" style="${place(at)}"></i>`).join('')}</div>
        ${live}
      </div>
      <div class="w-screen-vbar">
        <p class="w-screen-vwho">${live}<b>${person('me', lang).name}</b></p>
        <label class="w-screen-slider">
          <span class="w-screen-slabel">${c.stream}</span>
          <input type="range" min="0" max="100" value="80" data-vol="stream" aria-label="${c.stream}">
          <output data-out="stream">80%</output>
          <span class="w-screen-meter" aria-hidden="true"><i data-meter="stream"></i></span>
        </label>
        <label class="w-screen-slider">
          <span class="w-screen-slabel">${c.voices}</span>
          <input type="range" min="0" max="100" value="100" data-vol="voice" aria-label="${c.voices}">
          <output data-out="voice">100%</output>
          <span class="w-screen-meter is-voice" aria-hidden="true"><i data-meter="voice"></i></span>
        </label>
        <label class="w-screen-duck">
          <input type="checkbox" checked data-duck>
          ${check}
          <span>${c.duck}</span>
        </label>
        <p class="w-screen-ducknote" data-ducknote>${c.duckNote}</p>
      </div>
    </aside>
  </div>
  ${json('w-screen-copy', { audio: c.audio, audioHint: c.audioHint, turn: c.turn, piece: c.piece, target: c.target, hint: c.hint, board: c.windows.board })}
</section>`;
}
