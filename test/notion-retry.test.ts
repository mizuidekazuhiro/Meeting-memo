// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { updateInterviewRecordProperties } from '../src/lib/notion';

test('Notion writes retry transient 429 and 529 responses using Retry-After', async () => {
  const originalFetch = global.fetch;
  const statuses = [429, 529, 200];
  let calls = 0;

  global.fetch = (async () => {
    const status = statuses[calls++] ?? 200;
    if (status === 200) {
      return new Response(JSON.stringify({ ok: true }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'retry me' }), {
      status,
      headers: {
        'content-type': 'application/json',
        'retry-after': '0',
      },
    });
  }) as any;

  try {
    await updateInterviewRecordProperties({
      NOTION_TOKEN: 'token',
      INBOX_DB_ID: 'db',
    } as any, 'page-1', {
      title: 'Retry test',
      dedupKey: 'retry-test',
      metadata: { name: 'retry.m4a' },
      request: { fileName: 'retry.m4a' },
      transcript: {
        fullText: 'hello',
        segments: [],
        raw: {},
      },
      insights: {
        summary: 'summary',
        myTasks: [],
        otherTasks: [],
        ambiguities: [],
        raw: {},
      },
      processingStatus: 'persisted',
    } as any);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls, 3);
});
