export interface GeneralTabs { sessions: string[] }

export function sessionNameError(value: string): string | undefined {
  if (!value) return 'Enter a session name.';
  if (value !== value.trim()) return 'Remove spaces from the beginning and end of the session name.';
  if (value === '.' || value === '..' || value.startsWith('-')) return 'Choose a name other than . or .. that does not start with a hyphen.';
  if (/[\u0000-\u001f\u007f/\\]/.test(value)) return 'Session names cannot contain slashes or control characters.';
  try { encodeURIComponent(value); } catch { return 'Enter a valid Unicode session name.'; }
  if (new TextEncoder().encode(value).length > 48) return 'Session names can use at most 48 UTF-8 bytes.';
}

export function nextGeneralSession(sessions: readonly string[]): string {
  const open = new Set(sessions);
  if (!open.has('general')) return 'general';
  let number = 2;
  while (open.has(`general${number}`)) number++;
  return `general${number}`;
}

export function restoreGeneralTabs(value: unknown): Record<string, GeneralTabs> {
  const result: Record<string, GeneralTabs> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,48}:@general$/.test(key) || !entry || typeof entry !== 'object' || !Array.isArray(entry.sessions)) continue;
    const sessions = [...new Set<string>(entry.sessions.filter((name: unknown) => typeof name === 'string' && !sessionNameError(name)))];
    result[key] = { sessions };
  }
  return result;
}
