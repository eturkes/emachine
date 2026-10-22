export interface GeneralTabs { sessions: string[]; next: number }

function sessionNumber(value: unknown): number | undefined {
  if (value === 'general') return 1;
  if (typeof value !== 'string' || !/^general[1-9][0-9]*$/.test(value)) return;
  const number = Number(value.slice(7));
  if (Number.isSafeInteger(number) && number >= 2 && number < Number.MAX_SAFE_INTEGER) return number;
}

export function restoreGeneralTabs(value: unknown): Record<string, GeneralTabs> {
  const result: Record<string, GeneralTabs> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,48}:@general$/.test(key) || !entry || typeof entry !== 'object' || !Array.isArray(entry.sessions)) continue;
    const sessions = [...new Set<string>(entry.sessions.filter((name: unknown) => sessionNumber(name) !== undefined))];
    const minimum = sessions.reduce((next, name) => Math.max(next, sessionNumber(name)! + 1), 2);
    const next = Number.isSafeInteger(entry.next) && entry.next >= minimum ? entry.next : minimum;
    result[key] = { sessions, next };
  }
  return result;
}
