// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildCompletionEmailMessage } from '../src/lib/gmail';

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
