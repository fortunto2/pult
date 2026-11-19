# Changelog

Semantic versions. A core change is made here first; a private layer bumps its submodule to the tag. The extension API (`worker/src/lib.ts`, `pult.actions`, `pult.plugins`) follows semver: a breaking change to a hook is a major version. Anything under `worker/src/core/` that `lib.ts` does not export is internal and may change in a minor release.

## 0.6.2 (2026-11-19)

- Test isolation is structural: `pult.paths.url()` refuses any non-loopback worker URL while `PYTEST_CURRENT_TEST` is set, so a test that forgot to point at its own worker cannot post into a live chat. A test that really talks to a live worker sets `PULT_ALLOW_LIVE_IN_TESTS=1`.

## 0.6.1 (2026-11-19)

- `check-public` refuses a commit whose author or committer address is not a noreply one (`git var GIT_AUTHOR_IDENT`), in every checkout including a submodule one; two earlier public commits carry such an address and are listed by hash instead of rewriting public history.

## 0.6.0 (2026-11-19)


- Runner: `Registry.register(..., session=False)` for a job queued without a chat session (the handler gets `sess == {"id": ""}` and nothing is looked up), `ActionResult.exit_code` for the runner's process exit code.
- Plugin hook `placeholders() -> dict`: extra `{NAME}` placeholders in workflows and rules (`{PULT}` and `{WORK}` stay built in). `PULT_AGENT_RULES`: a file that replaces the packaged agent rules.
- The rejected-ack incident card is worded through `strings()` (`run.ack_title`, `run.ack_body`).
- Draft progress: an unchanged draft text is sent again every `PULT_KEEPALIVE_S` (15 s) because a Telegram draft is a 30 s preview.

## 0.5.1 (2026-11-19)


- `lib.ts` exports grammY's `InputFile`: a private layer that sends files through `ctx.api` must use the core's copy (a second grammY install makes `InputFile instances must be sent via grammY`).

## 0.5.0 (2026-11-19)

Extension seams used by a complete private layer (shell options, keyed credentials, command override, queue hooks).


- `tg-channel`: the one-line file notes go through the string table (`channel.file_note`), so a translation covers them.

- `lib.ts` also exports `grammyTg` and `itemsRoute` (a private layer builds a Tg for its own sends; tests drive the items route directly).

- Session ages (`5 min`, `2 h`, `1 d`) go through the string table (`agoMin`, `agoHour`, `agoDay`); `locales/ru.ts` now covers every key of the table, queue, sessions and chat included.
- Plugin hook `tz_label(tz)`: a short zone name in `bot-item now` and note headers.

- `Extension.keyed(req, ctx)`: a second credential for part of the API (a device that may lease only its own events). `QueueHooks.seen(db, slot, now)` runs on each interactive/background pull before the pause check; `PullArgs.db` lets a filter or slot query D1. `upsertItem` and `Incoming` are exported from `lib.ts`.
- `lib.ts` exports what private extensions import from the card layer: `ACTIONS`/`addActions`, `upsertItem`, `applyWork`/`applyUnwork`, `metaOf`, `groupOf`, `streamOf`, `configureCards`, the draft helpers, `withSettings`/`setFlag`/`flagOn`, `authenticate`/`authenticateUser`.
- `createApp` shell options: `ownerTz(env)` (async, the owner's zone from a row or a heartbeat), `withEnv(env)` (stored switches over deploy variables, once per request or tick), `botInfo` (no getMe on a cold start), `cards` (the deployment's card configuration).
- `Command.override`: an extension's command replaces the core command of the same name (/status, /help, /start...); the menu lists it once.
- Group of a card id: the leading alphanumeric run (`gmail-abc-def` is `gmail`), as the private bot always read it.
- `lib.ts` exports `RU`, `configureCards`, `statusLine`, `localDate`, `sweepStreams`, the protected-day helpers, `recentTaps`, `withSettings`, `setFlag`, `flagOn`, `pausedUntil`, and the `Item`, `Op`, `CardConfig` types.

## 0.4.1 (2026-11-19)

- `createApp({ pathAliases })`: a private bot's old URLs (`/owner/...`, `/readmodel`) keep working after their handlers moved under `/x/<name>/`; the longest alias wins. Scripts and devices that call the old paths change nothing.

## 0.4.0 (2026-11-19)

The core grows to a superset of the private bot's card, queue and front layers, so a private layer is extensions only.

- Mac side, from the private bot's scripts: `bot-say` gains `--roll --photo --doc --issue --keyboard --replace --topic/--thread` (ignored) and `BOT_SAY_LEGACY`/`PULT_SAY_LEGACY`; the wall is `PULT_DENY_FILE` plus plugin `wall()`; new hooks module (`pult.hooks`) and user-text overrides (`pult.i18n`, plugin `strings()`).
- `/say` is its own module: `key` with `replace`, `photo_b64`, `doc_b64`/`doc_name`, `keyboard`, `issue`/`thread`/`topic` ignored, and an `Extension.say.before` hook. The stop button's tap is answered with a silent line (`stoppingDraft`). Queue-layer texts are in the strings table. Settings: `withSettings`, `setFlag`, `flagOn`; a `PROGRESS_DRAFT=0` row turns drafts off.
- Queue hooks (`Extension.queue`): slots of an extension's own (`pull(db, '<name>')`, with a `gate`), filters on the core slots, lease length and a heartbeat ceiling per row, a recovery step that runs before dead leases are requeued, longer expiry for chosen events. Priority 3 (other people's events) belongs to the interactive slot after 0 and 1. `enqueue` takes per-call `extra` columns. Migration `core:0003_lease_columns` (`events.lease_started`, `events.leased_by`); migrations may carry `addColumns`, which skips a column the table already has.
- Front hooks: `Extension.fence`, `Extension.ownerMessage` (with `MessageCtx`), route auth `tma_user`, `ctx.user` on `tma` routes; `createApp` options `strings`, `menu`, `replyKeyboard`, `hourlyCron`, `appAssets`; `RICH=0` plain-text switch in `grammyTg(api, rich)`. `docs/extending.md` lists them.
- `bot-item`: `--answers --money --hard-due --hold --direct`, `reply-draft`, `flag`, `seen`, `now`, `tg://user?id=` card links; plugin hooks `item_args`, `item_gate`, `item_payload`, `item_after` and `item_commands` carry a private feed's rules (contract, mutes, reap) without a fork.
- `session-run` and `tg-channel`: every sentence the owner reads goes through `pult.i18n` (plugin `strings()`); plugin `draft_rules()` and `agent_rules()` extend the fixed rules.
The card layer of the private bot, generic and neutral.

- Cards: held and folded cards (one note behind the cap, `hold: true` on POST), the sweep with a daily cap of today-cards, ring and bump, `origin_user`, the roll and digest views, the button grammar and its taps (done with a one-minute undo, "not needed" with a reason menu, later with a day picker), protected days, the standup's "hanging" line.
- Replies and drafts: the reply button (`rp`), a mail draft on the card with send on confirm (`send_draft`, `sy_`, `sn`, `fix_draft`; the send itself is a queue event, the core never talks to Gmail), a chat reply to copy, `POST /items/:id/draft` and `/reply-draft`, `/owner/draft-send*`, `DRAFT_SENDS_PER_DAY`.
- One string table (`strings.ts`) holds every user-facing word, English by default; `locales/ru.ts` is a complete Russian map. `cardconfig.ts` carries what a deployment decides: groups, glyphs, reply groups, the card's own verbs, unmutable ids, account labels, `onAction`, `filterOps`, `todayCap`.
- Migration `core:0002_cards` is additive and idempotent: it adds `origin_user`, `bumped_at`, `held`, `folded_at` only where missing (pragma check) and creates `draft_sends`, so it is a no-op on a database that already has them.
- `handleCallback` now takes the owner id as its third argument and an `opts` object (`sessions`, `sendCap`).

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
