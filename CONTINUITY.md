# Continuity Ledger

## Goal (incl. success criteria):
- Публичный релиз zKeen UI v0.0.1: CI собирает frontend + бинари aarch64/mipsle, GitHub Release с артефактами, установка на NC-1812 через install.sh.

## Constraints/Assumptions:
- Порт 7220, бинарь `zkeen-ui`, repo `dz0l/zKeen`.
- Cross-compile через `cross` на stable; mipsel без rust-std — нужен build-std.
- Frontend встраивается через rust-embed из `backend/frontend-dist/`.

## Key decisions:
- Embed-путь: `backend/frontend-dist/` (копия dist в CI), не `../frontend/dist` — cross монтирует только каталог crate.
- mipsel: `build-std = true` в `backend/Cross.toml`.

## State:
- CI: aarch64 OK; mipsel FAIL — `panic_abort` не входил в build-std при `panic = "abort"`.

## Now:
- fix(ci): build-std = ["std", "panic_abort"] для mipsel, перезапуск v0.0.1.

## Next:
- Проверить успешный CI и Release v0.0.1.
- Первая установка на роутер NC-1812.
- Интеграция frontend с Clash API.

## Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: mipsel build-std на stable через cross без nightly на runner.

## Working set (files/ids/commands):
- `.github/workflows/release.yml`, `backend/Cross.toml`, `backend/src/frontend_embedder.rs`
- CI run 32281451677 (failed), tag v0.0.1
