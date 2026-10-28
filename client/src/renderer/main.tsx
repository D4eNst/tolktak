import { render } from 'preact';
import './styles.css';
import { paint } from './theme';
import { App } from './ui/App';

paint(document);

// `autofocus` works only on page load, and dialogs are inserted later.
new MutationObserver((records) => {
  for (const r of records)
    for (const n of r.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      const el = n.hasAttribute('autofocus') ? n : n.querySelector<HTMLElement>('[autofocus]');
      if (el) return void requestAnimationFrame(() => el.focus());
    }
}).observe(document.body, { childList: true, subtree: true });

render(<App />, document.getElementById('app')!);
