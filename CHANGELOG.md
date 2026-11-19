# Changelog

Semantic versions. A core change is made here first; a private layer bumps its submodule to the tag. The extension API (`worker/src/lib.ts`, `pult.actions`, `pult.plugins`) follows semver: a breaking change to a hook is a major version. Anything under `worker/src/core/` that `lib.ts` does not export is internal and may change in a minor release.

## Unreleased

- Mac side, from the private bot's scripts: `bot-say` gains `--roll --photo --doc --issue --keyboard --replace --topic/--thread` (ignored) and `BOT_SAY_LEGACY`/`PULT_SAY_LEGACY`; the wall is `PULT_DENY_FILE` plus plugin `wall()`; new hooks module (`pult.hooks`) and user-text overrides (`pult.i18n`, plugin `strings()`).
- Queue hooks (`Extension.queue`): slots of an extension's own (`pull(db, '<name>')`, with a `gate`), filters on the core slots, lease length and a heartbeat ceiling per row, a recovery step that runs before dead leases are requeued, longer expiry for chosen events. Priority 3 (other people's events) belongs to the interactive slot after 0 and 1. `enqueue` takes per-call `extra` columns. Migration `core:0003_lease_columns` (`events.lease_started`, `events.leased_by`); migrations may carry `addColumns`, which skips a column the table already has.
- Front hooks: `Extension.fence`, `Extension.ownerMessage` (with `MessageCtx`), route auth `tma_user`, `ctx.user` on `tma` routes; `createApp` options `strings`, `menu`, `replyKeyboard`, `hourlyCron`, `appAssets`; `RICH=0` plain-text switch in `grammyTg(api, rich)`. `docs/extending.md` lists them.

## 0.3.1 (2026-11-19)

- `make hooks` works inside a submodule checkout (`.git` is a file there; the hook goes where `git rev-parse --git-path hooks` says).

## 0.3.0 (2026-11-19)

Alignment with the private bot that has run these paths against real Telegram.

- `sendMessageDraft` text is cut at 4000 characters, the limit the live bot ships with (was 4096).
- Done carries the card's urgency colour: now red, today blue, later green (was always green). Not needed stays red.
- `bot-say`: a test pins that an oversize single paragraph loses no word and splits none (the cut itself was already in 0.2.0).
- The rest of the stream path (stop button, fallback to the edit path on any refusal) was compared line by line with the live bot's and needed no change.

## 0.2.0 (2026-11-19)

The core becomes a library.

- Worker: `createApp({ extensions })` and the `Extension` contract (routes under `/x/<name>/`, slash commands, callback prefixes, queue-action `onAck`, scheduled handlers, Mini App panels, migrations applied after the core's, a typed Env). `src/index.ts` is `createApp()` with none. `docs/extending.md`, a tested toy extension in `worker/examples/`.
- Migrations: lazy, once per isolate, recorded in `_migrations`; the core schema is `core:0001_init` (generated from `schema.sql`). No manual `d1 execute` step any more.
- Mini App, served by the worker at `/app/`: initData checked by HMAC or by Ed25519 signature (no token needed, `bot_id` plus Telegram's key), one-hour window, owner only. A generic read-only view (open cards, sessions, queue depth and the usage-limit pause, recent runs), declarative panels from extensions, `startapp` deep links (`card_<short>`, `session_<id>`, `panel_<id>`), fullscreen and add-to-home-screen buttons. Write-back is a D1 switch, off by default (`/appwrite on|off`). `/app` command and the chat menu button.
- Telegram: streamed progress through `sendMessageDraft` with the stop button, `stopped_message_generation` handled like `/stop`, coloured and greyed-out buttons. All three fall back or switch off by flag. **Untested against a real client.**
- Python: the Mac side is the `pult` package with console scripts (`pult-run`, `session-run`, `bot-item`, `bot-say`, `tg-channel`, `live-session`), an action registry, `PULT_PLUGINS` plugin loading, every path from the environment, packaged default workflows with an override.
- `Extension.outsiders` (a private layer claims non-owner updates, the family seam) and `Extension.eventColumns` (extra NOT NULL columns on `events`, the live-database seam). `docs/migration.md`: moving a private bot onto the core as a submodule.
- `make check-public` and a pre-commit hook: generic id, host and key patterns plus your own list from a file outside the repo.

## 0.1.0

First public cut: owner-only webhook, cards with Done, Later, Not needed and More buttons, a priority queue with lease, heartbeat and ack, sessions addressed by reply, `/new`, `/sessions`, `/stop`, `/status`, a files proxy, the live slot, Markdown to Telegram HTML, the Mac scripts and tests.
