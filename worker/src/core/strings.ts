// Every user-facing string of the core, English by default. A private layer replaces any of them with `setStrings({ key: '...' })`
// (createApp's `strings` option does exactly that at startup). Placeholders are `{name}`, filled by `t(key, { name: ... })`.
// Add a key here, never a literal in a handler: a literal cannot be translated.
export const DEFAULTS = {
  // keep one key per line, grouped by area, so two people adding keys do not collide
  // -- card layer --
  // -- queue layer --
  // -- front --
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
