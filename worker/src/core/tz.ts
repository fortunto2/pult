/** A zone Intl really knows; anything else falls back to UTC. */
export function validZone(z: unknown): z is string {
  if (typeof z !== 'string' || !(/\//.test(z) || z === 'UTC')) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
}
export const ownerTz = (env: { OWNER_TZ?: string }) => (validZone(env.OWNER_TZ) ? env.OWNER_TZ : 'UTC');

/** Calendar date, wall-clock minutes and "HH:MM" of an instant in a zone. */
export function parts(ms: number, tz: string): { date: string; min: number; hm: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string) => f.find(x => x.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, min: Number(g('hour')) * 60 + Number(g('minute')), hm: `${g('hour')}:${g('minute')}` };
}
/** The calendar date (YYYY-MM-DD) of an instant in a zone. */
export const localDate = (tz: string, ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
/** Instant of `date` (YYYY-MM-DD) at `hm` local time in `tz`. */
export function localToInstant(date: string, hm: string, tz: string): number {
  const guess = Date.parse(`${date}T${hm}:00Z`);
  let t = guess - (Date.parse(`${parts(guess, tz).date}T${parts(guess, tz).hm}:00Z`) - guess);
  t = t - (Date.parse(`${parts(t, tz).date}T${parts(t, tz).hm}:00Z`) - guess);   // a second pass settles DST edges
  return t;
}
