import { page } from '../shell.mjs';
import { copy } from '../copy.mjs';
import { renderSection } from '../docs.mjs';
import { ava, escape, icon, logo, person } from '../html.mjs';
import { builds, megabytes, releaseDate, systems as names } from '../release.mjs';
import { url, docUrl, other } from '../urls.mjs';
import { downloadCopy } from '../../content/download.mjs';

const systems = Object.keys(names);

// Sections of the app guide (docs/install/desktop-app.md) shown on this page as they are written there.
const guideAnchors = {
  ru: { signIn: 'регистрация-и-вход', differences: 'ограничения-связанные-с-системой', updates: 'обновления', permissions: 'разрешения' },
  en: { signIn: 'registration-and-sign-in', differences: 'platform-limitations', updates: 'updates', permissions: 'permissions' },
};

const serverArt = '<svg viewBox="0 0 160 150" aria-hidden="true"><polygon fill="#1f1d25" points="20,100 80,130 80,140 20,110"/><polygon fill="#18161c" points="140,100 80,130 80,140 140,110"/><polygon fill="#2b2832" points="80,70 140,100 80,130 20,100"/><polygon fill="#2a2731" points="20,86 80,116 80,126 20,96"/><polygon fill="#232029" points="140,86 80,116 80,126 140,96"/><polygon fill="#3a3642" points="80,56 140,86 80,116 20,86"/><polygon fill="#d9693a" points="20,72 80,102 80,112 20,82"/><polygon fill="#b9562b" points="140,72 80,102 80,112 140,82"/><polygon fill="#ff8a4c" points="80,42 140,72 80,102 20,72"/><polygon fill="#2a2731" points="56,70 80,82 80,62 56,50"/><polygon fill="#211f27" points="80,82 104,70 104,50 80,62"/><polygon fill="#ffbe4b" points="63.2,59.6 71.6,63.8 71.6,71.8 63.2,67.6"/><polygon fill="#ff9a4f" points="88.4,63.8 96.8,59.6 96.8,67.6 88.4,71.8"/><polygon fill="#3a3642" points="56,50 80,62 80,30"/><polygon fill="#2b2832" points="80,62 104,50 80,30"/></svg>';

export function download(ctx) {
  const { lang, release } = ctx;
  const c = downloadCopy[lang];
  const site = copy[lang];
  const p = c.path;
  const files = builds(release);
  const size = file => `${megabytes(file.size, lang)} ${c.sizeUnit}`;
  const guide = ctx.docs.pages.find(doc => doc.id === 'install/desktop-app');
  const anchors = guideAnchors[lang];
  const guideSection = key => renderSection(guide, ctx.docs.all, anchors[key]);
  const guideTitle = key => guide.headings.find(h => h.anchor === anchors[key]).text;
  const guideUrl = `${docUrl(lang, 'install/desktop-app')}#${anchors.signIn}`;
  const signInSteps = guideSection('signIn');
  const steps = signInSteps.match(/<ol>([\s\S]*?)<\/ol>/)?.[1];
  if (!steps) throw new Error(`${guide.path}: section #${anchors.signIn} has no numbered steps`);
  const [account, start] = [...steps.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  const captions = [p.downloaded, account, start];
  const sample = files.windows[0];
  const you = person('me', lang).name;

  const meta = file => `${c.files[file.key]} ${file.ext} · ${size(file)}`;

  // Unlike the other pages, the buttons here start the download right away.
  const targets = Object.fromEntries(systems.map(os => {
    const [main] = files[os];
    return [os, { ...ctx.downloads[os], href: main.url, meta: meta(main) }];
  }));

  const fileRow = file => {
    const sha = file.digest?.replace(/^sha256:/, '');
    return `<li class="w-dl-f" data-build="${file.key}">
            <p class="w-dl-f-name"><b>${c.files[file.key]}</b><code>${escape(file.ext)}</code></p>
            <p class="w-dl-f-size">${size(file)}</p>
            ${sha ? `<button class="w-dl-sha" type="button" data-sha="${sha}" title="SHA-256: ${sha}" aria-label="${c.copySha}: ${sha}" data-needs-js><span>SHA-256</span><code>${sha.slice(0, 12)}…</code>${icon('copy', 14)}</button>` : ''}
            <a class="w-dl-f-get" href="${escape(file.url)}">${icon('download', 16)}${c.downloadFile}<span class="w-sr"> ${escape(file.name)}</span></a>
          </li>`;
  };

  const system = os => `<div class="w-dl-os" id="${os}" data-os="${os}">
        <div class="w-dl-os-name">
          <h3>${names[os]}<span class="w-dl-yours">${c.recommended}</span></h3>
          <p>${c.notes[os]}</p>
        </div>
        <ul class="w-dl-files">
          ${files[os].map(fileRow).join('\n          ')}
        </ul>
      </div>`;

  const field = (label, value) => `<label class="w-dl-field"><span>${label}</span><b data-type="${escape(value)}" data-shown="${escape(value)}"></b></label>`;
  const roomPeople = ['alisa', 'borya', 'vera'];

  return page({
    lang, page: 'download', path: 'download/', title: `${c.title} — Windows, macOS, Linux`, description: c.description, styles: ['prose'],
    downloads: targets,
    switch: [
      ...systems.map(os => ({ icon: 'download', label: names[os], note: site.osBuilds[os], href: `#${os}` })),
      { icon: 'user', label: c.connectionTitle, note: c.switch.connect, href: '#connect' },
      { icon: 'screen', label: guideTitle('differences'), note: c.switch.differences, href: '#differences' },
      { icon: 'home', label: c.serverGuide, note: 'Docker', href: docUrl(lang, 'install/docker') },
    ],
    data: {
      builds: Object.fromEntries(systems.map(os => [os, files[os].map(file => ({ name: file.name, bytes: file.size, size: size(file), href: file.url, meta: meta(file) }))])),
      alternative: c.alternative,
      hint: { macos: c.macProcessor },
      text: { of: p.of, signIn: p.signIn, signingIn: p.signingIn, copied: site.copied, copyFailed: site.copyFailed },
    },
    body: `<main id="main" class="w-dl">
  <section class="w-dl-hero" aria-labelledby="w-dl-title">
    <div class="w-wrap w-dl-hero-grid">
      <div class="w-dl-hero-copy">
        <p class="w-dl-badge"><span></span>${site.earlyRelease}</p>
        <h1 class="w-h1" id="w-dl-title">${c.title}</h1>
        <p class="w-lead">${c.description}</p>
        <div class="w-dl-get">
          <div class="w-dl-get-main">
            <a class="w-btn w-btn--primary w-dl-btn" href="#builds" data-download data-dl-primary>${icon('download', 20)}<span data-download-label>${site.downloadApp}</span></a>
            <a class="w-btn w-dl-btn w-dl-btn--alt" href="#builds" data-dl-alt hidden></a>
          </div>
          <p class="w-btn-meta" data-download-meta>${site.platforms}</p>
          <p class="w-dl-hint" data-dl-hint hidden></p>
        </div>
        <div class="w-dl-release">
          <dl>
            <div><dt>${c.version}</dt><dd>${escape(release.version)}</dd></div>
            <div><dt>${c.published}</dt><dd><time datetime="${release.published.slice(0, 10)}">${releaseDate(release.published, lang)}</time></dd></div>
          </dl>
          <a class="w-link" href="${url(lang, 'releases/')}">${c.release}</a>
        </div>
      </div>

      <figure class="w-dl-path" aria-labelledby="w-dl-path-cap">
        <ol class="w-dl-steps">
          ${p.steps.map((step, i) => `<li><button type="button" class="w-dl-step is-done${i === 2 ? ' is-on' : ''}" data-step="${i + 1}" aria-current="${i === 2 ? 'step' : 'false'}" disabled><span class="w-dl-step-n">${i + 1}</span><span>${step}</span></button></li>`).join('\n          ')}
        </ol>
        <div class="w-dl-track" aria-hidden="true"><span></span></div>

        <div class="w-win w-dl-win is-in" id="w-dl-win" data-scene="3" aria-hidden="true">
          <div class="w-dl-scene w-dl-s1">
            <div class="w-dl-bar"><span class="w-dl-dots"><i></i><i></i><i></i></span><span class="w-dl-bar-title">${p.downloads}</span></div>
            <div class="w-dl-s1-body">
              <div class="w-dl-file">
                <span class="w-dl-file-ic">${icon('file', 22)}</span>
                <div class="w-dl-file-main">
                  <p class="w-dl-file-name" data-dl-file>${escape(sample.name)}</p>
                  <div class="w-dl-progress"><span></span></div>
                  <p class="w-dl-file-meta" data-dl-done>${size(sample)}</p>
                </div>
                <span class="w-dl-file-ok">${icon('check', 18)}</span>
              </div>
              <div class="w-dl-app"><span class="w-dl-app-icon">${logo(46)}</span><span class="w-dl-app-name">TolkTak</span></div>
            </div>
          </div>

          <div class="w-dl-scene w-dl-s2">
            <div class="w-dl-bar w-dl-bar--browser"><span class="w-dl-dots"><i></i><i></i><i></i></span><span class="w-dl-url">${icon('shield', 12)}https://talk.example.com</span></div>
            <div class="w-dl-s2-body">
              <div class="w-dl-form">
                <p class="w-dl-form-title">${p.signUp}</p>
                ${field(p.username, p.login)}
                ${field(p.password, '••••••••••')}
                ${field(p.invite, '7F3A9C21B04E')}
                <span class="w-dl-submit" data-dl-press="2">${p.createAccount}</span>
              </div>
            </div>
          </div>

          <div class="w-dl-scene w-dl-s3">
            <div class="w-dl-bar"><span class="w-dl-dots"><i></i><i></i><i></i></span><span class="w-dl-bar-title">TolkTak</span></div>
            <div class="w-dl-login">
              <div class="w-dl-login-brand">${logo(28)}<b>TolkTak</b></div>
              ${field(p.server, 'talk.example.com')}
              ${field(p.username, p.login)}
              ${field(p.password, '••••••••••')}
              <span class="w-dl-submit" data-dl-press="3"><span data-dl-signin>${p.signIn}</span></span>
            </div>
            <div class="w-dl-in">
              <aside class="w-dl-side">
                <p class="w-dl-side-group"><span class="w-dl-side-badge">${p.group[0]}</span>${p.group}</p>
                <p class="w-dl-side-cap">${p.textChannels}</p>
                <p class="w-dl-side-row">${icon('hash', 14)}${p.channel}</p>
                <p class="w-dl-side-cap">${p.voiceRooms}</p>
                <p class="w-dl-side-row is-here w-dl-side-voice">${icon('speaker', 14)}${p.room}</p>
                <ul class="w-dl-side-people">
                  ${roomPeople.map(id => `<li>${ava(id, lang, 18)}${person(id, lang).name}</li>`).join('\n                  ')}
                  <li class="w-dl-me">${ava('me', lang, 18)}${you}</li>
                </ul>
                <div class="w-dl-connected"><b><i></i>${p.connected}</b><span>${p.room} · ${p.group}</span></div>
              </aside>
              <div class="w-dl-stage">
                <p class="w-dl-stage-head">${icon('speaker', 14)}<b>${p.room} · ${p.group}</b><span>${roomPeople.length + 1} ${p.inRoom}</span></p>
                <div class="w-dl-tiles">
                  ${roomPeople.map(id => `<div class="w-dl-tile">${ava(id, lang, 44)}<em>${person(id, lang).name}</em></div>`).join('\n                  ')}
                  <div class="w-dl-tile w-dl-tile--me">${ava('me', lang, 44)}<em>${you}</em></div>
                </div>
                <div class="w-dl-controls">${['mic', 'headphones', 'videoOff', 'screen'].map(name => `<span>${icon(name, 16)}</span>`).join('')}<span class="w-dl-leave">${icon('phoneOff', 16)}</span></div>
              </div>
            </div>
          </div>
        </div>

        <figcaption class="w-dl-path-cap" id="w-dl-path-cap">
          ${captions.map((caption, i) => `<span data-cap="${i + 1}"${i === 2 ? ' class="is-on"' : ''}>${caption}</span>`).join('\n          ')}
        </figcaption>
      </figure>
    </div>
  </section>

  <section class="w-dl-builds" id="builds" aria-labelledby="w-dl-builds-title">
    <div class="w-wrap">
      <div class="w-dl-head">
        <h2 class="w-dl-h2" id="w-dl-builds-title">${c.builds}</h2>
        <p class="w-dl-head-note">${c.version} ${escape(release.version)} · <a class="w-link" href="${url(lang, 'releases/')}">${c.release}</a></p>
      </div>
      ${systems.map(system).join('\n      ')}
    </div>
  </section>

  <section class="w-dl-connect" id="connect" aria-labelledby="w-dl-connect-title">
    <div class="w-wrap w-dl-connect-grid">
      <div class="w-dl-connect-copy">
        <h2 class="w-dl-h2" id="w-dl-connect-title">${c.connectionTitle}</h2>
        <p class="w-lead">${c.connectionText}</p>
        <p class="w-dl-links"><a class="w-link" href="${guideUrl}">${escape(guideTitle('signIn'))}</a><a class="w-link" href="${docUrl(lang, 'install/docker')}">${c.serverGuide}</a></p>
      </div>
      <div class="w-prose w-dl-doc">
${signInSteps}
      </div>
    </div>
  </section>

  <section class="w-dl-diff" id="differences" aria-labelledby="w-dl-diff-title">
    <div class="w-wrap">
      <div class="w-dl-head"><h2 class="w-dl-h2" id="w-dl-diff-title">${escape(guideTitle('differences'))}</h2></div>
      <div class="w-dl-diff-grid">
        <div class="w-prose w-dl-doc">
${guideSection('differences')}
        </div>
        <div class="w-dl-notes">
          ${[['updates', 'download'], ['permissions', 'shield']].map(([key, name]) => `<div class="w-dl-note"><h3>${icon(name, 18)}${escape(guideTitle(key))}</h3><div class="w-prose w-dl-doc">${guideSection(key)}</div></div>`).join('\n          ')}
        </div>
      </div>
    </div>
  </section>

  <section class="w-dl-server" aria-labelledby="w-dl-server-title">
    <div class="w-wrap">
      <div class="w-dl-server-in">
        <div class="w-dl-server-art">${serverArt}</div>
        <div class="w-dl-server-copy">
          <h2 class="w-dl-h2" id="w-dl-server-title">${c.server.title}</h2>
          <p class="w-lead">${c.server.text}</p>
        </div>
        <div class="w-dl-server-cta">
          <a class="w-btn" href="${docUrl(lang, 'install/docker')}"><span>${c.server.action}</span>${icon('chevronRight', 18)}</a>
          <a class="w-link" href="${docUrl(lang, 'install/requirements')}">${c.server.requirements}</a>
        </div>
      </div>
    </div>
  </section>

  <p class="w-dl-toast" role="status" aria-live="polite"></p>
</main>`,
  });
}
