// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { importMyTasksToInbox, upsertInterviewFromTranscript } from '../src/lib/notion';

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
    { errorMessage: 'summary failed but transcript persisted', summaryRaw: { provider: 'responses' }, summaryErrorMessage: 'summary failed', summaryErrorDetails: { code: 'parse_failed' } },
  );

  global.fetch = originalFetch;

  const properties = pagesPayloads[0].properties;
  assert.ok(properties.Summary.rich_text[0].text.content.includes('要点'));
  assert.ok(properties['My Tasks'].rich_text[0].text.content.includes('私のタスク'));
  assert.ok(properties['Other Tasks'].rich_text[0].text.content.includes('相手のタスク'));
  assert.ok(properties['Raw JSON'].rich_text[0].text.content.includes('"transcript":'));
  assert.ok(properties['Raw JSON'].rich_text[0].text.content.includes('"insights":'));
  assert.ok(properties['Raw JSON'].rich_text[0].text.content.includes('"summaryRaw":'));
  assert.ok(properties['Error Message'].rich_text[0].text.content.includes('summary failed'));
});

test('importMyTasksToInbox creates only My Tasks and deduplicates same recording/task text', async () => {
  const originalFetch = global.fetch;
  const queryBodies: any[] = [];
  const pageBodies: any[] = [];
  const dedupKeyHits = new Set<string>();

  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/databases/') && url.endsWith('/query')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      queryBodies.push(body);
      const dedupKey = body?.filter?.rich_text?.equals;
      const exists = typeof dedupKey === 'string' && dedupKeyHits.has(dedupKey);
      return new Response(JSON.stringify({ results: exists ? [{ id: 'existing-task' }] : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/pages')) {
      if (typeof init?.body === 'string') {
        const payload = JSON.parse(init.body);
        pageBodies.push(payload);
        const dedupKey = payload?.properties?.['Dedup Key']?.rich_text?.[0]?.text?.content;
        if (typeof dedupKey === 'string') dedupKeyHits.add(dedupKey);
      }
      return new Response(JSON.stringify({ id: `task_${pageBodies.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const env = { NOTION_TOKEN: 'token', INBOX_DB_ID: 'db' } as any;
  const first = await importMyTasksToInbox(env, {
    recordingId: 'rec-1',
    sourceInterviewPageId: 'interview-page-id',
    myTasks: ['  first   task ', 'first task', '- second task', ''],
  });
  const second = await importMyTasksToInbox(env, {
    recordingId: 'rec-1',
    sourceInterviewPageId: 'interview-page-id',
    myTasks: ['first task', 'second task'],
  });
  global.fetch = originalFetch;

  assert.equal(first.importedCount, 2);
  assert.equal(second.importedCount, 0);
  assert.equal(second.skippedDuplicates, 2);
  assert.ok(pageBodies.every((body) => body.properties['Record Type'].select.name === 'Task'));
  assert.ok(pageBodies.every((body) => body.properties.Source.rich_text[0].text.content === 'meeting_memo'));
  assert.ok(pageBodies.every((body) => body.properties.Name.title[0].text.content !== ''));
  assert.ok(queryBodies.length >= 4);
});
