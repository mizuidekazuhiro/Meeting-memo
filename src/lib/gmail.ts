import type { Env } from '../types';
import { HttpError } from './http';
import { logEvent } from './logger';
import * as base from './gmail-base';

export * from './gmail-base';

export interface TextAttachment {
  fileName: string;
  content: string;
}

interface CompletionEmailInput {
  notionPageUrl: string;
  transcriptFileUrl?: string;
  transcriptAttachment?: TextAttachment;
  finalMemo: string;
  sourceUrls: Array<string | Record<string, unknown>>;
  myTasks: Array<{ taskText: string; chooseUrl?: string }>;
}

type MailConfig = ReturnType<typeof base.getCompletionEmailConfig>;

function toBase64(content: string): string {
  const utf8 = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of utf8) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function sanitizeAttachmentFileName(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  const baseName = normalized || 'meeting-transcript.txt';
  return /\.txt$/i.test(baseName) ? baseName : `${baseName}.txt`;
}

function asciiAttachmentFileName(value: string): string {
  const ascii = value.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return ascii || 'meeting-transcript.txt';
}

function buildCommonHeaders(input: { to: string[]; cc?: string[]; from: string; subject: string }): string[] {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
  ];
  if (input.cc && input.cc.length > 0) {
    lines.push(`Cc: ${input.cc.join(', ')}`);
  }
  lines.push(`Subject: ${input.subject}`, 'MIME-Version: 1.0');
  return lines;
}

function extractHtmlBody(message: string): string {
  const separator = '\r\n\r\n';
  const index = message.indexOf(separator);
  if (index < 0) {
    throw new HttpError('Completion email message is missing the MIME body separator.', 500);
  }
  return message.slice(index + separator.length);
}

function buildMultipartCompletionMessage(
  input: CompletionEmailInput & { to: string[]; cc?: string[]; from: string; subject: string },
  html: string,
  attachment: TextAttachment,
): string {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const boundary = `----=_MeetingMemo_${randomPart}`;
  const fileName = sanitizeAttachmentFileName(attachment.fileName);
  const asciiFileName = asciiAttachmentFileName(fileName);
  const headers = buildCommonHeaders(input);
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');

  const parts = [
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8; name="${asciiFileName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    '',
    wrapBase64(toBase64(attachment.content)),
    `--${boundary}--`,
    '',
  ];

  return [...headers, ...parts].join('\r\n');
}

export function buildCompletionEmailMessage(
  input: CompletionEmailInput & { to: string[]; cc?: string[]; from: string; subject: string },
): string {
  if (!input.transcriptAttachment) {
    return base.buildCompletionEmailMessage(input);
  }

  const { transcriptAttachment, ...baseInput } = input;
  const html = extractHtmlBody(base.buildCompletionEmailMessage(baseInput));
  return buildMultipartCompletionMessage(input, html, transcriptAttachment);
}

function toDirectDropboxDownloadUrl(value: string): string {
  const parsed = new URL(value);
  if (/(^|\.)dropbox\.com$/i.test(parsed.hostname)) {
    parsed.searchParams.set('dl', '1');
  }
  return parsed.toString();
}

function attachmentFileNameFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const pathTail = parsed.pathname.split('/').filter(Boolean).pop();
    return sanitizeAttachmentFileName(pathTail ? decodeURIComponent(pathTail) : 'meeting-transcript.txt');
  } catch {
    return 'meeting-transcript.txt';
  }
}

export async function downloadTranscriptAttachment(transcriptFileUrl: string): Promise<TextAttachment> {
  const downloadUrl = toDirectDropboxDownloadUrl(transcriptFileUrl);
  const response = await fetch(downloadUrl, { method: 'GET', redirect: 'follow' });
  if (!response.ok) {
    throw new HttpError('Unable to download transcript attachment from Dropbox.', 502, {
      status: response.status,
      transcriptFileUrl,
    });
  }

  const content = await response.text();
  if (!content.trim()) {
    throw new HttpError('Downloaded transcript attachment is empty.', 502, { transcriptFileUrl });
  }

  return {
    fileName: attachmentFileNameFromUrl(transcriptFileUrl),
    content,
  };
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

async function sendSmtpMessage(config: MailConfig, message: string): Promise<void> {
  const recipients = [...new Set([...config.to, ...config.cc, ...config.bcc].map((value) => value.toLowerCase()))];
  const originalByLower = new Map([...config.to, ...config.cc, ...config.bcc].map((value) => [value.toLowerCase(), value]));
  const smtp = await createSmtpClient(config.smtpHost, config.smtpPort);
  await smtp.readGreeting();
  await smtp.sendCommand('EHLO meeting-memo.worker', [250]);
  await smtp.startTls();
  await smtp.sendCommand('EHLO meeting-memo.worker', [250]);
  await smtp.sendCommand('AUTH LOGIN', [334]);
  await smtp.sendCommand(toBase64(config.from), [334]);
  await smtp.sendCommand(toBase64(config.password), [235]);
  await smtp.sendCommand(`MAIL FROM:<${config.from}>`, [250]);
  for (const recipientKey of recipients) {
    await smtp.sendCommand(`RCPT TO:<${originalByLower.get(recipientKey) ?? recipientKey}>`, [250, 251]);
  }
  await smtp.sendCommand('DATA', [354]);
  await smtp.sendData(message);
  await smtp.close();
}

export async function sendCompletionEmail(
  env: Env,
  input: CompletionEmailInput & { subject: string },
): Promise<void> {
  if (!base.shouldSendCompletionEmail(env)) {
    return;
  }

  let transcriptAttachment = input.transcriptAttachment;
  if (!transcriptAttachment && input.transcriptFileUrl) {
    try {
      transcriptAttachment = await downloadTranscriptAttachment(input.transcriptFileUrl);
      logEvent('info', 'completion_email_transcript_attachment_downloaded', {
        transcriptFileUrl: input.transcriptFileUrl,
        attachmentFileName: transcriptAttachment.fileName,
        attachmentChars: transcriptAttachment.content.length,
      });
    } catch (error) {
      logEvent('warn', 'completion_email_transcript_attachment_failed', {
        transcriptFileUrl: input.transcriptFileUrl,
        details: error instanceof HttpError ? error.details : error instanceof Error ? error.message : String(error),
      });
    }
  }

  const config = base.getCompletionEmailConfig(env);
  const message = buildCompletionEmailMessage({
    ...input,
    transcriptAttachment,
    from: config.from,
    to: config.to,
    cc: config.cc,
    subject: base.buildCompletionEmailSubject(input.subject),
  });

  await sendSmtpMessage(config, message);
}
