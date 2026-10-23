export const copy = {
  ru: {
    description: 'Голосовые комнаты, переписка и демонстрация экрана для своей компании. Открытое приложение для Windows, macOS и Linux и сервер, которым управляете вы.',
    nav: ['Возможности', 'Скачать', 'Документация'], source: 'Исходный код', menu: 'Меню', skip: 'К содержимому',
    download: 'Скачать приложение', host: 'Установить сервер',
    releaseLink: 'Что изменилось',
    footerText: 'Голос, видео и чат на своём сервере.', footerDocs: 'Документация', footerProject: 'Проект', footerLicense: 'Открытый код · AGPL-3.0-or-later', security: 'Безопасность', contribute: 'Участие в проекте',
    desktopGuide: 'Инструкция к приложению', releaseNotes: 'История версий',
    docs: 'Документация', search: 'Поиск по документации', searchPlaceholder: 'Что хотите настроить?', searchHint: 'Например: микрофон, порты, приглашения', noResults: 'Ничего не найдено. Попробуйте другое слово.', searchLoading: 'Загружаем поиск…', searchError: 'Не удалось загрузить поиск. Используйте меню документации.', close: 'Закрыть', onPage: 'На этой странице', previous: 'Назад', next: 'Далее', edit: 'Исходник страницы', docsMenu: 'Разделы документации',
    groups: ['Начало работы', 'Сеть и база данных', 'Управление сервером', 'Разработка'],
    missingTitle: 'Такой страницы нет', missingText: 'Возможно, адрес изменился. Вернитесь на главную или найдите нужную инструкцию в документации.', home: 'На главную',
  },
  en: {
    description: 'Voice rooms, chat and screen sharing for your group. An open-source app for Windows, macOS and Linux, with a server you run yourself.',
    nav: ['Features', 'Download', 'Documentation'], source: 'Source code', menu: 'Menu', skip: 'Skip to content',
    download: 'Download the app', host: 'Run a server',
    releaseLink: 'Release notes',
    footerText: 'Voice, video and chat on your own server.', footerDocs: 'Documentation', footerProject: 'Project', footerLicense: 'Open source · AGPL-3.0-or-later', security: 'Security', contribute: 'Contributing',
    desktopGuide: 'Desktop app guide', releaseNotes: 'Release history',
    docs: 'Documentation', search: 'Search documentation', searchPlaceholder: 'What would you like to set up?', searchHint: 'Try: microphone, ports, invites', noResults: 'No results. Try another word.', searchLoading: 'Loading search…', searchError: 'Search could not load. Use the documentation menu.', close: 'Close', onPage: 'On this page', previous: 'Previous', next: 'Next', edit: 'Page source', docsMenu: 'Documentation sections',
    groups: ['Getting started', 'Network and database', 'Server administration', 'Development'],
    missingTitle: 'Page not found', missingText: 'The address may have changed. Head back to the homepage or look for a guide in the documentation.', home: 'Back to home',
  },
};

export const docGroups = [
  ['index', 'install/desktop-app', 'install/requirements', 'install/docker', 'install/source'],
  ['guides/domains', 'guides/certificates', 'guides/reverse-proxy', 'guides/firewall', 'guides/postgres'],
  ['operations/configuration', 'operations/administration', 'operations/maintenance', 'operations/troubleshooting'],
  ['development/architecture', 'development/building', 'development/api'],
];
