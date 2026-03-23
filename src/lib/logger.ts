export type LogLevel = 'info' | 'warn' | 'error';

export function logEvent(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
  const payload = { level, message, ...meta };
  if (level === 'error') {
    console.error(message, payload);
    return;
  }
  if (level === 'warn') {
    console.warn(message, payload);
    return;
  }
  console.log(message, payload);
}
