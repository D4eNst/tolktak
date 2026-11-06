import type en from '../en/launch';

const ru: typeof en = {
  checking: 'Проверка обновлений',
  downloading: (v) => `Загрузка версии ${v}`,
  progress: (done, total, speed) => `${done} из ${total} МБ · ${speed} МБ/с`,
  installing: 'Установка обновления',
  installingDetail: 'TolkTak будет перезапущен автоматически.',
  starting: 'Запуск TolkTak',
  offline: 'Сервер не отвечает',
  offlineDetail: 'Запуск без проверки обновлений',
  failed: 'Загрузка прервалась',
  required: (v) => `Для подключения требуется версия ${v} или новее`,
  available: (v) => `Доступна версия ${v}`,
  manualMac: 'На macOS требуется ручная установка обновления',
  manualOther: 'Требуется ручная установка обновления',
  retry: 'Повторить',
  downloadManually: 'Скачать вручную',
  download: 'Скачать',
  later: 'Позже',
  quit: 'Закрыть приложение',
};

export default ru;
