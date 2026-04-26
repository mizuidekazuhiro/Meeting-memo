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
  transcriptFileUrl?: string;
  finalMemo: string;
  sourceUrls: string[];
  myTasks: Array<{ taskText: string; chooseUrl?: string }>;
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

const MEMO_TITLE_PATTERNS: RegExp[] = [
  /^完成版\s*面談メモ$/i,
  /^面談メモ（完成版）$/i,
  /^#\s*完成版\s*面談メモ$/i,
  /^##\s*完成版\s*面談メモ$/i,
  /^#\s*面談メモ（完成版）$/i,
  /^##\s*面談メモ（完成版）$/i,
];

function normalizeTaskTextForEmail(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/^\s*(?:[-*・]|\d+[.)]?)\s+/, '')
    .trim();
}

function linkifyText(value: string): string {
  const escaped = escapeHtml(value);
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function stripLeadingMemoTitle(value: string): string {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1;
  if (cursor < lines.length && MEMO_TITLE_PATTERNS.some((pattern) => pattern.test(lines[cursor].trim()))) {
    lines.splice(cursor, 1);
  }
  return lines.join('\n').trim();
}

function renderFinalMemoHtml(markdown: string): string {
  const source = stripLeadingMemoTitle(markdown ?? '');
  if (!source) return '<p style="margin:0;">（内容なし）</p>';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  const isBulletLine = (value: string): boolean => /^(?:[-*]\s+|・\s*)/.test(value);
  const orderedMatch = (value: string): RegExpMatchArray | null => value.match(/^(\d+)[.)]\s+(.+)$/);
  const headingFromNumberLine = (value: string): RegExpMatchArray | null => value.match(/^(\d+)[.)]\s*(.+)$/);

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      const level = line.startsWith('###') ? 'h4' : line.startsWith('##') ? 'h3' : 'h2';
      html.push(`<${level} style="margin:20px 0 8px 0;font-size:${level === 'h2' ? '19px' : level === 'h3' ? '17px' : '16px'};line-height:1.5;">${linkifyText(heading[1].trim())}</${level}>`);
      index += 1;
      continue;
    }
    if (isBulletLine(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const listLine = lines[index].trim();
        const listMatch = listLine.match(/^(?:[-*]\s+|・\s*)(.+)$/);
        if (!listMatch) break;
        items.push(`<li style="margin:6px 0;">${linkifyText(listMatch[1].trim())}</li>`);
        index += 1;
      }
      html.push(`<ul style="margin:10px 0 14px 0;padding-left:20px;">${items.join('')}</ul>`);
      continue;
    }
    const orderedStart = orderedMatch(line);
    if (orderedStart) {
      let probe = index;
      let consecutiveOrderedCount = 0;
      while (probe < lines.length && orderedMatch(lines[probe].trim())) {
        consecutiveOrderedCount += 1;
        probe += 1;
      }
      if (consecutiveOrderedCount >= 2) {
        const items: string[] = [];
        while (index < lines.length) {
          const orderedLine = lines[index].trim();
          const listMatch = orderedMatch(orderedLine);
          if (!listMatch) break;
          items.push(`<li style="margin:6px 0;">${linkifyText(listMatch[2].trim())}</li>`);
          index += 1;
        }
        html.push(`<ol style="margin:10px 0 14px 0;padding-left:22px;">${items.join('')}</ol>`);
        continue;
      }
    }
    const numberedHeading = headingFromNumberLine(line);
    if (numberedHeading) {
      html.push(`<h3 style="font-size:16px;margin:18px 0 10px 0;line-height:1.6;font-weight:600;">${linkifyText(`${numberedHeading[1]}. ${numberedHeading[2].trim()}`)}</h3>`);
      index += 1;
      continue;
    }
    if (orderedStart) {
      const items: string[] = [];
      while (index < lines.length) {
        const orderedLine = lines[index].trim();
        const listMatch = orderedMatch(orderedLine);
        if (!listMatch) break;
        items.push(`<li style="margin:6px 0;">${linkifyText(listMatch[2].trim())}</li>`);
        index += 1;
      }
      html.push(`<ol style="margin:10px 0 14px 0;padding-left:22px;">${items.join('')}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const textLine = lines[index].trim();
      if (!textLine || /^#{1,3}\s+/.test(textLine) || isBulletLine(textLine) || orderedMatch(textLine) || headingFromNumberLine(textLine)) break;
      paragraphLines.push(linkifyText(textLine));
      index += 1;
    }
    html.push(`<p style="margin:0 0 12px 0;line-height:1.8;">${paragraphLines.join('<br />')}</p>`);
  }

  return html.join('');
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
  const finalMemoHtml = renderFinalMemoHtml(input.finalMemo ?? '');
  const sourceUrlsInput = Array.isArray(input.sourceUrls) ? input.sourceUrls : [];
  const myTasksHtml = input.myTasks.length
    ? `<div style="display:flex;flex-direction:column;gap:10px;">${input.myTasks.map((task) => {
      const buttonHtml = task.chooseUrl
        ? `<div style="margin-top:8px;"><a href="${escapeHtml(task.chooseUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:6px 10px;border-radius:6px;background:#2563eb;color:#ffffff;text-decoration:none;font-size:13px;">処理を選ぶ</a></div>`
        : '';
      return `<div style="border:1px solid #d0d7de;border-radius:8px;padding:12px 14px;background:#ffffff;"><p style="margin:0 0 8px 0;font-weight:600;line-height:1.7;">${escapeHtml(normalizeTaskTextForEmail(task.taskText))}</p>${buttonHtml}</div>`;
    }).join('')}</div>`
    : '';
  const notionPageUrl = escapeHtml(input.notionPageUrl);
  const sourceUrls = [
    `<li><a href="${notionPageUrl}" target="_blank" rel="noopener noreferrer">Notionページを開く</a></li>`,
    ...sourceUrlsInput.map((url, idx) => `<li style="margin:0 0 8px 0;"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">参考資料 ${idx + 1} を開く</a></li>`),
  ].join('');
  const sourceSection = `<h2 style="font-size:18px;margin:24px 0 12px 0;padding-bottom:6px;border-bottom:1px solid #d0d7de;">参考リンク</h2><ul style="padding-left:20px;margin:0;">${sourceUrls}</ul>`;
  const myTasksSection = input.myTasks.length
    ? `<h2 style="font-size:18px;margin:24px 0 12px 0;padding-bottom:6px;border-bottom:1px solid #d0d7de;">次アクション</h2>${myTasksHtml}<h2 style="font-size:18px;margin:24px 0 12px 0;padding-bottom:6px;border-bottom:1px solid #d0d7de;">タスク処理を選ぶ</h2><p style="margin:0 0 10px 0;">各アクションの「処理を選ぶ」から処理先を選択できます。</p>`
    : '';
  const notionSection = `<h2 style="font-size:18px;margin:24px 0 12px 0;padding-bottom:6px;border-bottom:1px solid #d0d7de;">Notionで補足確認</h2><p style="margin:0 0 12px 0;"><a href="${notionPageUrl}" target="_blank" rel="noopener noreferrer">Notion ページを開く</a></p>`;

  return `<!DOCTYPE html>
<html lang="ja">
  <body style="margin:0;padding:0;background:#f8fafc;font-family:'Yu Gothic UI','Yu Gothic',Meiryo,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2933;">
    <div style="max-width:880px;margin:0 auto;padding:24px;">
      <div style="background:#ffffff;border-radius:12px;padding:20px;">
        <h2 style="font-size:18px;margin:0 0 12px 0;padding-bottom:6px;border-bottom:1px solid #d0d7de;">Meeting Memo作成完了</h2>
        <p style="margin:0 0 12px 0;">Interview Memo の文字起こしと要約が完了しました。</p>
        <p style="margin:0 0 12px 0;">
          Notion ページ：
          <a href="${notionPageUrl}" target="_blank" rel="noopener noreferrer">Notion ページを開く</a>
        </p>
        ${input.transcriptFileUrl ? `<p style="margin:0 0 12px 0;">Transcript全文リンク：<a href="${escapeHtml(input.transcriptFileUrl)}" target="_blank" rel="noopener noreferrer">Transcript全文リンク</a></p>` : ''}
        <h2 style="font-size:18px;margin:24px 0 12px 0;padding-bottom:6px;border-bottom:1px solid #d0d7de;">完成版 面談メモ</h2>
        <div style="background:#ffffff;border:1px solid #d0d7de;border-radius:10px;padding:14px 14px 10px 14px;">${finalMemoHtml}</div>
        ${myTasksSection}
        ${sourceSection}
        ${notionSection}
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

export function buildCompletionEmailSubject(subject: string): string {
  return subject;
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
    subject: buildCompletionEmailSubject(input.subject),
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
