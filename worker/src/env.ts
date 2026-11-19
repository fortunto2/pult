export interface Env {
  CHAT_ID: string;               // the owner's Telegram id: the only person the bot answers
  OWNER_TZ?: string;             // IANA zone for "tomorrow" and day boundaries, default UTC
  TELEGRAM_BOT_TOKEN: string;    // secret
  TG_SECRET: string;             // secret: the webhook's secret_token
  RUN_KEY: string;               // secret: bearer key of the owner's scripts and the runner
  RUNNER_KEY?: string;           // optional secret: a second key that opens the queue routes only (events, sessions, files, pause)
  DB: D1Database;
  TELEGRAM_API_ROOT?: string;    // tests point this at a local stub
}
