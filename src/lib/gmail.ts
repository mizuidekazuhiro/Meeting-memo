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
  summary: string;
  transcript: string;
  myTasks: Array<{ taskText: string; chooseUrl?: string }>;
  review?: {
    summaryForEmail: string;
    correctedTermsMarkdown: string;
    uncertainItemsMarkdown: string;
    nextActionsMarkdown: string;
    humanCheckRequired: boolean;
    humanCheckReason: string;
    sourceUrls: string[];
  };
  reviewError?: string;
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
    ? `<ul style="padding-left:20px;margin:0;">${input.myTasks.map((task) => {
      const buttonHtml = task.chooseUrl
        ? `<div style="margin-top:8px;"><a href="${escapeHtml(task.chooseUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:8px 12px;border-radius:8px;font-size:13px;">タスク処理を選ぶ</a></div>`
        : '';
      return `<li style="margin-bottom:12px;"><div>${escapeHtml(task.taskText)}</div>${buttonHtml}</li>`;
    }).join('')}</ul>`
    : '<p>なし</p>';
  const notionPageUrl = escapeHtml(input.notionPageUrl);
  const reviewStatus = input.reviewError
    ? '二次レビューは失敗しました。一次要約とTranscriptのみ保存されています。'
    : input.review
      ? `${input.review.humanCheckRequired ? '要確認' : '確認不要'}\n理由: ${input.review.humanCheckReason || 'なし'}`
      : 'レビュー未実行';
  const sourceUrls = input.review?.sourceUrls?.length
    ? input.review.sourceUrls.map((url) => `- ${url}`).join('\n')
    : 'なし';

  return `<!DOCTYPE html>
<html lang="ja">
  <body style="margin:0;padding:0;background:#f5f7fb;font-family:'Yu Gothic UI','Yu Gothic','YuGothic','Hiragino Kaku Gothic ProN','Meiryo',Arial,sans-serif;color:#1f2937;">
    <div style="max-width:680px;margin:0 auto;padding:16px;">
      <div style="background:#ffffff;border-radius:12px;padding:20px;line-height:1.7;">
        <h2 style="margin:0 0 12px 0;font-size:20px;">Interview Memo 完了通知</h2>
        <p style="margin:0 0 12px 0;">Interview Memo の文字起こしと要約が完了しました。</p>
        <p style="margin:0 0 12px 0;">
          Notion ページ：
          <a href="${notionPageUrl}" target="_blank" rel="noopener noreferrer">Notion ページを開く</a>
        </p>
        ${input.transcriptFileUrl ? `<p style="margin:0 0 12px 0;">Transcript全文リンク：<a href="${escapeHtml(input.transcriptFileUrl)}" target="_blank" rel="noopener noreferrer">Transcript全文リンク</a></p>` : ''}
        <h3 style="margin:16px 0 8px 0;font-size:16px;">レビュー結果</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(reviewStatus)}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">Summary</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(input.summary || 'なし')}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">完成版要旨</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(input.review?.summaryForEmail || input.summary || 'なし')}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">固有名詞補正</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(input.review?.correctedTermsMarkdown || 'なし')}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">未確定事項</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(input.review?.uncertainItemsMarkdown || 'なし')}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">次に取るべき行動</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(input.review?.nextActionsMarkdown || 'なし')}</p>
        <h3 style="margin:16px 0 8px 0;font-size:16px;">根拠URL</h3>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(sourceUrls)}</p>
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

export function buildCompletionEmailSubject(subject: string, review?: CompletionEmailInput['review'], reviewError?: string): string {
  if (reviewError) return `【レビュー失敗】${subject}`;
  if (review?.humanCheckRequired) return `【要確認】${subject}`;
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
    subject: buildCompletionEmailSubject(input.subject, input.review, input.reviewError),
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
