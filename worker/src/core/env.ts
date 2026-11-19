export interface Env {
  CHAT_ID: string;               // the owner's Telegram id: the only person the bot answers
  OWNER_TZ?: string;             // IANA zone for "tomorrow" and day boundaries, default UTC
  TELEGRAM_BOT_TOKEN: string;    // secret
  TG_SECRET: string;             // secret: the webhook's secret_token
  RUN_KEY: string;               // secret: bearer key of the owner's scripts and the runner
  RUNNER_KEY?: string;           // optional secret: a second key that opens the queue routes only (events, sessions, files, pause)
  DB: D1Database;
  TELEGRAM_API_ROOT?: string;    // tests point this at a local stub
  BOT_ID?: string;               // the bot's numeric id, for Ed25519 initData validation; default: the part of the token before ':'
  MINIAPP_AUTH?: 'hmac' | 'ed25519' | 'both';   // which initData checks the Mini App accepts, default both
  TG_PUBLIC_KEY?: string;        // hex Ed25519 key to verify initData signatures with, default Telegram's production key
  RICH?: string;                 // '0': send the plain-text twin of every message instead of Telegram HTML
  BUTTON_STYLES?: string;        // '0': no coloured button styles
  BUTTON_DISABLED?: string;      // '0': no greyed-out button while a card's job runs
  PROGRESS_DRAFTS?: string;      // '0' turns streamed drafts off: /sessions/:id/draft answers fallback and the runner edits a message instead
}
