import type { Env } from '../types';
import { HttpError } from './http';

interface MailConfig {
  from: string;
  password: string;
  to: string[];
  cc: string[];
  bcc: string[];
  smtpHost: string;
  smtpPort: number;
}

interface CompletionEmailInput {
  notionPageUrl: string;
  summary: string;
  transcript: string;
  myTasks: string[];
  fileName: string;
  recordingId: string;
  completedAt: string;
}

function isEnabled(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true';
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (matched) => {
    switch (matched) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return matched;
    }
  });
}

function toBase64(content: string): string {
  const utf8 = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of utf8) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function parseRecipientList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function uniqueRecipients(recipients: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const recipient of recipients) {
    const key = recipient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(recipient);
  }
  return unique;
}

export function getCompletionEmailConfig(env: Env): MailConfig {
  const from = env.MAIL_FROM?.trim() ?? '';
  const password = env.MAIL_PASSWORD?.trim() ?? '';
  const to = parseRecipientList(env.MAIL_TO);

  if (!from || !password || to.length === 0) {
    throw new HttpError('SMTP mail envs are missing. Required: MAIL_FROM, MAIL_PASSWORD, MAIL_TO.', 500);
  }

  return {
    from,
    password,
    to,
    cc: parseRecipientList(env.MAIL_CC),
    bcc: parseRecipientList(env.MAIL_BCC),
    smtpHost: env.SMTP_HOST?.trim() || 'smtp.gmail.com',
    smtpPort: parsePort(env.SMTP_PORT, 587),
  };
}

function buildCompletionEmailHtml(input: CompletionEmailInput): string {
  const myTasksHtml = input.myTasks.length
    ? `<ul>${input.myTasks.map((task) => `<li>${escapeHtml(task)}</li>`).join('')}</ul>`
    : '<p>なし</p>';

  return `<!DOCTYPE html>
<html lang="ja">
  <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic UI',sans-serif;color:#1f2937;">
    <div style="max-width:680px;margin:0 auto;padding:16px;">
      <div style="background:#ffffff;border-radius:12px;padding:20px;line-height:1.7;">
        <h2 style="margin:0 0 12px 0;font-size:20px;">Interview Memo 完了通知</h2>
        <p style="margin:0 0 12px 0;">Notion ページ: <a href="${escapeHtml(input.notionPageUrl)}">${escapeHtml(input.notionPageUrl)}</a></p>
        <p style="margin:0;"><strong>fileName:</strong> ${escapeHtml(input.fileName)}</p>
        <p style="margin:0;"><strong>recordingId:</strong> ${escapeHtml(input.recordingId)}</p>
        <p style="margin:0 0 12px 0;"><strong>completedAt:</strong> ${escapeHtml(input.completedAt)}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">Summary</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(input.summary || 'なし')}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">My Tasks</h3>
        ${myTasksHtml}
        <h3 style="margin:16px 0 8px 0;font-size:16px;">Transcript</h3>
        <pre style="white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:12px;border-radius:8px;margin:0;">${escapeHtml(input.transcript || 'なし')}</pre>
      </div>
    </div>
  </body>
</html>`;
}

export function shouldSendCompletionEmail(env: Env): boolean {
  return isEnabled(env.GMAIL_NOTIFY_ENABLED)
    && hasValue(env.MAIL_TO)
    && hasValue(env.MAIL_FROM)
    && hasValue(env.MAIL_PASSWORD);
}

export function buildCompletionEmailMessage(
  input: CompletionEmailInput & { to: string[]; cc?: string[]; from: string; subject: string },
): string {
  const html = buildCompletionEmailHtml(input);
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
  ];
  if (input.cc && input.cc.length > 0) {
    lines.push(`Cc: ${input.cc.join(', ')}`);
  }
  lines.push(
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  );
  return lines.join('\r\n');
}

interface SmtpClient {
  sendCommand(command: string, expectedCodes: number[]): Promise<void>;
  sendData(message: string): Promise<void>;
  readGreeting(): Promise<void>;
  startTls(): Promise<void>;
  close(): Promise<void>;
}

async function createSmtpClient(hostname: string, port: number): Promise<SmtpClient> {
  const { connect } = await import('cloudflare:sockets');
  let socket = connect({ hostname, port }, { secureTransport: 'starttls' });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';

  const readLine = async (): Promise<string> => {
    while (true) {
      const lineBreakIndex = buffered.indexOf('\n');
      if (lineBreakIndex >= 0) {
        const line = buffered.slice(0, lineBreakIndex + 1);
        buffered = buffered.slice(lineBreakIndex + 1);
        return line.replace(/\r?\n$/, '');
      }
      const { value, done } = await reader.read();
      if (done) {
        throw new HttpError('SMTP connection closed unexpectedly.', 502);
      }
      buffered += decoder.decode(value, { stream: true });
    }
  };

  const readResponse = async (expectedCodes: number[]): Promise<void> => {
    const lines: string[] = [];
    while (true) {
      const line = await readLine();
      lines.push(line);
      if (!/^\d{3}[\s-]/.test(line)) {
        throw new HttpError('SMTP returned malformed response.', 502, { line });
      }
      if (line[3] === ' ') {
        const code = Number.parseInt(line.slice(0, 3), 10);
        if (!expectedCodes.includes(code)) {
          throw new HttpError('SMTP command failed.', 502, { code, response: lines.join('\n') });
        }
        return;
      }
    }
  };

  const sendCommand = async (command: string, expectedCodes: number[]): Promise<void> => {
    await writer.write(encoder.encode(`${command}\r\n`));
    await readResponse(expectedCodes);
  };

  const sendData = async (message: string): Promise<void> => {
    const stuffed = message.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
    await writer.write(encoder.encode(`${stuffed}\r\n.\r\n`));
    await readResponse([250]);
  };

  const readGreeting = async (): Promise<void> => {
    await readResponse([220]);
  };

  const startTls = async (): Promise<void> => {
    await sendCommand('STARTTLS', [220]);

    reader.releaseLock();
    writer.releaseLock();

    const secureSocket = socket.startTls();

    socket = secureSocket;
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    buffered = '';
  };

  const close = async (): Promise<void> => {
    try {
      await sendCommand('QUIT', [221]);
    } catch {
      // no-op
    } finally {
      try {
        await writer.close();
      } catch {
        // no-op
      }
      try {
        reader.releaseLock();
      } catch {
        // no-op
      }
      try {
        writer.releaseLock();
      } catch {
        // no-op
      }
      socket.close();
    }
  };

  return { sendCommand, sendData, readGreeting, startTls, close };
}

export async function sendCompletionEmail(
  env: Env,
  input: CompletionEmailInput & { subject: string },
): Promise<void> {
  if (!shouldSendCompletionEmail(env)) {
    return;
  }

  const config = getCompletionEmailConfig(env);
  const recipients = uniqueRecipients([...config.to, ...config.cc, ...config.bcc]);
  const message = buildCompletionEmailMessage({
    ...input,
    from: config.from,
    to: config.to,
    cc: config.cc,
    subject: input.subject,
  });

  const smtp = await createSmtpClient(config.smtpHost, config.smtpPort);
  await smtp.readGreeting();
  await smtp.sendCommand('EHLO meeting-memo.worker', [250]);
  await smtp.startTls();
  await smtp.sendCommand('EHLO meeting-memo.worker', [250]);
  await smtp.sendCommand('AUTH LOGIN', [334]);
  await smtp.sendCommand(toBase64(config.from), [334]);
  await smtp.sendCommand(toBase64(config.password), [235]);
  await smtp.sendCommand(`MAIL FROM:<${config.from}>`, [250]);
  for (const recipient of recipients) {
    await smtp.sendCommand(`RCPT TO:<${recipient}>`, [250, 251]);
  }
  await smtp.sendCommand('DATA', [354]);
  await smtp.sendData(message);
  await smtp.close();
}
