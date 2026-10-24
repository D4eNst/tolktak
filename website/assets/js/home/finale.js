import { conversation, visible } from '../site.js';

const section = document.getElementById('w-download');
const scene = section.querySelector('.w-fin-scene');

let shut = 0;
const open = () => {
  clearTimeout(shut);
  scene.classList.add('is-open');
};
const close = () => {
  clearTimeout(shut);
  shut = setTimeout(() => scene.classList.remove('is-open'), 380);
};
section.querySelectorAll('[data-door]').forEach(el => {
  el.addEventListener('pointerenter', open);
  el.addEventListener('pointerleave', close);
  el.addEventListener('focusin', open);
  el.addEventListener('focusout', close);
});

const talk = conversation(() => [...scene.querySelectorAll('.w-fin-p')], { min: 1100, max: 3000 });
visible(scene, () => talk.start(), () => talk.stop());
