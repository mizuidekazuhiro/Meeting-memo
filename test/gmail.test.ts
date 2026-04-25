// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildCompletionEmailMessage, shouldSendCompletionEmail } from '../src/lib/gmail';

test('completion email body contains notion link/summary/transcript/my tasks', () => {
  const message = buildCompletionEmailMessage({
    to: 'to@example.com',
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl: 'https://www.notion.so/example',
    summary: 'summary text',
    transcript: 'transcript text',
    myTasks: ['task 1', 'task 2'],
    fileName: 'meeting.m4a',
    recordingId: 'rec-1',
    completedAt: '2026-04-20T00:00:00.000Z',
  });

  assert.ok(message.includes('https://www.notion.so/example'));
  assert.ok(message.includes('summary text'));
  assert.ok(message.includes('transcript text'));
  assert.ok(message.includes('task 1'));
  assert.ok(message.includes('task 2'));
});

test('shouldSendCompletionEmail is true only when enabled and all required envs exist', () => {
  const baseEnv = {
    GMAIL_NOTIFY_ENABLED: 'true',
    GMAIL_TO: 'to@example.com',
    GMAIL_FROM: 'from@example.com',
    GMAIL_OAUTH_CLIENT_ID: 'client-id',
    GMAIL_OAUTH_CLIENT_SECRET: 'client-secret',
    GMAIL_OAUTH_REFRESH_TOKEN: 'refresh-token',
  } as any;

  assert.equal(shouldSendCompletionEmail(baseEnv), true);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, GMAIL_NOTIFY_ENABLED: 'false' }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, GMAIL_TO: '   ' }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, GMAIL_FROM: undefined }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, GMAIL_OAUTH_CLIENT_ID: '' }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, GMAIL_OAUTH_CLIENT_SECRET: '' }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, GMAIL_OAUTH_REFRESH_TOKEN: '' }), false);
});
