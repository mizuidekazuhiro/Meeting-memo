// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildCompletionEmailMessage, shouldSendCompletionEmail } from '../src/lib/gmail';

test('completion email body contains notion link/summary/transcript/my tasks', () => {
  const notionPageUrl = 'https://www.notion.so/example';
  const chooseUrl1 = 'https://triage.example.com/move/choose?inbox_page_id=abc123&sig=deadbeef';
  const chooseUrl2 = 'https://triage.example.com/move/choose?inbox_page_id=def456&sig=cafebabe';
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    cc: ['cc@example.com'],
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl,
    summary: 'summary text',
    transcript: 'transcript text',
    myTasks: [{ taskText: 'task 1', chooseUrl: chooseUrl1 }, { taskText: 'task 2', chooseUrl: chooseUrl2 }],
    fileName: 'meeting.m4a',
    recordingId: 'rec-1',
    completedAt: '2026-04-20T00:00:00.000Z',
  });

  assert.ok(message.includes('To: to@example.com'));
  assert.ok(message.includes('Cc: cc@example.com'));
  assert.ok(message.includes(`href="${notionPageUrl}"`));
  assert.ok(message.includes('Notion ページを開く'));
  assert.ok(!message.includes(`>${notionPageUrl}</a>`));
  assert.ok(!message.includes('<strong>fileName:</strong>'));
  assert.ok(!message.includes('<strong>recordingId:</strong>'));
  assert.ok(!message.includes('<strong>completedAt:</strong>'));
  assert.ok(message.includes("font-family:'Yu Gothic UI'"));
  assert.ok(message.includes('summary text'));
  assert.ok(message.includes('transcript text'));
  assert.ok(message.includes('task 1'));
  assert.ok(message.includes('task 2'));
  assert.ok(message.includes('タスク処理を選ぶ'));
  assert.ok(message.includes('/move/choose?'));
  assert.ok(message.includes('href="https://triage.example.com/move/choose?inbox_page_id=abc123&amp;sig=deadbeef"'));
  assert.ok(message.includes('href="https://triage.example.com/move/choose?inbox_page_id=def456&amp;sig=cafebabe"'));
  assert.ok(!message.includes('/action/move'));
});

test('completion email body contains memo choose button when memoChooseUrl exists', () => {
  const memoChooseUrl = 'https://triage.example.com/move/choose?inbox_page_id=memo123&sig=beadfeed';
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl: 'https://www.notion.so/example',
    memoChooseUrl,
    summary: 'summary text',
    transcript: 'transcript text',
    myTasks: [],
    fileName: 'meeting.m4a',
    recordingId: 'rec-1',
    completedAt: '2026-04-20T00:00:00.000Z',
  });

  assert.ok(message.includes('この面談メモを処理する'));
  assert.ok(message.includes('href="https://triage.example.com/move/choose?inbox_page_id=memo123&amp;sig=beadfeed"'));
});

test('completion email body omits memo choose button when memoChooseUrl is missing', () => {
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl: 'https://www.notion.so/example',
    summary: 'summary text',
    transcript: 'transcript text',
    myTasks: [],
    fileName: 'meeting.m4a',
    recordingId: 'rec-1',
    completedAt: '2026-04-20T00:00:00.000Z',
  });

  assert.ok(!message.includes('この面談メモを処理する'));
  assert.ok(message.includes('Notion ページを開く'));
  assert.ok(message.includes('Summary'));
});

test('shouldSendCompletionEmail is true only when enabled and all required envs exist', () => {
  const baseEnv = {
    GMAIL_NOTIFY_ENABLED: 'true',
    MAIL_TO: 'to@example.com',
    MAIL_FROM: 'from@example.com',
    MAIL_PASSWORD: 'app-password',
  } as any;

  assert.equal(shouldSendCompletionEmail(baseEnv), true);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, GMAIL_NOTIFY_ENABLED: 'false' }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, MAIL_TO: '   ' }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, MAIL_FROM: undefined }), false);
  assert.equal(shouldSendCompletionEmail({ ...baseEnv, MAIL_PASSWORD: '' }), false);
});
