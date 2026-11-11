# Repository Guidelines

## Project Structure & Module Organization

- `server/`: Node API and domain logic. `index.mjs` is the HTTP entry; `api-public.mjs` and `api-admin.mjs` expose APIs; `db.mjs` owns SQLite schema and seeds.
- `public/` and `admin/`: C-end and admin UIs; both mount the legacy renderer in a Vue 3 shell.
- `shared/`: design tokens. `scripts/`: build, import, and deployment helpers. `deploy/`: nginx and deployment files.
- `test/`: test suites. `docs/`: API, database, testing, and operations docs. `dist/` and `storage/`: generated or runtime files.

## Build, Test, and Development Commands

Node.js >=22.5 is required; FFmpeg and ffprobe are needed for media work.

```bash
npm install
npm run dev          # Node :8787, C-end :5173, admin :5174
npm run build        # Build dist/client and dist/admin
npm start            # Build, then serve on :8787
npm test             # Token check and node:test suites
npm run check        # Tokens and frontend syntax
npm run pack:deploy  # Hong Kong deployment archive
```

## Coding Style & Naming Conventions

- Use ES modules, two-space indentation, single quotes, and no semicolons; follow nearby files.
- Use `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for constants, and PascalCase Vue components.
- Keep legacy renderers working; add Vue components incrementally.
- No ESLint/Prettier config exists. Avoid unrelated reformatting; use `npm run check`.

## Testing Guidelines

- Tests use `node:test` and `node:assert/strict` in `test/*.test.mjs`; names state the scenario and expected result in Chinese.
- Use isolated `MH_DB` temporary databases and test-only `MH_*` values; never use production data.
- Add regression tests for behavior changes. Run `npm test`; frontend/token changes also need `npm run check`. No coverage gate is configured.

## Commit & Pull Request Guidelines

- Use concise Chinese subjects, one purpose per commit; prefix docs-only changes with `docs:` (for example, `docs: 补接口说明`).
- PRs state the change, risks, database/API impact, verification results, and UI screenshots when relevant; link issues when available.
- Put schemas in `docs/database/`, test evidence in `docs/testing/`, and update API docs with contract changes.

## Security & Configuration

- Never commit `.env`, credentials, SQLite/upload/HLS files, or deployment archives.
- Runtime config uses `MH_*`; `.env` is ignored. Never enable mock payments in production.
- Enforce admin authorization in API handlers; menu visibility is not authorization. Keep secrets out of logs/screenshots.

## Agent skills

### Issue tracker

GitHub Issues for `luobobo896/video-rr`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
