import type en from '../en/launch';

const ru: typeof en = {
  checking: 'Проверяем обновления',
  checkingDetail: 'Спрашиваем сервер, какая версия нужна',
  downloading: (v) => `Загружаем ${v}`,
  progress: (done, total, speed) => `${done} из ${total} МБ · ${speed} МБ/с`,
  installing: 'Устанавливаем',
  installingDetail: 'Окно закроется и откроется само',
  starting: 'Запускаем TolkTak',
  offline: 'Сервер не отвечает',
  offlineDetail: 'Запускаем без проверки',
  failed: 'Загрузка прервалась',
  required: (v) => `Серверу нужна версия ${v} или новее`,
  available: (v) => `Доступна версия ${v}`,
  manualMac: 'На macOS обновление ставится вручную',
  manualOther: 'Эта сборка обновляется вручную',
  retry: 'Повторить',
  downloadManually: 'Скачать вручную',
  download: 'Скачать',
  later: 'Позже',
  quit: 'Выйти',
};

export default ru;
