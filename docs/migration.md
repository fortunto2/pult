# Moving a private bot onto the core

How an existing private bot (here: the owner's control bot, a superset of pult with a family layer, a CRM-ish read model, claim-check, a wall display, scheduled jobs and a draft-send path) becomes pult plus extensions. The core stays one public repo; the private bot includes it as a git submodule and keeps only what is personal.

## Layout after the move

```
control-bot/
  core/                        git submodule: pult, pinned to a tag (vX.Y.Z)
  worker/                      the deployed worker
    package.json               "pult-worker": "file:../core/worker"
    wrangler.toml              main = "src/index.ts"; same D1 binding, same name, same secrets as today
    src/index.ts               export default createApp<PrivateEnv>({ extensions: [family, readmodel, claim, display, jobs, draftSend] })
    src/extensions/<name>.ts   one file (or folder) per extension
    migrations/                the live 0001..00NN history, kept as is (see below)
  mac/ (or bin/)
    pyproject.toml             dependencies = ["pult"]; [tool.uv.sources] pult = { path = "../core" }
    plugins/<name>.py          PULT_PLUGINS=control_bot.family,control_bot.claim,...
  extensions-docs/             notes that stay private
```

Core changes are made inside `control-bot/core/` (the submodule checkout), committed and pushed to pult, then control-bot bumps the pointer. Because pult's history is the public history, **the pre-commit hook runs inside the submodule too**: `make hooks` in `core/` installs `scripts/pre-commit`, which runs `scripts/check-public.sh` against `${PULT_SCRUB_FILE:-~/.config/pult/scrub-patterns.txt}` plus the generic id, host and key shapes. A commit made from inside `control-bot/core/` cannot carry a personal name, id or handle. Set the file once per machine; without it the hook warns and runs only the generic rules.

## Each private part to a hook

| Private part | Becomes | Hook or seam |
|---|---|---|
| Family layer (members, invites, roster, strangers, lessons, reminders) | extension `family` | `outsiders` claims every non-owner update before the core drops it; `migrations` for its tables; `commands`, `callbacks`, `scheduled` for reminders; `queueActions` plus a Python plugin for the family runner |
| Mini App personal views (topics, to-do, jobs, limits, rest bar) | extension `readmodel` | `panels` for each tab, `routes` (`key`) for the Mac's push, `migrations` for the `rm_*` tables. The core page already shows cards, sessions, queue and runs |
| Mini App write-back to the task registry (`task-action`) | same extension | a `tma` route plus an `app_audit` table; the core's own write switch (`app:write`) only covers card buttons |
| Claim-check | extension `claim` | `routes`, `callbacks` (approve, reject), `queueActions`, plugin action on the Mac |
| Wall display | extension `display` | a `key` or `public` route the display polls; a panel for the phone |
| Scheduled jobs and the hourly digest | extension `jobs` | `scheduled` on the worker; Mac-side jobs stay scripts using `bot-item` and `bot-say` (now package console scripts) |
| Draft-send (Gmail), the reply-draft button | extension `draftsend` | `callbacks` (button, two-tap confirm), `queueActions` with `onAck` closing the card, a plugin action holding the send path. The core stays read-and-draft |
| Owner-only extras: `/rest`, energy, memo, intro | extension `owner` | `commands`, `callbacks` |

## What is deleted from the private repo as a duplicate

Worker: `contract`, `fsm`, `store`, `render`, `tg`, `callbacks`, `replies`, `queue`, `sessions`, `sessions-api`, `chat`, `api`, `mdtg`, `settings`, `streams`, `reconcile`, `hourly`, `tz`, `initdata`, `testkit`, `tgstub` and their tests, once each is shown identical or a strict subset of the core's, plus `contracts/actions.json`. Anything the private copy does that the core does not (multi-user queries by `user_id`, the `role` on events, held and folded items) is not deleted: it moves into the matching extension, or the difference is taken to the core as a general change first (the `outsiders` and `eventColumns` hooks exist for exactly that).

Python: `session-run`, `bot-say`, `bot-item`, `tg-channel`, `live-session`, `usage_limit`, the path module, `agent-rules.txt` and the default `workflows.json` come from the package. The private `workflows.json` shrinks to an override file (`PULT_WORKFLOWS`) or, better, to `workflows()` returned by a plugin. `claim-run`, `family-run`, `draft-send`, `readmodel-push`, `jobs-push` and the like stay, as plugins or scripts.

## D1 compatibility with the LIVE database

The rule: **additive migrations only, no rename and no drop of a live table or column.** Checked by building the live schema (all 32 migrations in order) next to the core's `schema.sql`:

| Table | Live versus core |
|---|---|
| `item_log`, `session_msgs`, `session_target`, `settings` | identical |
| `sessions` | live has one extra column (`legacy_issue`) and its index; the core never touches it |
| `items` | live adds `origin_user`, `bumped_at`, `held`, `folded_at`; live `custom` is nullable where the core's has a default. The core reads a null `custom` as none; the extra columns have defaults or are nullable, so core inserts succeed |
| `events` | live adds `role` (NOT NULL, no default), `lease_started`, `leased_by`, `no_family`, `handoff_at`, `handoff_reason`, `provisional`; `item_id` and `action` have no default there. The core always writes `item_id` and `action`; for the NOT NULL extras the family extension declares `eventColumns: { role: 'owner' }` (and `no_family` has a default), so every core insert satisfies the live table |

So the core's `core:0001_init` is `CREATE TABLE IF NOT EXISTS`: on the live database it creates nothing and only records itself in a new `_migrations` table. The private repo's own 32 migrations are recorded as extension migrations by giving them ids `<ext>:0001_...` on first run, and the wrangler `migrations/` directory stays what it was: either keep applying it with `wrangler d1 migrations apply` (and mark the ids as applied in `_migrations` once, in the cutover migration below), or fold it into the extensions' `migrations` and let the worker apply it. The first is the smaller step and the one to take.

**One cutover migration** (extension `family`, id `family:0000_adopt`): inserts `_migrations` rows for every id the live database has already applied, so no extension migration runs twice. It is plain `INSERT OR IGNORE`, safe to rerun.

Before the first deploy, dump the live schema (`wrangler d1 export --no-data`) and compare it with a local database built by the new worker's migrations over a copy of the live dump; the diff must be empty apart from `_migrations`.

## Order of deploys, with rollback points

1. **Branch, no deploy.** Add the submodule at a tag, switch the worker to `createApp` with all extensions, keep the old code in the tree. Run both test suites; run `make integration` (one wrangler process).
2. **Parity week on a copy.** Deploy the new worker as a second worker name against a copy of the live D1 (`wrangler d1 export` then import) and a test bot token. Replay a day of real updates. Rollback: delete the second worker.
3. **Schema step on live.** Nothing to apply by hand: the `_migrations` table and the adopt row appear on the first request of the new worker. Rollback point A: the old worker version id, written down before the deploy (`npx wrangler rollback <id>`); the schema is a superset, so the old code runs unchanged.
4. **Deploy the new worker to the live name.** One wrangler command at a time. Watch `/status`, one card press, one plain message, one family message, the Mini App. Rollback point B: `wrangler rollback <old id>`.
5. **Mac side.** Switch one script at a time from the private copy to the package console script, starting with `bot-say`. `pult-run` last, under launchd, with `PULT_PLUGINS` set; the old runner stays installed (not loaded) for a week. Rollback point C: reload the old plist.
6. **Delete the duplicates** (the list above) in a separate commit, after a week without a rollback.

Each step is reversible without data loss because nothing is renamed and the extra columns and tables are only ever added.

## What a core change looks like afterwards

```bash
cd control-bot/core && git switch -c fix-x       # work in the submodule checkout
# edit, make test, make integration; the pre-commit scrub runs on commit
git commit && git push                           # pult's public history
git tag vX.Y.Z && git push --tags                # after CHANGELOG.md has the section (make release V=X.Y.Z)
cd .. && git add core && git commit -m "core: bump to vX.Y.Z"
```
