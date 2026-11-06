import type en from '../en/moderation';

const moderation: typeof en = {
  title: 'Модерация звонка',
  restrictions: 'Ограничения',
  participant: 'Действия с участником',
  microphone: 'Микрофон',
  camera: 'Камера',
  screen: 'Трансляция',
  entry: 'Вход в звонок',
  turnOff: 'Выключить',
  restrict: 'Запретить включение',
  fiveMinutes: 'На 5 минут',
  thirtyMinutes: 'На 30 минут',
  hour: 'На час',
  custom: 'Другое время…',
  minutes: 'Минуты',
  duration: 'Срок ограничения',
  untilEnd: 'До конца звонка',
  permanent: 'Бессрочно',
  until: (time: string) => `До ${time}`,
  remove: 'Снять ограничение',
  empty: 'Ограничений нет',
  kick: 'Исключить из звонка',
  kickTitle: (name: string) => `Исключить ${name} из звонка?`,
  kickText: 'Вернуться можно будет после завершения текущего звонка.',
  removed: 'Вы исключены из звонка',
  permissionDenied: (source) => ({ microphone: 'Микрофон отключён модератором', camera: 'Камера отключена модератором', screen: 'Трансляция запрещена модератором' })[source],
};

export default moderation;
