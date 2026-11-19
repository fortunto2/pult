// Every user-facing string of the core, English by default. A private layer replaces any of them with `setStrings({ key: '...' })`
// (createApp's `strings` option does exactly that at startup). Placeholders are `{name}`, filled by `t(key, { name: ... })`.
// Add a key here, never a literal in a handler: a literal cannot be translated.
export const DEFAULTS = {
  // keep one key per line, grouped by area, so two people adding keys do not collide
  // -- card layer --
  locale: 'en-GB', weekdays: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat', days_short: 'd', hanging_word: 'hanging', link_word: 'link',
  details: 'More', sources: 'Sources', starts: 'starts', who_what: 'Who/what', more_n: '{n} more', roll_rest: '{h}, {n} more',
  meta_why: 'why', meta_cost: 'cost', meta_due: 'due', hanging_tail: 'hanging {n} d', stale_line: '🗂 {n} hanging, oldest {days} d',
  working_line: '⏳ working: {what}', voice_note: '🎙 voice note', fixing: '✍️ fixing: {said}', writing_reply: '✍️ writing a reply draft',
  draft_only: '[button job: read and draft only; send nothing, pay nothing, cancel nothing, delete nothing]',
  kind_decision: 'Decision', kind_inbox: 'Inbox', kind_digest: 'Note', kind_incident: 'Incident', kind_meeting: 'Meeting',
  line_done: '✓ done: {title}', line_dropped: '✕ not needed: {title}', line_expired: '⌛ expired: {title}', line_snoozed: '💤 snoozed until {until}: {title}',
  line_sent: '✉️ Sent {time} → {to}: {title}',
  done_btn: '✅ Done', verb_done: 'Done', later_btn: '⏰ Later', not_needed: 'Not needed', back: '← Back', open_btn: '↗ Open', copy_btn: 'Copy', copy_cmd_btn: 'Copy command',
  more_btn: '🔎 More', more_held_btn: 'More {n}', show_stale_btn: 'Show {n} of {total}', undo_btn: '↩︎ Undo', reply_btn: '✍️ Reply',
  send_btn: '✉️ Send', fix_btn: '✏️ Fix', cancel_btn: 'Cancel', copy_reply_btn: '📋 Copy', i_sent_btn: '✅ Sent it', send_yes_btn: 'Yes, send → {to}',
  snooze_evening: 'This evening', snooze_tomorrow: 'Tomorrow', snooze_monday: 'Mon', snooze_pick: 'Pick a day',
  drop_done: 'Already done', drop_stale: 'No longer relevant', drop_notmine: 'Not mine', drop_mute: 'Stop showing this kind', drop_plain: 'Just close',
  effort_5: 'took 5 min', effort_30: 'half an hour', effort_60: 'an hour+',
  d_account: 'Account', d_to: 'To', d_cc: 'Cc', d_subject: 'Subject', mail_draft: 'Mail draft', reply_draft: 'Reply draft', you_send: 'you send it yourself',
  need_from_you: 'Needed from you: {what}', brackets_mail: 'The text has [brackets]: fill them in before sending', brackets_reply: 'The text has [brackets]: fill them in',
  continues_one: '… the mail continues in the next message', continues_many: '… the mail continues in the next {n} messages',
  sending_status: 'Sending…', send_failed: 'Not sent', send_refused: 'Refused',
  send_confirm_q: 'Really send to {to}?', send_already_sending: 'already sending', send_already_sent: 'already sent', send_confirm_expired: 'confirmation expired, press Send again',
  send_card_changed: 'the card changed, look at the new draft', send_cap_note: 'limit of {cap} sends a day', send_cap_toast: 'limit of {cap} sends a day reached',
  sending_toast: 'sending', send_stale_queued: 'the runner did not take the job in 30 minutes, nothing was sent', send_stale_sending: 'the send was not confirmed, check the sent folder before retrying',
  not_allowed: 'not allowed', already_handled: 'already handled', already_running: 'already running', cancelled: 'cancelled',
  tap_closed: 'already closed', tap_why: 'why?', tap_which_day: 'which day?', tap_how_long: 'for how long?', tap_too_late: 'too late to undo', tap_restored: 'restored',
  tap_noted: 'noted', tap_done: 'done', tap_muted: 'will not show this kind again', tap_removed_unmutable: 'removed, this kind is never muted', tap_removed: 'removed',
  tap_time_passed: 'that time has passed', tap_deadline: 'Deadline {date}: cannot go later', tap_snoozed: 'snoozed',
  toast_ack: 'acknowledged', toast_done: 'done', toast_drop: 'dropped', toast_snooze_1h: 'back in 1 hour', toast_snooze_tomorrow: 'back tomorrow', toast_snooze_3d: 'back in 3 days',
  unknown_button: 'unknown button', queue_off_send: 'the queue is off, sending is unavailable', queue_off_reply: 'the queue is off, no draft can be written',
  queue_failed: 'could not queue it', writing_toast: 'writing a draft, I will send it with buttons', started_draft: 'started',
  ok: 'ok', fix_prompt: 'Reply to this card with what to change', no_more: 'nothing more', shown_n: 'showed {n}',
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
