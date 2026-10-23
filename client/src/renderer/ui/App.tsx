import { useEffect, useState } from 'preact/hooks';
import { bridge } from '../bridge';
import { t } from '../i18n';
import { installHotkeys, loadHotkeys } from '../keys';
import { boot, booting, incomingCall, session, settingsOpen, switcherOpen, toasts, totalUnread, typing } from '../state';
import { call, toggleMic } from '../voice';
import { LightboxHost } from './Chat';
import { AskHost, MenuHost } from './common';
import { IncomingCallDialog, QuickSwitcher } from './Dialogs';
import { Login } from './Login';
import { ProfileHost } from './Profile';
import { SettingsDialog } from './Settings';
import { Shell, TitleBar } from './Shell';

function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={'toast ' + t.kind}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function UpdateBar() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => bridge.onUpdateReady(setVersion), []);
  if (!version) return null;
  const tx = t().common.update;
  return (
    <div class="update-bar" role="status">
      <span>{tx.ready(version)}</span>
      <button class="primary" onClick={() => bridge.installUpdate()}>
        {tx.restart}
      </button>
      <button class="secondary" onClick={() => setVersion(null)}>
        {tx.later}
      </button>
    </div>
  );
}

function badgeImage(n: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 32, 32);
  grad.addColorStop(0, '#ff7a59');
  grad.addColorStop(1, '#ffb547');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(16, 16, 16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a1020';
  g.font = `bold ${n > 9 ? 16 : 20}px "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(n > 99 ? '99' : String(n), 16, 17);
  return c.toDataURL();
}

export function App() {
  useEffect(() => {
    boot();
    loadHotkeys();
    const offKeys = installHotkeys();
    const keys = (e: KeyboardEvent) => {
      if (!session.value) return;
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        switcherOpen.value = !switcherOpen.value;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyM' && call.value) {
        e.preventDefault();
        toggleMic();
      }
    };
    window.addEventListener('keydown', keys);
    // Typing indicators expire by time, not by event.
    const prune = setInterval(() => {
      const now = Date.now();
      let changed = false;
      const next = new Map<number, Map<number, number>>();
      for (const [cid, inner] of typing.value) {
        const live = new Map([...inner].filter(([, until]) => until > now));
        if (live.size !== inner.size) changed = true;
        if (live.size) next.set(cid, live);
      }
      if (changed) typing.value = next;
    }, 1000);
    return () => {
      offKeys();
      window.removeEventListener('keydown', keys);
      clearInterval(prune);
    };
  }, []);

  const unread = totalUnread.value;
  useEffect(() => {
    bridge.setBadge(unread, unread ? badgeImage(unread) : '').catch(() => {});
  }, [unread]);

  if (booting.value) {
    return (
      <div class="app-frame">
        <TitleBar />
        <div class="splash">
          <span class="logo-mark huge pulse" />
        </div>
      </div>
    );
  }
  return (
    <div class="app-frame">
      <TitleBar />
      {session.value ? <Shell /> : <Login />}
      {session.value && switcherOpen.value && <QuickSwitcher />}
      {session.value && settingsOpen.value && <SettingsDialog />}
      {session.value && incomingCall.value && <IncomingCallDialog />}
      <ProfileHost />
      <LightboxHost />
      <MenuHost />
      <AskHost />
      <Toasts />
      <UpdateBar />
    </div>
  );
}
