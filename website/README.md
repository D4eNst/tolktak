# TolkTak website

The product website, downloads and documentation for `https://tolktak.d4enst.ru`.
Russian pages are at `/`; English pages are at `/en/`. The build produces static
HTML in `dist/`: the production web server does not need Node.js or access to the
GitHub API.

## Local preview

Use Node.js 22 or newer:

```sh
cd website
npm ci
npm run build
npm run check
npm run preview
```

Open `http://127.0.0.1:4173`. Set `PORT` to use another port. The preview listens
only on loopback. Stop it with Ctrl+C.

## Where the content comes from

- Releases: every build reads the published releases from the GitHub API. The
  newest release with all installers fills the download page; all releases fill
  the version history. Set `GITHUB_TOKEN` to avoid the anonymous rate limit. The
  last answer is cached in `.cache/` for offline builds.
- Documentation: `../docs/` (English) and `../docs/ru/` (Russian). Every Markdown
  file becomes a page. Folders become sidebar groups; pages follow the order in
  which the docs link to them, starting from `README.md`. English copies of
  top-level Russian pages are read from the repository root, as GitHub expects
  `SECURITY.md` and `CONTRIBUTING.md` there.
- `content/`: page copy in both languages (`content/home/` has one file per
  homepage section).
- `tools/copy.mjs`: shared interface labels and the names of documentation groups.
  A new docs folder appears under its own name until it gets a label here.
- `tools/pages/`: page templates; `tools/pages/home/` has one template per
  homepage section.
- `assets/`: styles, scripts, fonts and images, copied to `dist/`. Each folder in
  `assets/css/` is concatenated into one stylesheet; scripts are ES modules.

Markdown links to other guides become local website links. Source-code links
still point to the repository. `npm run check` validates internal links, anchors,
page metadata and search targets.

## Publishing

The `Website` workflow builds and checks the site whenever `docs/`, `website/`,
`SECURITY.md`, `CONTRIBUTING.md` or `deploy/nginx.conf.example` change on `main`,
and whenever a release is published, unpublished, edited or deleted. It can also be started by hand. A new release or a
documentation change therefore reaches the site without editing the website.

The workflow uploads `dist/` over SSH with `rsync --delete` once these repository
secrets exist; without them it only builds and checks:

| Secret | Value |
|---|---|
| `SITE_HOST` | Web server address |
| `SITE_USER` | SSH user that may write to the site directory |
| `SITE_PATH` | Site directory on the server |
| `SITE_PORT` | SSH port, if it is not 22 |
| `SITE_SSH_KEY` | Private key of that user, without a passphrase |
| `SITE_KNOWN_HOSTS` | Output of `ssh-keyscan -p <port> <host>` |

A dedicated user whose key is limited to the site directory keeps the deploy key
harmless elsewhere, for example with `command="rrsync /srv/tolktak-website"` in its
`authorized_keys` (then `SITE_PATH` is `.`).

Serve the directory from the domain root with any static HTTP server. Paths such
as `/docs/install/docker/` resolve to their `index.html`. Configure the web
server to use `404.html` for unknown paths and keep directory listings disabled.
English pages have their own `en/404.html`; in nginx, add
`location /en/ { error_page 404 /en/404.html; }`.
Style and script file names carry no version, so send `Cache-Control: no-cache`
for HTML, CSS, JavaScript and JSON: browsers then check for a newer copy on every
visit instead of keeping an old one.

No registration, analytics or external font requests are used. Search runs in
the browser from the generated local JSON index. Every text and link works
without JavaScript; scripts add the interactive scenes, search, copy buttons and
picking the download for the visitor's system.

Golos Text and JetBrains Mono are self-hosted under SIL OFL 1.1
([Golos Text](assets/fonts/OFL-GolosText.txt),
[JetBrains Mono](assets/fonts/OFL-JetBrainsMono.txt)), subset to Latin and
Cyrillic. The Markdown generator uses markdown-it (MIT). The direction, palette
and writing rules are recorded in [DESIGN.md](DESIGN.md).
