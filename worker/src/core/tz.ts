/** A zone Intl really knows; anything else falls back to UTC. */
export function validZone(z: unknown): z is string {
  if (typeof z !== 'string' || !(/\//.test(z) || z === 'UTC')) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
}
export const ownerTz = (env: { OWNER_TZ?: string }) => (validZone(env.OWNER_TZ) ? env.OWNER_TZ : 'UTC');
