// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildCompletionEmailMessage, buildCompletionEmailSubject, shouldSendCompletionEmail } from '../src/lib/gmail';

test('completion email body contains notion link/final memo/task links and no transcript body', () => {
  const notionPageUrl = 'https://www.notion.so/example';
  const chooseUrl1 = 'https://triage.example.com/move/choose?inbox_page_id=abc123&sig=deadbeef';
  const chooseUrl2 = 'https://triage.example.com/move/choose?inbox_page_id=def456&sig=cafebabe';
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    cc: ['cc@example.com'],
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl,
    transcriptFileUrl: 'https://dropbox.example.com/transcript.txt',
    finalMemo: '完成版メモ本文です',
    sourceUrls: ['https://example.com'],
    myTasks: [{ taskText: 'task 1', chooseUrl: chooseUrl1 }, { taskText: 'task 2', chooseUrl: chooseUrl2 }],
  });

  assert.ok(message.includes('To: to@example.com'));
  assert.ok(message.includes('Cc: cc@example.com'));
  assert.ok(message.includes(`href="${notionPageUrl}"`));
  assert.ok(message.includes('Notion ページを開く'));
  assert.ok(message.includes('Transcript全文リンク'));
  assert.ok(message.includes('href="https://dropbox.example.com/transcript.txt"'));
  assert.ok(!message.includes(`>${notionPageUrl}</a>`));
  assert.ok(!message.includes('<strong>fileName:</strong>'));
  assert.ok(!message.includes('<strong>recordingId:</strong>'));
  assert.ok(!message.includes('<strong>completedAt:</strong>'));
  assert.ok(message.includes("font-family:'Yu Gothic UI'"));
  assert.ok(message.includes('完成版 面談メモ'));
  assert.ok(message.includes('完成版メモ本文です'));
  assert.ok(message.includes('参考リンク'));
  assert.equal(message.includes('Transcript</h3>'), false);
  assert.equal(message.includes('Summary</h3>'), false);
  assert.ok(message.includes('task 1'));
  assert.ok(message.includes('task 2'));
  assert.ok(message.includes('タスク処理を選ぶ'));
  assert.ok(message.includes('/move/choose?'));
  assert.ok(message.includes('href="https://triage.example.com/move/choose?inbox_page_id=abc123&amp;sig=deadbeef"'));
  assert.ok(message.includes('href="https://triage.example.com/move/choose?inbox_page_id=def456&amp;sig=cafebabe"'));
  assert.ok(!message.includes('/action/move'));
});

test('completion email omits transcript link section when link is not provided', () => {
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl: 'https://www.notion.so/example',
    finalMemo: 'memo',
    sourceUrls: [],
    myTasks: [],
  });
  assert.equal(message.includes('Transcript全文リンク：<a href=""'), false);
  assert.equal(message.includes('My Tasks'), false);
  assert.equal(message.includes('参考リンク'), false);
});

test('subject remains unchanged', () => {
  const subject = buildCompletionEmailSubject('Interview Memo 完了通知');
  assert.equal(subject, 'Interview Memo 完了通知');
});

test('message renders plain subject without review state', () => {
  const subject = buildCompletionEmailSubject('Interview Memo 完了通知');
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    from: 'from@example.com',
    subject,
    notionPageUrl: 'https://www.notion.so/example',
    finalMemo: 'memo',
    sourceUrls: [],
    myTasks: [],
  });
  assert.ok(message.includes('Subject: Interview Memo 完了通知'));
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
