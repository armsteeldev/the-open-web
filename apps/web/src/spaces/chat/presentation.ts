export interface FormattedChatTime {
  readonly text: string;
  readonly accessibleLabel: string;
}

/** Format the stored UTC instant in the visitor's local timezone and locale. */
export function formatChatTime(
  createdAt: number,
  now = Date.now(),
  locale?: string,
  timeZone?: string,
): FormattedChatTime {
  const date = new Date(createdAt);
  const current = new Date(now);
  const zone = timeZone ? { timeZone } : {};
  const localParts = (value: Date) => new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'numeric', day: 'numeric', ...zone,
  }).format(value);
  const clock = new Intl.DateTimeFormat(locale, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zone,
  }).format(date);
  const text = localParts(date) === localParts(current)
    ? clock
    : `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...zone }).format(date)} ${clock}`;
  const accessibleLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short', ...zone,
  }).format(date);
  return { text, accessibleLabel };
}
