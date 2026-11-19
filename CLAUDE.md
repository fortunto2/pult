# CLAUDE.md

pult: a Telegram remote for Claude Code. A Cloudflare worker (`worker/`, D1) holds cards and a queue; Mac scripts (`bin/`) lease the queue and run `claude -p` on a subscription. README.md has the what and the setup; this file has the rules.

Posts behind the design: https://rustman.org/wiki/control-bot/ and https://rustman.org/wiki/claude-code-channels/

## Hard rules (each one is an incident or a review finding)

1. **Deploy one wrangler command at a time.** `make test` and `make integration` green, then the schema change, then `npx wrangler deploy`, and write the new version id and the previous one down (`npx wrangler rollback <previous>`). Two wrangler processes at once rotate the OAuth refresh token dead; the cure is `npx wrangler login`.
2. **Live switches are D1 rows**, in `settings`, never `wrangler.toml` vars. A deploy from any checkout must not be able to flip one.
3. **Scripts launchd or a running job executes are never edited in place.** Copy to `_work/`, edit, test, install over the original.
4. **Nothing is sent in the owner's name except an explicit path.** Card buttons and replies to cards run in the `draft` workflow (read and draft, `dontAsk`, a fresh session, the quoted card as data). Do not add a send, pay, post or delete tool to any allow list.
5. **A changed action is a changed contract.** `worker/contracts/actions.json`, `worker/src/core/contract.test.ts` and `tests/test_bot_item.py` change together.
6. **Editing a live Telegram message passes `reply_markup` again**, or the keyboard disappears. `worker/src/core/tg.ts` and `render.ts` carry the rule; a test pins it.
7. **Only the owner is answered.** The gate in `worker/src/core/app.ts` runs before any handler. A new command or callback never works around it; strangers get no reply at all, not even a courtesy line.
8. **A schema change is a new migration** appended to `worker/src/core/migrations.ts` (`core:NNNN_name`), additive, never an edit of a shipped one. `worker/schema.sql` is the frozen `core:0001_init`; `scripts/gen-schema.mjs` keeps its generated twin in sync (a test pins it).
9. **Core changes are made here, in pult, and bumped in the private layer.** Personal names, ids, hosts and handles never enter this repo: `make check-public` runs on `make test`, and `make hooks` installs it as a pre-commit hook. The personal list lives outside the repo (`PULT_SCRUB_FILE`).
10. **The extension API is semver.** `worker/src/lib.ts`, `pult.actions` and `pult.plugins` are the contract; a breaking change to a hook is a major version and a CHANGELOG line.

## Layout

```
worker/src/index.ts    createApp() with no extensions; worker/src/lib.ts is the library surface for a private layer
worker/src/core/app.ts createApp: webhook, auth, routing, the hourly tick, extension wiring; extension.ts is the hook contract
worker/src/core/       contract, fsm (pure state machine), store (D1), render (pure), tg, callbacks, replies,
                       queue, sessions, sessions-api (runner routes), chat, api (/items), mdtg, settings, streams
worker/src/core/miniapp/ initData checks, the read-only API, the page
worker/examples/       the toy extension that docs/extending.md walks through (tested)
worker/schema.sql      core:0001_init; wrangler.toml.example has the placeholders
src/pult/              the Python package: paths, runner, session_run, actions (registry), plugins, items, say, channel
bin/                   thin shims for the console scripts (README and launchd paths)
src/pult/data/         workflows.json (what each kind of run may do) and agent-rules.txt
tests/                 pytest: fake worker, fake claude; tests/integration: the real worker (INTEGRATION=1)
```

## Commands

```bash
make install      # npm ci in worker/, uv sync
make test         # worker node:test + tsc, then pytest (no network)
make integration  # wrangler dev --local + Telegram stub; one wrangler process only
make lint         # ruff
```

Python scripts run as `python3 bin/...` and are stdlib only; tests use `uv run pytest`. Worker tests run on Node's built-in runner with type stripping, so imports keep their `.ts` extension.

## Conventions

- Items are written by scripts, never chat text from a job: `bin/bot-item`, `bin/bot-say --key`.
- A reply to a card, or a custom button, runs a job whose card text is untrusted content: it sits in a delimited block, never loose in the instruction.
- Keep personal data out of the repo: no ids, tokens, hostnames or chat texts in code, tests or docs. Fixtures are synthetic.
- English in code and docs.
