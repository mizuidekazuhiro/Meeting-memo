// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { upsertInterviewFromTranscript } from '../src/lib/notion';

test('upsertInterviewFromTranscript stores insights fields and transcript raw JSON', async () => {
  const originalFetch = global.fetch;
  const pagesPayloads: any[] = [];
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/databases/') && url.endsWith('/query')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/pages')) {
      if (typeof init?.body === 'string') pagesPayloads.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'page_direct' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/') && url.endsWith('/children')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const env = { NOTION_TOKEN: 'token', INBOX_DB_ID: 'db' } as any;
  await upsertInterviewFromTranscript(
    env,
    { fileName: 'direct.m4a', source: 'Interview' },
    { id: 'id:direct', name: 'direct.m4a', path_lower: '/apps/meetingmemo/inbox/direct.m4a' },
    { fullText: 'これは文字起こしです', segments: [{ speaker: 'spk_0', text: 'これは文字起こしです', startMs: 0, endMs: 1000 }], raw: { transcript: true } },
    { summary: '要点', myTasks: ['私のタスク'], otherTasks: ['相手のタスク'], ambiguities: [], raw: { insights: true } },
  );

  global.fetch = originalFetch;

  const properties = pagesPayloads[0].properties;
  assert.ok(properties.Summary.rich_text[0].text.content.includes('要点'));
  assert.ok(properties['My Tasks'].rich_text[0].text.content.includes('私のタスク'));
  assert.ok(properties['Other Tasks'].rich_text[0].text.content.includes('相手のタスク'));
  assert.ok(properties['Raw JSON'].rich_text[0].text.content.includes('"transcript":'));
  assert.ok(properties['Raw JSON'].rich_text[0].text.content.includes('"insights":'));
});
