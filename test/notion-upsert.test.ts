// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { appendReviewedMemoToNotionPage, importMyTasksToInbox, upsertInterviewFromTranscript } from '../src/lib/notion';

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
    if (url.endsWith('/databases/db') && (init?.method ?? 'GET') === 'GET') {
      return new Response(
        JSON.stringify({
          properties: {
            Name: {},
            Source: {},
            'Record Type': {},
            'Source Recording ID': {},
            'Source Interview Page ID': {},
            'Source Interview URL': {},
            'Imported At': {},
            'Dedup Key': {},
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
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
  assert.equal(first.importedTaskItems.length, 2);
  assert.ok(first.importedTaskItems.every((item) => item.inboxPageId.startsWith('task_')));
  assert.ok(first.importedTaskItems.every((item) => item.skippedDuplicate === false));
  assert.equal(first.skippedBecauseMissingProperties, 0);
  assert.deepEqual(first.missingProperties, []);
  assert.equal(second.importedCount, 0);
  assert.equal(second.skippedDuplicates, 2);
  assert.equal(second.importedTaskItems.length, 2);
  assert.ok(second.importedTaskItems.every((item) => item.inboxPageId === 'existing-task'));
  assert.ok(second.importedTaskItems.every((item) => item.skippedDuplicate === true));
  assert.ok(pageBodies.every((body) => body.properties['Record Type'].select.name === 'Task'));
  assert.ok(pageBodies.every((body) => body.properties.Source.rich_text[0].text.content === 'meeting_memo'));
  assert.ok(pageBodies.every((body) => body.properties.Name.title[0].text.content !== ''));
  assert.ok(pageBodies.every((body) => body.properties['Source Recording ID']));
  assert.ok(pageBodies.every((body) => body.properties['Source Interview Page ID']));
  assert.ok(pageBodies.every((body) => body.properties['Source Interview URL']));
  assert.ok(queryBodies.length >= 4);
});

test('importMyTasksToInbox omits optional source properties that are not in DB schema', async () => {
  const originalFetch = global.fetch;
  const pageBodies: any[] = [];

  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/databases/db') && (init?.method ?? 'GET') === 'GET') {
      return new Response(
        JSON.stringify({
          properties: {
            Name: {},
            Source: {},
            'Record Type': {},
            'Imported At': {},
            'Dedup Key': {},
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/databases/') && url.endsWith('/query')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/pages')) {
      if (typeof init?.body === 'string') pageBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `task_${pageBodies.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const env = { NOTION_TOKEN: 'token', INBOX_DB_ID: 'db', INBOX_TRIAGE_BASE_URL: 'https://triage.example.com', INBOX_TRIAGE_ACTION_SECRET: 'secret-1' } as any;
  const result = await importMyTasksToInbox(env, {
    recordingId: 'rec-1',
    sourceInterviewPageId: 'interview-page-id',
    myTasks: ['first task'],
  });
  global.fetch = originalFetch;

  assert.equal(result.importedCount, 1);
  assert.equal(result.importedTaskItems.length, 1);
  assert.ok(result.importedTaskItems[0].chooseUrl?.includes('/move/choose?'));
  assert.ok(result.importedTaskItems[0].chooseUrl?.includes('inbox_page_id=task_1'));
  assert.ok(!result.importedTaskItems[0].chooseUrl?.includes('/action/move'));
  assert.equal(result.skippedBecauseMissingProperties, 3);
  assert.deepEqual(result.missingProperties, ['Source Recording ID', 'Source Interview Page ID', 'Source Interview URL']);
  assert.equal(pageBodies.length, 1);
  assert.equal(pageBodies[0].properties['Source Recording ID'], undefined);
  assert.equal(pageBodies[0].properties['Source Interview Page ID'], undefined);
  assert.equal(pageBodies[0].properties['Source Interview URL'], undefined);
});

test('appendReviewedMemoToNotionPage adds review sections and keeps Transcript', async () => {
  const originalFetch = global.fetch;
  const appendedChildren: any[] = [];
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/blocks/page_1/children?')) {
      return new Response(JSON.stringify({
        results: [
          { object: 'block', id: 'h1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Transcript' }] } },
          { object: 'block', id: 'p1', type: 'paragraph' },
        ],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/page_1/children') && init?.method === 'PATCH') {
      if (typeof init.body === 'string') appendedChildren.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  await appendReviewedMemoToNotionPage(
    { NOTION_TOKEN: 'token', INBOX_DB_ID: 'db' } as any,
    'page_1',
    {
      finalMemoMarkdown: [
        '# 面談メモ（二次レビュー）',
        '## 結論',
        '- **四番線の電車は各駅停車で押上行き**',
        '## 事実',
        '| 項目 | 値 |',
        '|---|---|',
        '| 発話 | Mike test |',
      ].join('\n'),
      correctedTermsMarkdown: 'corrected',
      summaryForEmail: 'summary',
      uncertainItemsMarkdown: 'uncertain',
      nextActionsMarkdown: 'actions',
      humanCheckRequired: true,
      humanCheckReason: 'reason',
      myTasks: [],
      otherTasks: [],
      sourceUrls: ['https://example.com'],
      raw: {},
    },
    {
      title: 't',
      dedupKey: 'd',
      metadata: { name: 'm4a' },
      request: {},
      processingStatus: 'persisted',
      transcript: { fullText: 'hello transcript', segments: [], raw: {} },
    } as any,
  );
  global.fetch = originalFetch;

  const allChildren = appendedChildren.flatMap((payload) => payload.children);
  const headings = allChildren.filter((block) => block.type === 'heading_2').map((block) => block.heading_2.rich_text[0].text.content);
  assert.ok(headings.includes('面談メモ（完成版）'));
  assert.ok(headings.includes('固有名詞補正'));
  assert.ok(headings.includes('未確定事項'));
  assert.ok(headings.includes('次に取るべき行動'));
  assert.ok(headings.includes('Transcript'));
  const h1 = allChildren.find((block) => block.type === 'heading_1');
  assert.equal(h1.heading_1.rich_text[0].text.content, '面談メモ（二次レビュー）');
  const nestedH2 = allChildren.find((block) => block.type === 'heading_2' && block.heading_2.rich_text[0].text.content === '結論');
  assert.ok(nestedH2);
  const bullet = allChildren.find((block) => block.type === 'bulleted_list_item');
  assert.equal(bullet.bulleted_list_item.rich_text[0].text.content, '四番線の電車は各駅停車で押上行き');
  assert.equal(bullet.bulleted_list_item.rich_text[0].annotations.bold, true);
  const table = allChildren.find((block) => block.type === 'table');
  assert.ok(table);
  assert.equal(table.table.children[0].table_row.cells[0][0].text.content, '項目');
  const transcriptParagraph = allChildren.find((block) => block.type === 'paragraph' && block.paragraph?.rich_text?.[0]?.text?.content === 'hello transcript');
  assert.ok(transcriptParagraph);
  const plainTextDump = JSON.stringify(allChildren);
  assert.equal(plainTextDump.includes('|---|---|'), false);
  assert.equal(plainTextDump.includes('**四番線の電車は各駅停車で押上行き**'), false);
  assert.equal(plainTextDump.includes('## 結論'), false);
});
