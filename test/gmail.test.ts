// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildCompletionEmailMessage, buildCompletionEmailSubject, shouldSendCompletionEmail } from '../src/lib/gmail';

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
    transcriptFileUrl: 'https://dropbox.example.com/transcript.txt',
    summary: 'summary text',
    transcript: 'transcript text',
    myTasks: [{ taskText: 'task 1', chooseUrl: chooseUrl1 }, { taskText: 'task 2', chooseUrl: chooseUrl2 }],
    review: {
      summaryForEmail: 'review summary',
      correctedTermsMarkdown: 'terms',
      uncertainItemsMarkdown: 'uncertain',
      nextActionsMarkdown: 'actions',
      humanCheckRequired: false,
      humanCheckReason: 'ok',
      sourceUrls: ['https://example.com'],
    },
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
  assert.ok(message.includes('summary text'));
  assert.ok(message.includes('review summary'));
  assert.ok(message.includes('terms'));
  assert.ok(message.includes('transcript text'));
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
    summary: 'summary',
    transcript: 'transcript',
    myTasks: [],
  });
  assert.equal(message.includes('Transcript全文リンク：<a href=""'), false);
});

test('subject includes 要確認 prefix when humanCheckRequired=true', () => {
  const subject = buildCompletionEmailSubject('Interview Memo 完了通知', {
    summaryForEmail: 'review',
    correctedTermsMarkdown: '',
    uncertainItemsMarkdown: '',
    nextActionsMarkdown: '',
    humanCheckRequired: true,
    humanCheckReason: '要確認',
    sourceUrls: [],
  });
  assert.equal(subject, '【要確認】Interview Memo 完了通知');
});

test('subject includes レビュー失敗 prefix when reviewError exists', () => {
  const subject = buildCompletionEmailSubject('Interview Memo 完了通知', undefined, 'レビュー失敗');
  assert.equal(subject, '【レビュー失敗】Interview Memo 完了通知');

  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    from: 'from@example.com',
    subject,
    notionPageUrl: 'https://www.notion.so/example',
    summary: 'summary',
    transcript: 'transcript',
    myTasks: [],
    reviewError: 'レビュー失敗',
  });
  assert.ok(message.includes('Subject: 【レビュー失敗】Interview Memo 完了通知'));
  assert.ok(message.includes('二次レビューは失敗しました。一次要約とTranscriptのみ保存されています。'));
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
