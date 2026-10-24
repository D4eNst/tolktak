import { page } from '../shell.mjs';
import { copy } from '../copy.mjs';
import { github } from '../github.mjs';
import { renderMarkdown } from '../docs.mjs';
import { escape, icon } from '../html.mjs';
import { releaseDate } from '../release.mjs';
import { url } from '../urls.mjs';

// Every published release, newest first.
export function history(ctx) {
  const { lang, releases } = ctx;
  const c = copy[lang];
  const entries = releases.map(release => {
    // Descriptions written on GitHub are in English.
    const body = release.notes ? `<div lang="en">${renderMarkdown(release.notes)}</div>` : `<p>${c.releases.noNotes}</p>`;
    return `<article class="w-release" id="v${escape(release.version)}">
      <header class="w-release-head">
        <h2>${escape(release.tag)}</h2>
        ${release.tag === ctx.release.tag ? `<span class="w-release-latest">${c.releases.latest}</span>` : ''}
        <time datetime="${release.published}">${releaseDate(release.published, lang)}</time>
      </header>
      <div class="w-prose">${body}</div>
      <a class="w-link" href="${release.url}">${c.releases.onGitHub}</a>
    </article>`;
  }).join('\n');
  return page({
    lang, page: 'releases', path: 'releases/', title: `${c.releases.title} — TolkTak`, styles: ['prose'],
    downloads: ctx.downloads,
    body: `<main id="main" class="w-wrap w-releases">
  <h1 class="w-h2">${c.releases.title}</h1>
  ${entries}
  <p class="w-releases-more"><a class="w-btn w-btn--primary" href="${url(lang, 'download/')}" data-download>${icon('download', 20)}<span data-download-label>${c.downloadApp}</span></a><a class="w-link" href="${github}/releases">${c.releases.allOnGitHub}</a></p>
</main>`,
  });
}
