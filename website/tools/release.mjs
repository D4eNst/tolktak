import { url } from './urls.mjs';

const files = {
  windows: [['installer', /Setup.*\.exe$/i]],
  macos: [['appleSilicon', /mac-arm64\.dmg$/], ['intel', /mac-x64\.dmg$/]],
  linux: [['deb', /\.deb$/], ['appImage', /\.AppImage$/]],
};
export const installers = Object.values(files).flat().map(([, pattern]) => pattern);
export const systems = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

// Installers of a release grouped by system: { windows: [{ key, name, ext, size, url, digest }], … }.
export function builds(release) {
  return Object.fromEntries(Object.entries(files).map(([os, list]) => [os, list.map(([key, pattern]) => {
    const asset = release.assets.find(a => pattern.test(a.name));
    return { key, ...asset, ext: asset.name.slice(asset.name.lastIndexOf('.')) };
  })]));
}

export const megabytes = (bytes, lang) => (bytes / 1048576).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const releaseDate = (iso, lang) => new Date(iso)
  .toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })
  .replace(/ г\.$/, '');

// What the "Download" buttons become once the visitor's system is known. Windows gets the
// installer directly; macOS and Linux have two builds each, so they open the download page there.
export function downloadTargets(release, lang, copy) {
  const installer = builds(release).windows[0].url;
  return Object.fromEntries(Object.entries(systems).map(([os, name]) => [os, {
    href: os === 'windows' ? installer : url(lang, `download/#${os}`),
    label: `${copy.downloadFor} ${name}`,
    meta: `${copy.version} ${release.version} · ${copy.osBuilds[os]}`,
  }]));
}
