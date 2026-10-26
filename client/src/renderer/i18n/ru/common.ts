import type en from '../en/common';

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const ru: typeof en = {
  close: 'Закрыть',
  cancel: 'Отмена',
  save: 'Сохранить',
  yes: 'Да',
  name: 'Название',
  copied: 'Скопировано',
  copyFailed: 'Не удалось скопировать',
  update: {
    ready: (v: string) => `Обновление TolkTak ${v} готово к установке`,
    available: (v: string) => `Доступна версия TolkTak ${v}`,
    restart: 'Перезапустить',
    download: 'Скачать',
    later: 'Позже',
  },
  time: {
    yesterdayAt: (time) => `вчера ${time}`,
    today: 'Сегодня',
    yesterday: 'Вчера',
  },
  size: { b: 'Б', kb: 'КБ', mb: 'МБ' },
  profile: {
    usernameCopied: 'Логин скопирован',
    copyUsername: 'Скопировать логин',
    statusPlaceholder: 'Чем заняты?',
    statusPresets: ['🎮 Играю', '🍿 Смотрю', '🎧 Слушаю музыку', '💻 Работаю', '🌙 Скоро сплю', '🚫 Не беспокоить'],
    clearStatus: 'Очистить',
    setStatus: 'Указать статус',
    about: 'О себе',
    online: '● в сети',
    offline: 'не в сети',
    memberSince: (d) => `с нами с ${MONTHS_GENITIVE[d.getMonth()]} ${d.getFullYear()}`,
    editProfile: 'Редактировать профиль',
    message: 'Написать',
    call: 'Позвонить',
  },
  login: {
    tagline: 'Голос, чат и кино вместе с друзьями — на вашем собственном сервере.',
    serverRequired: 'Сначала укажите адрес сервера',
    server: 'Адрес сервера',
    otherServer: 'Другой сервер',
    username: 'Логин',
    password: 'Пароль',
    signingIn: 'Входим…',
    signIn: 'Войти',
    register: 'Нет аккаунта? Регистрация на сайте сервера',
    showPassword: 'Показать пароль',
    hidePassword: 'Скрыть пароль',
    capsLock: 'Включён Caps Lock',
  },
};

export default ru;
