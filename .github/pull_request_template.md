## What and why

<!-- What does this change, and why? Link the issue it addresses, e.g. "Fixes #123". -->

## How it was tested

<!-- Tests added or run, and manual checks (OS, server setup). -->

## Checklist

- [ ] `uv run ruff check . && uv run ruff format --check . && uv run ty check && uv run pytest` (in `server/`) and `npm run typecheck && npm run build` pass
- [ ] Media-path changes include an end-to-end test that checks real frames, audio or packets
- [ ] New UI strings are added to every language in `client/src/renderer/i18n/`
- [ ] Documentation in `docs/` is updated if behaviour or configuration changed
