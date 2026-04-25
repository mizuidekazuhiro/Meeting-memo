// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { appendReviewedMemoToNotionPage, buildTranscriptBlocks, extractTasksFromFinalMemoMarkdown, extractTasksFromNextActionsMarkdown, importMyTasksToInbox, saveTranscriptLinkToNotion, upsertInterviewFromTranscript } from '../src/lib/notion';

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

test('appendReviewedMemoToNotionPage writes final memo + source urls and does not re-append Transcript', async () => {
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
  );
  global.fetch = originalFetch;

  const allChildren = appendedChildren.flatMap((payload) => payload.children);
  const heading1 = allChildren.filter((block) => block.type === 'heading_1').map((block) => block.heading_1.rich_text[0].text.content);
  const heading2 = allChildren.filter((block) => block.type === 'heading_2').map((block) => block.heading_2.rich_text[0].text.content);
  assert.ok(heading1.includes('面談メモ（完成版）'));
  assert.ok(heading2.includes('参考リンク'));
  assert.equal(heading2.includes('Transcript'), false);
  const h2Title = allChildren.find((block) => block.type === 'heading_2' && block.heading_2.rich_text[0].text.content === '結論');
  assert.ok(h2Title);
  const bullet = allChildren.find((block) => block.type === 'bulleted_list_item');
  assert.equal(bullet.bulleted_list_item.rich_text[0].text.content, '四番線の電車は各駅停車で押上行き');
  assert.equal(bullet.bulleted_list_item.rich_text[0].annotations.bold, true);
  const table = allChildren.find((block) => block.type === 'table');
  assert.ok(table);
  assert.equal(table.table.children[0].table_row.cells[0][0].text.content, '項目');
  const transcriptParagraph = allChildren.find((block) => block.type === 'paragraph' && String(block.paragraph?.rich_text?.[0]?.text?.content ?? '').includes('hello transcript'));
  assert.equal(Boolean(transcriptParagraph), false);
  const plainTextDump = JSON.stringify(allChildren);
  assert.equal(plainTextDump.includes('|---|---|'), false);
  assert.equal(plainTextDump.includes('**四番線の電車は各駅停車で押上行き**'), false);
  assert.equal(plainTextDump.includes('## 結論'), false);
});

test('extractTasksFromNextActionsMarkdown splits markdown bullets', () => {
  const tasks = extractTasksFromNextActionsMarkdown('- task1\n・ task2\n1. task3\n特になし');
  assert.deepEqual(tasks, ['task1', 'task2', 'task3']);
});

test('extractTasksFromFinalMemoMarkdown extracts from 次アクション section', () => {
  const finalMemo = [
    '【面談メモ｜鉄鋼業界の現状と展望】',
    '■ 確認できた内容',
    '- 市況確認を実施。',
    '■ 次アクション',
    '- IR及び大阪周辺の基礎工事・杭打ちの詳細進捗調査を実施。',
    '- 潤滑油、塗料等資材の調達現況及び価格交渉体制の現場確認を依頼。',
    '- ベトナム現地の鉄鋼製造企業の生産状況及び市場動向の追加ヒアリング。',
    '■ 未確認事項',
    '- 数値の出典確認。',
  ].join('\n');
  const tasks = extractTasksFromFinalMemoMarkdown(finalMemo);
  assert.deepEqual(tasks, [
    'IR及び大阪周辺の基礎工事・杭打ちの詳細進捗調査を実施。',
    '潤滑油、塗料等資材の調達現況及び価格交渉体制の現場確認を依頼。',
    'ベトナム現地の鉄鋼製造企業の生産状況及び市場動向の追加ヒアリング。',
  ]);
});

test('buildTranscriptBlocks does not expand full transcript into many notion blocks', () => {
  const longText = 'a'.repeat(50000);
  const blocks = buildTranscriptBlocks({
    title: 't',
    dedupKey: 'd',
    metadata: { name: 'm4a' },
    request: {},
    processingStatus: 'persisted',
    transcript: { fullText: longText, segments: [], raw: {} },
  } as any, { excerptChars: 4000, transcriptFileUrl: 'https://dropbox.example.com/transcript' });
  assert.ok(blocks.length <= 10);
  const dumped = JSON.stringify(blocks);
  assert.equal(dumped.includes(longText), false);
  assert.ok(dumped.includes('Transcript全文リンク'));
});

test('saveTranscriptLinkToNotion falls back to body when Transcript Link property is missing', async () => {
  const originalFetch = global.fetch;
  const patchBodies: any[] = [];
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/pages/page_1') && init?.method === 'GET') {
      return new Response(JSON.stringify({ properties: { Name: { type: 'title' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/page_1/children') && init?.method === 'PATCH') {
      if (typeof init.body === 'string') patchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const result = await saveTranscriptLinkToNotion({ NOTION_TOKEN: 'token', INBOX_DB_ID: 'db' } as any, 'page_1', 'https://dropbox.example.com/txt');
  global.fetch = originalFetch;

  assert.equal(result.usedProperty, false);
  assert.equal(result.fallbackToBody, true);
  assert.ok(JSON.stringify(patchBodies).includes('Transcript全文リンク'));
});
