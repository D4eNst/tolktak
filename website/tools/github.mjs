import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const github = 'https://github.com/D4eNst/tolktak';
const api = 'https://api.github.com/repos/D4eNst/tolktak/releases?per_page=100';
const cache = new URL('../.cache/releases.json', import.meta.url);
const installers = [/Setup.*\.exe$/i, /win\.zip$/, /mac-arm64\.dmg$/, /mac-x64\.dmg$/, /\.deb$/, /\.AppImage$/];

function snapshot(release) {
  return {
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    published: release.published_at,
    url: release.html_url,
    notes: release.body || '',
    assets: release.assets.filter(asset => installers.some(re => re.test(asset.name))).map(({ name, size, browser_download_url, digest }) => ({
      name, size, url: browser_download_url, ...(digest ? { digest } : {}),
    })),
  };
}

// Published releases, newest first. Offline builds reuse the last successful answer.
export async function loadReleases() {
  let releases;
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const all = [];
    // GitHub returns the list in pages; the Link header names the next one.
    for (let next = api; next;) {
      const response = await fetch(next, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      all.push(...await response.json());
      next = response.headers.get('link')?.match(/<([^>]+)>; rel="next"/)?.[1];
    }
    releases = all.filter(r => !r.draft && !r.prerelease).map(snapshot);
    await mkdir(new URL('.', cache), { recursive: true });
    await writeFile(cache, JSON.stringify(releases, null, 2) + '\n');
  } catch (error) {
    releases = JSON.parse(await readFile(cache, 'utf8').catch(() => {
      throw new Error(`Cannot load releases from GitHub (${error.message}) and there is no cached copy`);
    }));
    console.warn(`Using cached releases: ${error.message}`);
  }
  const latest = releases.find(r => installers.every(re => r.assets.some(asset => re.test(asset.name))));
  if (!latest) throw new Error('No published release has all installers');
  return { latest, releases };
}
