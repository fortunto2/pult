# Roadmap

What is built is in CHANGELOG.md. This file is what is not, in the order it is worth doing, and what each item needs. Bot API facts were checked against the changelog (current: 10.4, 9 Nov 2026); anything marked *unverified* was not found in a primary source.

## Waiting for a real-client check

These are built and covered by tests against a stub, but **untested against a real Telegram client**. Check them on a phone before relying on them.

- **Streamed progress** (`sendMessageDraft`, 9.3; open to all bots in 9.5). The runner sends a draft per ~400 ms with the event id as `draft_id`; the final answer is a normal message. Draft rate limits and client minimum versions are *unverified*. If a call is refused, that turn falls back to the edit-a-message path. `PULT_PROGRESS=edit` (Mac) or `PROGRESS_DRAFTS=0` (worker) forces the old path.
- **Stop button on the draft** (`can_stop`, 10.3) and the `stopped_message_generation` update. The update's payload (`chat`, `draft_id`) comes from the Bot API types; the worker treats it as `/stop` for the turn whose event id is the draft id.
- **Button styles** (`style`, 9.4) and a greyed-out button while a card job runs (`disabled`, 10.3). `BUTTON_STYLES=0` and `BUTTON_DISABLED=0` switch them off.
- **Mini App third-party validation** (Ed25519 `signature`, 8.0) against Telegram's production key; the code path is tested with a generated key pair.

## Next

1. **Private-chat topics as the session key** (9.3, `createForumTopic` in private chats 9.4, t.me topic links 10.4). `message_thread_id` replaces reply chains: one topic is one session, with its own cards and progress, and a topic link opens it from a card or the Mini App. Design already fits: `sessions` gets a nullable `thread_id`, `resolveSession` tries it before the reply chain, every send takes `message_thread_id`. Reply-to keeps working in the General topic. Needs the topics mode switched on in BotFather.
2. **Rich messages** (`sendRichMessage`, 10.1; 32,768 characters; tables, details, buttons inside the text). For long answers instead of splitting at 4096 characters. Keep the HTML path as the fallback: older clients show a placeholder. Copy and forward rules *unverified*.
3. **Main Mini App** in BotFather (Launch button on the profile, Apps tab). A listing step, no code.
4. **Mini App client storage**: `DeviceStorage` to cache the card list for an instant open.

## Later, if the need shows up

- **Managed bots** (9.6): one-tap onboarding that creates a user's own pult bot. Means holding other people's tokens; only worth it with hosted onboarding.
- **HTML widgets** (10.4): a live job card inside the chat. Too fresh; private chats only, no forwarding.
- **Ephemeral messages** (10.2): only if the bot ever goes into group chats.
- **Multi-user**: a different threat model, deliberately out.

## Not worth it for this bot

Business-account features, Stars payments, guest mode, bot-to-bot, checklists (business accounts only), polls, Telegram Serverless as a backend (cannot reach the Mac runner).

## A note on the Mini App and Mini App origins

Since 10.2 (forced on from 20 Jul 2026) Mini App methods only work on the origin of the Mini App itself. pult's page is served by the worker at `/app/`, so a self-hosted copy on its own domain is fine; anything that links out or frames another origin loses `Telegram.WebApp`. The page links out only to `https://` sources of a card, in a new tab, and has no iframes. Do not opt out of the hardening in BotFather.
