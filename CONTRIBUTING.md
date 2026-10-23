# Contributing to TolkTak

Thank you for your interest in TolkTak. Bug reports, fixes, features and translations are all welcome.

## Before you start

- For bugs, search the [existing issues](https://github.com/D4eNst/tolktak/issues) first, then open a new one with the bug report template.
- For larger changes or new features, open an issue to discuss the idea before writing code. It saves everyone time if the direction needs adjusting.
- For questions and ideas that are not yet a concrete proposal, use [GitHub Discussions](https://github.com/D4eNst/tolktak/discussions).
- Security problems are reported privately: see [SECURITY.md](SECURITY.md).

## Development setup

See [Building and testing](docs/development/building.md) for prerequisites, running a local stack and the end-to-end tests. Before opening a pull request, run the same checks as CI:

```sh
cd server && uv sync && uv run ruff check . && uv run ruff format --check . && uv run ty check && uv run pytest
cd client && npm ci && npm run typecheck && npm run build
```

## Pull requests

- Keep each pull request focused on one change, and describe what it changes and why.
- Add or update tests for the behaviour you change. Server changes need tests in `server/tests/` (pytest); client changes that affect behaviour need an end-to-end test where one is practical.
- **Changes to the media path** (voice, camera, screen sharing, stream audio, watch-together) are accepted only with an end-to-end test that checks the real stream, such as decoded video frames, audio levels or RTP packet statistics, not just the presence of elements on screen.
- Follow the style of the surrounding code. Python code is formatted and linted with `ruff` (`uv run ruff format .`).
- Update the documentation in `docs/` when you change behaviour, configuration or deployment.
- Every string shown to users goes through the translation files (see below), never inline in a component.

## Translations

UI strings live in `client/src/renderer/i18n/`. English (`en/`) is the reference; every other language is a directory that mirrors it file by file, and each file is typed against its English counterpart, so a missing or misspelled key is a compile error.

To add a language:

1. Copy `client/src/renderer/i18n/en/` to a new directory named after the language code, for example `de/`.
2. In each file, import the English module's type and declare the object with it, as the existing `ru/` files do:

   ```ts
   import type en from '../en/chat';

   const de: typeof en = {
     // ...
   };

   export default de;
   ```

3. Translate the strings. Strings that depend on a number or a name are functions; keep their parameters.
4. Register the language in `client/src/renderer/i18n/index.ts`: add it to the `Locale` type, the `LOCALES` list (with the language's own name), the dictionary map, and the locale detection and `intlLocale` functions.
5. Run `npm run typecheck` in `client/`. It fails until every string is present.

The pages served by the server (`server/tolktak/web/static/`) are translated separately: each page script (`index.js`, `admin.js`, `docs.js`) holds its own `en` and `ru` dictionaries, and `i18n.js` switches between them.

## Code provenance and licensing

- Write your own code. Do not copy code from projects whose license is incompatible with AGPL-3.0-or-later, and do not submit code derived from decompiling or disassembling proprietary software.
- If you add a dependency or bundle third-party assets (models, sounds, fonts, images), state its license in the pull request. It must be compatible with AGPL-3.0-or-later.
- By submitting a contribution, you agree that it is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE), the license of the project.

## Code of conduct

Everyone taking part in the project is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
