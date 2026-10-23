'use strict';
const $ = (id) => document.getElementById(id);

const dict = {
  en: {
    'nav.docs': 'Docs',
    'nav.admin': 'Admin',
    'title': 'Administration',
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign in',
    'login.notAdmin': 'This account is not an administrator.',
    'login.failed': 'Sign-in failed.',
    'inv.title': 'Invites',
    'inv.uses': 'Max uses',
    'inv.days': 'Valid for, days',
    'inv.create': 'Create',
    'inv.code': 'Code',
    'inv.used': 'Used',
    'inv.expires': 'Expires',
    'inv.delete': 'Delete',
    'inv.none': 'No active invites.',
    'inv.link': 'Invite link:',
    'inv.placeholder': 'CODE',
    'server.down': 'The server is unavailable.',
  },
  ru: {
    'nav.docs': 'Документация',
    'nav.admin': 'Администрирование',
    'title': 'Администрирование',
    'login.username': 'Логин',
    'login.password': 'Пароль',
    'login.submit': 'Войти',
    'login.notAdmin': 'Этот аккаунт не является администратором.',
    'login.failed': 'Не удалось войти.',
    'inv.title': 'Приглашения',
    'inv.uses': 'Использований',
    'inv.days': 'Срок действия, дней',
    'inv.create': 'Создать',
    'inv.code': 'Код',
    'inv.used': 'Использовано',
    'inv.expires': 'Действует до',
    'inv.delete': 'Удалить',
    'inv.none': 'Активных приглашений нет.',
    'inv.link': 'Ссылка-приглашение:',
    'inv.placeholder': 'КОД',
    'server.down': 'Сервер недоступен.',
    'err.bad_credentials': 'Неверный логин или пароль.',
    'err.rate_limited': 'Слишком много попыток входа, подождите минуту.',
    'err.unauthorized': 'Сессия истекла, войдите снова.',
    'err.forbidden': 'Только для администратора.',
    'err.bad_request': 'Некорректный запрос.',
  },
};

// The admin token lives only in this tab's memory.
let token = '';
let invites = [];

class ApiError extends Error {
  constructor(body) {
    super(i18n.errorText(body, 'login.failed'));
    this.body = body;
  }
}

async function api(method, path, body) {
  const res = await fetch('/api/v1' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data);
  return data;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function render() {
  const tbody = $('invites');
  tbody.replaceChildren();
  if (!invites.length) {
    const td = cell(i18n.t('inv.none'));
    td.colSpan = 4;
    td.className = 'muted';
    const tr = document.createElement('tr');
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const inv of invites) {
    const tr = document.createElement('tr');
    const code = cell('');
    const c = document.createElement('code');
    c.textContent = inv.code;
    code.appendChild(c);
    tr.append(code, cell(inv.uses + ' / ' + inv.max_uses), cell(new Date(inv.expires_at).toLocaleString(i18n.lang)));
    const del = document.createElement('button');
    del.textContent = i18n.t('inv.delete');
    del.className = 'secondary';
    del.onclick = () => run(() => api('DELETE', '/admin/invites/' + encodeURIComponent(inv.code)));
    const td = document.createElement('td');
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  $('link-example').textContent = location.origin + '/?invite=' + (invites[0] ? invites[0].code : i18n.t('inv.placeholder'));
}

async function run(action) {
  $('panel-msg').textContent = '';
  try {
    await action();
    invites = (await api('GET', '/admin/invites')).invites;
    render();
  } catch (err) {
    $('panel-msg').textContent = err instanceof ApiError ? err.message : i18n.t('server.down');
  }
}

i18n.onChange(() => { if (token) render(); });
i18n.init(dict);

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('login-msg').textContent = '';
  try {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.username.value, password: f.password.value, device: 'web-admin' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data);
    if (!data.user.is_admin) {
      $('login-msg').textContent = i18n.t('login.notAdmin');
      return;
    }
    token = data.token;
    f.hidden = true;
    $('panel').hidden = false;
    run(() => {});
  } catch (err) {
    $('login-msg').textContent = err instanceof ApiError ? err.message : i18n.t('server.down');
  }
});

$('new-invite').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  run(() => api('POST', '/admin/invites', { max_uses: Number(f.max_uses.value), days: Number(f.days.value) }));
});
