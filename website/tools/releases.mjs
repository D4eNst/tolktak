import { writeFile } from 'node:fs/promises';

export function releaseSnapshot(release) {
  const assets = (release.assets || []).filter(a => /\.(exe|dmg|deb|AppImage|zip)$/.test(a.name));
  if (!release.tag_name || !assets.length) throw new Error('Release has no installable assets');
  for (const pattern of [/Setup.*\.exe$/i, /mac-arm64\.dmg$/, /mac-x64\.dmg$/, /\.AppImage$/, /\.deb$/]) {
    if (!assets.some(asset => pattern.test(asset.name))) throw new Error(`Release is incomplete: ${pattern}`);
  }
  return {
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    published: release.published_at,
    url: release.html_url,
    notes: release.body || '',
    assets: assets.map(({ name, size, browser_download_url, digest }) => ({
      name, size, url: browser_download_url, ...(digest ? { digest } : {}),
    })),
  };
}

if (process.argv[1]?.endsWith('releases.mjs')) {
  const response = await fetch('https://api.github.com/repos/D4eNst/tolktak/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}; existing snapshot preserved`);
  const snapshot = releaseSnapshot(await response.json());
  await writeFile(new URL('../releases.json', import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Saved verified downloads for ${snapshot.tag}. Run npm run build.`);
}
