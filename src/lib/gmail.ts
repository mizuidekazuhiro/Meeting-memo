import type { Env } from '../types';
import { HttpError } from './http';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

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

function toBase64Url(content: string): string {
  const utf8 = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of utf8) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(env: Env): Promise<string> {
  const clientId = env.GMAIL_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET?.trim();
  const refreshToken = env.GMAIL_OAUTH_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new HttpError('Gmail OAuth envs are missing.', 500);
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new HttpError('Failed to refresh Gmail access token.', 502, await response.text());
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new HttpError('Gmail access token was not returned by OAuth endpoint.', 502, payload);
  }

  return payload.access_token;
}

function buildCompletionEmailHtml(input: {
  notionPageUrl: string;
  summary: string;
  transcript: string;
  myTasks: string[];
  fileName: string;
  recordingId: string;
  completedAt: string;
}): string {
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
    && hasValue(env.GMAIL_TO)
    && hasValue(env.GMAIL_FROM)
    && hasValue(env.GMAIL_OAUTH_CLIENT_ID)
    && hasValue(env.GMAIL_OAUTH_CLIENT_SECRET)
    && hasValue(env.GMAIL_OAUTH_REFRESH_TOKEN);
}

export function buildCompletionEmailMessage(input: Parameters<typeof buildCompletionEmailHtml>[0] & { to: string; from: string; subject: string }): string {
  const html = buildCompletionEmailHtml(input);
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');
}

export async function sendCompletionEmail(
  env: Env,
  input: Parameters<typeof buildCompletionEmailHtml>[0] & { subject: string },
): Promise<void> {
  if (!shouldSendCompletionEmail(env)) {
    return;
  }

  const to = env.GMAIL_TO?.trim();
  const from = env.GMAIL_FROM?.trim();
  if (!to || !from) {
    throw new HttpError('Gmail recipient/sender envs are missing.', 500);
  }

  const accessToken = await getAccessToken(env);
  const rawMessage = buildCompletionEmailMessage({ ...input, to, from });
  const response = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ raw: toBase64Url(rawMessage) }),
  });

  if (!response.ok) {
    throw new HttpError('Gmail API send failed.', 502, await response.text());
  }
}
