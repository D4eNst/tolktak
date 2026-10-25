import { ruPlural } from '..';
import type en from '../en/groups';

const ru: typeof en = {
  roles: { owner: 'Владелец', mod: 'Модератор', member: 'Участник' },
  settings: {
    title: 'Настройки группы',
    saved: 'Сохранено',
    imageTooLarge: 'Картинка больше 8 МБ',
    tabs: { main: 'Оформление', members: 'Участники', channels: 'Каналы и комнаты' },
    changeImage: 'Сменить картинку',
    image: 'Картинка группы',
    imageHint: 'PNG, JPG, WebP или анимированный GIF до 8 МБ.',
    upload: 'Загрузить',
    remove: 'Убрать',
    name: 'Название',
    description: 'Описание',
    descriptionPlaceholder: 'О чём эта группа?',
    save: 'Сохранить',
    membersSummary: (total, online) => `${total} ${ruPlural(total, 'участник', 'участника', 'участников')} · ${online} в сети`,
    invite: 'Пригласить',
    actions: 'Действия',
    rolesHint: 'Модераторы могут создавать каналы и комнаты, закреплять и удалять сообщения, приглашать и исключать участников. Назначает модераторов владелец.',
    textChannels: 'Текстовые каналы',
    channel: 'Канал',
    voiceRooms: 'Голосовые комнаты',
    room: 'Комната',
  },
  channels: {
    newTextChannel: 'Новый текстовый канал',
    renameChannel: 'Переименовать канал',
    deleteChannelConfirm: (name) => `Удалить канал «${name}»?`,
    deleteChannelText: 'Вся история канала будет удалена.',
    newVoiceRoom: 'Новая голосовая комната',
    renameRoom: 'Переименовать комнату',
    deleteRoomConfirm: (name) => `Удалить комнату «${name}»?`,
    create: 'Создать',
    rename: 'Переименовать',
    delete: 'Удалить',
  },
  picker: {
    search: 'Поиск людей',
    empty: 'Никого не найдено',
  },
  create: {
    title: 'Новая группа',
    name: 'Название',
    namePlaceholder: 'Например, «Вечерний рейд»',
    hint: 'В группе сразу появятся текстовый канал и голосовая комната. Картинку, каналы и роли можно настроить потом.',
    create: 'Создать',
  },
  addMembers: {
    title: (group) => `Добавить в «${group}»`,
    add: 'Добавить',
  },
  switcher: {
    label: 'Быстрый переход',
    placeholder: 'Куда перейти? Люди, группы, каналы, комнаты…',
    group: 'группа',
    channel: (group) => `канал · ${group}`,
    voice: (group) => `голосовая · ${group}`,
    online: ' · в сети',
    empty: 'Ничего не найдено',
  },
  incoming: {
    calling: 'звонит вам',
    decline: 'Отклонить',
    accept: 'Принять',
  },
};

export default ru;
