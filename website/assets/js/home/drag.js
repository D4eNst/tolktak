import { reducedMotion } from '../site.js';

const inside = (el, x, y) => {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};

// Drags a ghost made by `ghost()` from `handle` and calls `drop(target)` for the target it is
// released over. The click that may follow a drag on the handle is swallowed.
export function draggable(handle, { touch = true, tilt, ghost: makeGhost, targets, drop, start, end, ignore }) {
  let endedAt = -Infinity;
  handle.addEventListener('click', event => {
    if (performance.now() - endedAt < 400) event.stopImmediatePropagation();
  }, true);

  handle.addEventListener('pointerdown', down => {
    if (down.button !== 0 || (down.pointerType === 'touch' && !touch) || ignore?.(down)) return;
    let ghost = null;
    let size = null;
    let over = null;

    const move = event => {
      if (event.pointerId !== down.pointerId) return;
      if (!ghost) {
        if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < 6) return;
        ghost = makeGhost();
        ghost.classList.add('w-ghost');
        document.body.appendChild(ghost);
        size = { w: ghost.offsetWidth, h: ghost.offsetHeight };
        handle.classList.add('is-src');
        start?.();
      }
      event.preventDefault();
      const hit = targets().find(t => inside(t, event.clientX, event.clientY)) || null;
      if (hit !== over) {
        over?.classList.remove('is-over');
        over = hit;
        over?.classList.add('is-over');
      }
      ghost.style.transform = `translate(${event.clientX - size.w / 2}px, ${event.clientY - size.h / 2}px) rotate(${tilt}deg)`;
    };

    const finish = event => {
      if (event.pointerId !== down.pointerId) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', finish);
      removeEventListener('pointercancel', finish);
      if (!ghost) return;
      endedAt = performance.now();
      handle.classList.remove('is-src');
      over?.classList.remove('is-over');
      end?.();
      const target = event.type === 'pointerup' ? over : null;
      if (target) drop(target);
      if (reducedMotion) {
        ghost.remove();
        return;
      }
      const home = handle.getBoundingClientRect();
      const g = ghost;
      const animation = target
        ? g.animate([{ opacity: 1 }, { opacity: 0, transform: `${g.style.transform} scale(0.35)` }], { duration: 190, easing: 'ease-in' })
        : g.animate([{ transform: g.style.transform }, { transform: `translate(${home.left + home.width / 2 - size.w / 2}px, ${home.top + home.height / 2 - size.h / 2}px)`, opacity: 0.2 }], { duration: 400, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
      animation.onfinish = () => g.remove();
    };

    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', finish);
    addEventListener('pointercancel', finish);
  });
}
