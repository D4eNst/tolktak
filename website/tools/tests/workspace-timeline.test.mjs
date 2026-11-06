import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneAt, script, PACE } from '../../assets/js/home/workspace-timeline.js';
import { workspace } from '../../content/home/workspace.mjs';

test('panes stay within the workspace at every scroll position', () => {
  for (const [width, height, compact] of [[680, 638, false], [490, 450, false], [250, 550, true], [180, 280, true]]) {
    for (let tick = 0; tick <= script.end * 2; tick++) {
      const state = sceneAt(tick / 2, width, height, compact);
      for (const pane of [state.chat, state.room]) {
        assert.ok(Object.values(pane).every(Number.isFinite));
        assert.ok(pane.x >= 0 && pane.y >= 0 && pane.w > 0 && pane.h > 0);
        assert.ok(pane.x + pane.w <= width + .001);
        assert.ok(pane.y + pane.h <= height + .001);
      }
    }
  }
});

test('window geometry is continuous, including chapter boundaries', () => {
  for (const compact of [false, true]) {
    let previous = sceneAt(0, 680, 638, compact);
    for (let tick = 1; tick <= script.end * 2; tick++) {
      const next = sceneAt(tick / 2, 680, 638, compact);
      for (const name of ['chat', 'room']) {
        for (const key of ['x', 'y', 'w', 'h']) {
          assert.ok(Math.abs(next[name][key] - previous[name][key]) < 7, `${tick}: ${name}.${key}`);
        }
      }
      previous = next;
    }
  }
});

test('each result follows its demonstrated action', () => {
  const state = time => sceneAt(time, 680, 638);
  const { act, fx } = script;
  for (const [name, action] of [['tab', 'links'], ['split', 'voice'], ['stream', 'start'], ['floating', 'float'], ['settings', 'gear'], ['suppression', 'suppress']]) {
    assert.ok(fx[name][0] >= act[action].end, name);
    assert.equal(state(act[action].press)[name], 0, name);
    assert.equal(state(fx[name][1])[name], 1, name);
  }
  assert.equal(state(act.join.lift - .01).joined, false);
  assert.equal(state(act.join.lift).joined, true);
  assert.equal(state(act.opacity.end).opacity, .7);
  assert.equal(state(act.soundTab.lift - .01).page, 'profile');
  assert.equal(state(act.soundTab.lift).page, 'sound');
  assert.equal(state(act.appearanceTab.lift).page, 'appearance');
  assert.equal(state(act.suppress.lift).noisePicked, true);
  assert.equal(state(fx.close[1]).settings, 0);
  assert.equal(state(act.hue.end).hue, 245);
});

test('jumping and reversing restore the same layout without intermediate steps', () => {
  const positions = [0, ...script.rests, ...script.actions.flatMap(a => [a.start, a.press, a.lift, a.end]), script.end];
  const frames = positions.map(t => sceneAt(t, 680, 638));
  for (let i = positions.length - 1; i >= 0; i--) assert.deepEqual(sceneAt(positions[i], 680, 638), frames[i]);
  const reset = sceneAt(0, 680, 638);
  assert.equal(reset.joined, false);
  assert.equal(reset.stream, 0);
  assert.equal(reset.settings, 0);
  assert.deepEqual(reset.chat, { x: 0, y: 0, w: 680, h: 638 });
});

test('actions keep enough scroll distance for travel and dragging', () => {
  let previous = 0;
  for (const a of script.actions) {
    assert.ok(a.start >= previous, a.name);
    assert.ok(a.press - a.start >= 18 * PACE, `${a.name} travel`);
    assert.ok(a.lift > a.press, `${a.name} press`);
    if (a.kind !== 'click') assert.ok(a.end - a.lift >= 40 * PACE, `${a.name} carry`);
    previous = a.end;
  }
  for (const [name, [a, b]] of Object.entries(script.fx)) assert.ok(b - a >= 10 * PACE, name);
  assert.equal(script.chapters.reduce((n, c) => n + c.length, 0), script.end);
  assert.deepEqual(script.chapters.map(c => sceneAt(c.start, 680, 638).chapter), script.chapters.map(c => c.id));
});

test('captions and reduced-motion frames follow the window customisation section', () => {
  const ids = script.chapters.map(c => c.id);
  for (const copy of Object.values(workspace)) assert.deepEqual(copy.chapters.map(c => c.id), ids);
  assert.equal(script.rests.length, ids.length);
  assert.deepEqual(script.rests.map(t => sceneAt(t, 680, 638).chapter), ids);
  assert.equal(sceneAt(script.fx.stream[1], 680, 638).chapter, 'screen');
  assert.equal(sceneAt(script.act.chatMenu.start, 680, 638).chapter, 'layout');
  assert.equal(sceneAt(script.act.opacity.end, 680, 638).chapter, 'layout');
  assert.equal(sceneAt(script.act.gear.start, 680, 638).chapter, 'sound');
});
