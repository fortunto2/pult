// Every user-facing string of the core, English by default. A private layer replaces any of them with `setStrings({ key: '...' })`
// (createApp's `strings` option does exactly that at startup). Placeholders are `{name}`, filled by `t(key, { name: ... })`.
// Add a key here, never a literal in a handler: a literal cannot be translated.
export const DEFAULTS = {
  // keep one key per line, grouped by area, so two people adding keys do not collide
  // -- card layer --
  // -- queue layer --
  unsupportedMedia: '{kind}: not supported',
  kindVideo: 'video',
  fileTooBig: '{name}: larger than 20 MB, Telegram does not hand such a file to a bot',
  pauseLine: 'Claude usage limit until {time}, your message is queued',
  newSession: 'New session "{title}". Plain messages go into it until midnight; a reply to any bot message continues the session that message belongs to.',
  noSessions: 'No sessions yet: your first message opens the day\'s session.',
  sessionRunning: ' · running',
  sessionAgo: ' · {ago} ago',
  switched: 'Switched: messages go to this session until midnight.',
  noSuchSession: 'No such session.',
  stopping: 'Stopping "{title}"{running}{dropped}.',
  stoppingRunning: ' (up to 20 s)',
  stoppingDropped: ', removed from the queue: {n}',
  nothingRunningIn: 'Nothing is running in "{title}".',
  stoppingDraft: 'Stopping{running}{dropped}.',
  nothingRunning: 'Nothing is running any more.',
  queueStatus: 'Queue: {queued}; running: {running}.',
  queueEmpty: 'empty',
  limitUntil: '\nClaude usage limit until {time}.',
  itemRule: 'This is a request from a decision card in the bot (the card is quoted above). Do what the text asks, read and draft only: send nothing in the owner\'s name, pay nothing, cancel nothing, delete nothing. If your answer settles the card completely, finish with a line `ITEM-DONE`; otherwise the card returns to the owner\'s list.',
  // -- front --
  start: 'Write a message and Claude answers. /help lists the commands.',
  paused: 'The bot is not taking messages right now.',
  appUnknown: 'The Mini App address is not known yet: call /setup once after the deploy.',
  appBlurb: 'Cards, sessions, queue.',
  appOpen: 'Open',
  noOpen: 'No open cards.',
  nothingSnoozed: 'Nothing snoozed.',
  callbackFailed: 'failed',
  menuTitle: 'Pult',
} as const;

export type StringKey = keyof typeof DEFAULTS;
/** The live table. Mutated in place by setStrings, so every importer sees the override. */
export const S: Record<string, string> = { ...DEFAULTS };

export function setStrings(over: Partial<Record<string, string>>): void {
  for (const [k, v] of Object.entries(over)) if (typeof v === 'string') S[k] = v;
}
export function resetStrings(): void { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, DEFAULTS); }

/** The string for `key` with `{name}` placeholders filled. An unknown key is returned as is, so a typo shows up on screen and in tests. */
export function t(key: StringKey | (string & {}), vars: Record<string, string | number> = {}): string {
  return (S[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
