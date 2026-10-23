# TolkTak website

The product website, downloads and documentation for `https://tolktak.d4enst.ru`.
Russian pages are at `/`; English pages are at `/en/`. Pages are static HTML:
the production web server does not need Node.js or access to the GitHub API.

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

## Edit content

- `content/home.mjs`: agreed homepage copy and its English translation.
- `content/download.mjs`: download page copy and its English translation.
- `tools/copy.mjs`: shared interface labels and other pages' copy.
- `tools/build.mjs`: page layouts, navigation, Markdown rendering and search index.
- `style.css`, `site.js`: styles and progressive enhancements.
- `../docs/`: English documentation; `../docs/ru/`: Russian documentation.
- `releases.json`: verified release metadata and direct installer URLs.
- `content/releases/`: reviewed release notes in each language, with source links.
- `img/`: existing screenshots taken from a real demo stack. They illustrate
  the app; the people and conversations shown are sample data.

Run `npm run build` after changing Markdown, layouts, copy or release metadata.
Generated HTML and search indexes are checked in, so serving this directory
continues to work without a build step. Do not edit generated pages directly.

Markdown links to other guides become local website links. Source-code links
still point to the repository. `npm run check` validates internal links, anchors,
page metadata, search targets and the format of release URLs.

## Update downloads

```sh
npm run releases:refresh
npm run build
npm run check
```

Refresh reads the latest published stable GitHub release. If the request fails,
the existing snapshot stays intact. The build requires all five installer types
before replacing download pages. Review and commit the updated snapshot and HTML
with the release; no runtime API request is needed for a download to work.

## Serve in production

Serve this directory from the domain root with any static HTTP server. Paths
such as `/docs/install/docker/` resolve to their `index.html`. Configure the web
server to use `404.html` for unknown paths. Keep directory listings disabled;
only public assets belong in this directory. Do not upload `node_modules/`.

No registration, analytics or external font requests are used. Search runs in
the browser from the generated local JSON index. Documentation and download links
are available without JavaScript; JavaScript adds search, copy buttons, screenshot
tabs and platform highlighting.

Golos Text is self-hosted under [SIL OFL 1.1](fonts/OFL.txt). The Markdown generator
uses markdown-it (MIT). The palette, layout and writing direction are recorded
in [DESIGN.md](DESIGN.md).
