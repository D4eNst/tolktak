'use strict';
const $ = (id) => document.getElementById(id);

const dict = {
  en: {
    'nav.docs': 'Docs',
    'nav.admin': 'Admin',
    'hero.title': 'Your own voice and chat server',
    'hero.tagline': 'Voice rooms, chat, screen sharing and watch parties, hosted on this server.',
    'reg.title': 'Create an account',
    'reg.username': 'Username',
    'reg.display': 'Display name (optional)',
    'reg.password': 'Password (at least 8 characters)',
    'reg.invite': 'Invite code',
    'reg.password2': 'Repeat the password',
    'reg.show': 'Show password',
    'reg.mismatch': 'The passwords do not match.',
    'reg.submit': 'Create account',
    'reg.closed': 'Registration is closed on this server. Ask the administrator to create an account for you.',
    'reg.first': 'This server has no accounts yet. The first account becomes the administrator.',
    'reg.busy': 'Creating account…',
    'reg.done': 'Account created. Sign in to the TolkTak client as “{user}”.',
    'reg.failed': 'Registration failed.',
    'server.down': 'The server is unavailable.',
    'connect.title': 'Connect',
    'connect.install': 'Install the TolkTak desktop app for Windows, macOS or Linux.',
    'connect.download': 'Download',
    'connect.address': 'In the sign-in window, enter the server address:',
    'connect.signin': 'Sign in with your username and password.',
    'foot.oss': 'TolkTak is open source',
  },
  ru: {
    'nav.docs': 'Документация',
    'nav.admin': 'Администрирование',
    'hero.title': 'Собственный сервер для голоса и чатов',
    'hero.tagline': 'Голосовые комнаты, чаты, демонстрация экрана и совместный просмотр на этом сервере.',
    'reg.title': 'Регистрация',
    'reg.username': 'Логин',
    'reg.display': 'Отображаемое имя (необязательно)',
    'reg.password': 'Пароль (не короче 8 символов)',
    'reg.invite': 'Код приглашения',
    'reg.password2': 'Повторите пароль',
    'reg.show': 'Показать пароль',
    'reg.mismatch': 'Пароли не совпадают.',
    'reg.submit': 'Создать аккаунт',
    'reg.closed': 'Регистрация на этом сервере закрыта. Попросите администратора создать вам аккаунт.',
    'reg.first': 'На сервере ещё нет аккаунтов. Первый аккаунт станет администратором.',
    'reg.busy': 'Создаём аккаунт…',
    'reg.done': 'Аккаунт создан. Войдите в клиент TolkTak под логином «{user}».',
    'reg.failed': 'Не удалось зарегистрироваться.',
    'server.down': 'Сервер недоступен.',
    'connect.title': 'Подключение',
    'connect.install': 'Установите приложение TolkTak для Windows, macOS или Linux.',
    'connect.download': 'Скачать',
    'connect.address': 'В окне входа укажите адрес сервера:',
    'connect.signin': 'Войдите своим логином и паролем.',
    'foot.oss': 'TolkTak — проект с открытым исходным кодом',
    'err.rate_limited': 'Слишком много попыток, подождите минуту.',
    'err.bad_username': 'Логин: 3–32 символа, латиница, цифры, _ . -',
    'err.bad_password': 'Пароль: от 8 до 256 символов.',
    'err.invite_required': 'Нужен код приглашения.',
    'err.registration_closed': 'Регистрация на этом сервере закрыта.',
    'err.username_taken': 'Этот логин уже занят.',
    'err.invite_invalid': 'Код приглашения недействителен, истёк или исчерпан.',
    'err.bad_request': 'Некорректный запрос.',
  },
};

let status = { cls: 'msg', render: () => '' };
function setStatus(cls, render) {
  status = { cls, render };
  showStatus();
}
function showStatus() {
  $('reg-msg').className = status.cls;
  $('reg-msg').textContent = status.render();
}

i18n.onChange(showStatus);
i18n.init(dict);

async function init() {
  $('addr').textContent = location.origin;
  const info = await fetch('/api/v1/server').then((r) => r.json());
  $('name').textContent = info.name;
  document.title = info.name + ' · TolkTak';
  $('ver').textContent = 'TolkTak ' + info.version;
  if (info.client_download_url) {
    $('dl').href = info.client_download_url;
    $('dl').hidden = false;
  }
  if (info.registration === 'closed') {
    $('reg-form').hidden = true;
    $('closed').hidden = false;
  }
  if (info.registration !== 'invite') $('invite-row').hidden = true;
  if (info.registration === 'first') setStatus('msg', () => i18n.t('reg.first'));
  const code = new URLSearchParams(location.search).get('invite');
  if (code) $('reg-form').invite.value = code;
}

$('show-pw').addEventListener('change', (e) => {
  const f = $('reg-form');
  for (const el of [f.password, f.password2]) el.type = e.target.checked ? 'text' : 'password';
});

$('reg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.password2.value) {
    setStatus('msg err', () => i18n.t('reg.mismatch'));
    f.password2.focus();
    return;
  }
  setStatus('msg', () => i18n.t('reg.busy'));
  try {
    const res = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: f.username.value.trim(),
        display_name: f.display_name.value,
        password: f.password.value,
        invite: f.invite.value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus('msg err', () => i18n.errorText(body, 'reg.failed'));
      return;
    }
    f.reset();
    setStatus('msg ok', () => i18n.t('reg.done', { user: body.user.username }));
  } catch {
    setStatus('msg err', () => i18n.t('server.down'));
  }
});

init().catch(() => setStatus('msg err', () => i18n.t('server.down')));
