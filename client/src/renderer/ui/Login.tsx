import { useEffect, useState } from 'preact/hooks';
import { normalizeServer } from '../api';
import { bridge } from '../bridge';
import { t } from '../i18n';
import { errorText, login } from '../state';
import { Icon } from './common';

export function Login() {
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editServer, setEditServer] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [caps, setCaps] = useState(false);
  const tl = t().common.login;

  useEffect(() => {
    bridge.getSettings().then((s) => setServer(s.server || __DEFAULT_SERVER__));
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(server, username.trim(), password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const register = () => {
    const origin = normalizeServer(server);
    if (!origin) {
      setError(tl.serverRequired);
      return;
    }
    bridge.openExternal(origin + '/');
  };

  return (
    <div class="login">
      <div class="login-glow" aria-hidden="true" />
      <form class="login-card pop-in" onSubmit={submit}>
        <div class="brand">
          <span class="logo-mark big" />
          <span>TolkTak</span>
        </div>
        <p class="login-tagline">{tl.tagline}</p>
        {!__DEFAULT_SERVER__ || editServer || normalizeServer(server) !== normalizeServer(__DEFAULT_SERVER__) ? (
          <label>
            {tl.server}
            <input name="server" value={server} onInput={(e) => setServer((e.target as HTMLInputElement).value)} placeholder="talk.example.com" required autoFocus={!server} />
          </label>
        ) : (
          <div class="server-chip">
            <span class="dot ok" />
            <span class="ellipsis">{server.replace(/^https?:\/\//, '')}</span>
            <button type="button" class="link small" onClick={() => setEditServer(true)}>
              {tl.otherServer}
            </button>
          </div>
        )}
        <label>
          {tl.username}
          <input name="username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} autoComplete="username" required autoFocus={!!server} />
        </label>
        <label>
          {tl.password}
          <span class="pw-field">
            <input
              name="password"
              type={showPw ? 'text' : 'password'}
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))}
              autoComplete="current-password"
              required
            />
            <button type="button" class={'icon-btn' + (showPw ? ' active' : '')} onClick={() => setShowPw(!showPw)} title={showPw ? tl.hidePassword : tl.showPassword} aria-label={showPw ? tl.hidePassword : tl.showPassword}>
              <Icon name="eye" size={16} />
            </button>
          </span>
        </label>
        {caps && <p class="hint warn">{tl.capsLock}</p>}
        {error && <p class="error" role="alert">{error}</p>}
        <button class="primary" type="submit" disabled={busy}>
          {busy ? tl.signingIn : tl.signIn}
        </button>
        <button type="button" class="link" onClick={register}>
          {tl.register}
        </button>
      </form>
    </div>
  );
}
