// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { assertInterviewPageIdentity, findExistingInterview, upsertInterviewPage, writeFinalMemoToNotionPage } from '../src/lib/notion';

const env = { NOTION_TOKEN: 'token', INBOX_DB_ID: 'db' } as any;
const oldId = 'id:jb_wTME9uNwAAAAAAAAAUw';
const newId = 'id:jb_wTME9uNwAAAAAAAAAuw';
const key = (id: string) => `dropbox:id:${id}`;
const page = (id: string, fileId: string) => ({ id, properties: {
  'Dedup Key': { rich_text: [{ plain_text: key(fileId) }] },
  'Dropbox File Id': { rich_text: [{ text: { content: fileId } }] },
} });

test('case-only Dropbox ID match is rejected and a later exact match is selected', async () => {
  const saved = global.fetch;
  const queries = [];
  global.fetch = async (_url, init) => {
    const q = JSON.parse(init.body); queries.push(q);
    return Response.json(q.start_cursor
      ? { results: [page('giken', newId)], has_more: false }
      : { results: [page('india', oldId)], has_more: true, next_cursor: 'next' });
  };
  try {
    assert.equal((await findExistingInterview(env, [key(newId)]))?.id, 'giken');
    assert.equal(queries.length, 2);
    assert.equal(queries[1].start_cursor, 'next');
  } finally { global.fetch = saved; }
});

test('case-only match alone is treated as a different recording', async () => {
  const saved = global.fetch;
  global.fetch = async () => Response.json({ results: [page('india', oldId)], has_more: false });
  try { assert.equal(await findExistingInterview(env, [key(newId)]), null); }
  finally { global.fetch = saved; }
});

test('two exact matches stop processing instead of selecting an arbitrary page', async () => {
  const saved = global.fetch;
  global.fetch = async () => Response.json({ results: [page('one', newId), page('two', newId)], has_more: false });
  try { await assert.rejects(findExistingInterview(env, [key(newId)]), /Multiple Notion pages/); }
  finally { global.fetch = saved; }
});

test('upsert and resumed page identity checks refuse a different file before any mutation', async () => {
  const saved = global.fetch;
  const methods = [];
  global.fetch = async (_url, init) => { methods.push(init.method); return Response.json(page('india', oldId)); };
  try {
    await assert.rejects(upsertInterviewPage(env, { metadata: { id: newId, name: 'giken.m4a' }, request: {}, title: 'Giken', dedupKey: key(newId), processingStatus: 'persisted' }, page('india', oldId)), /does not exactly match/);
    await assert.rejects(assertInterviewPageIdentity(env, 'india', newId), /does not exactly match/);
    assert.deepEqual(methods, ['GET']);
  } finally { global.fetch = saved; }
});

const heading = (id, level, text) => ({ id, type: `heading_${level}`, [`heading_${level}`]: { rich_text: [{ plain_text: text }] } });

function notionStore(initial, failStaging = false) {
  const store = new Map([['page', [...initial]]]);
  const deleted = [];
  let serial = 0;
  const mock = async (url, init) => {
    const target = String(url).match(/\/blocks\/([^/?]+)/)[1];
    if (init.method === 'DELETE') {
      deleted.push(target);
      for (const [parent, blocks] of store) store.set(parent, blocks.filter(x => x.id !== target));
      return Response.json({});
    }
    if (init.method === 'PATCH') {
      if (target !== 'page' && failStaging) return Response.json({ error: 'write failed' }, { status: 400 });
      const children = JSON.parse(init.body).children.map(x => ({ ...x, id: `created-${++serial}` }));
      store.set(target, [...(store.get(target) ?? []), ...children]);
      return Response.json({ results: children });
    }
    return Response.json({ results: store.get(target) ?? [], has_more: false, next_cursor: null });
  };
  return { mock, store, deleted };
}

for (const legacyTitle of ['完成版 面談メモ', '面談メモ（完成版）']) {
  test(`replaces all sections under ${legacyTitle} and preserves transcript and separate user notes`, async () => {
    const saved = global.fetch;
    const api = notionStore([
      heading('old-title', 1, legacyTitle), heading('inner-title', 1, '完成版 面談メモ'),
      heading('section-one', 2, '1. 案件概要'), { id: 'india-text', type: 'paragraph' },
      heading('section-two', 2, '2. 戦略'), { id: 'india-table', type: 'table' },
      heading('transcript', 2, 'Transcript'), { id: 'transcript-link', type: 'paragraph' },
      heading('notes', 1, '個人の追記'), { id: 'manual-text', type: 'paragraph' },
    ]);
    global.fetch = api.mock;
    try {
      await writeFinalMemoToNotionPage(env, 'page', '# 完成版 面談メモ\n\n## 技研見学\n新しい内容', []);
      assert.deepEqual(api.deleted, ['india-table', 'section-two', 'india-text', 'section-one', 'inner-title', 'old-title']);
      assert.ok(api.store.get('page').some(x => x.id === 'manual-text'));
      await writeFinalMemoToNotionPage(env, 'page', '# 完成版 面談メモ\n\n## 技研見学\n再実行', []);
      assert.equal(api.store.get('page').filter(x => x.type === 'callout').length, 1);
      assert.ok(api.store.get('page').some(x => x.id === 'transcript'));
    } finally { global.fetch = saved; }
  });
}

test('staging failure keeps every previous memo block', async () => {
  const saved = global.fetch;
  const initial = [heading('old', 1, '完成版 面談メモ'), { id: 'old-text', type: 'paragraph' }];
  const api = notionStore(initial, true); global.fetch = api.mock;
  try {
    await assert.rejects(writeFinalMemoToNotionPage(env, 'page', 'new memo', []), /Notion API call failed/);
    assert.deepEqual(api.store.get('page'), initial);
    assert.ok(!api.deleted.includes('old'));
  } finally { global.fetch = saved; }
});

test('empty replacement never removes an existing memo', async () => {
  const saved = global.fetch;
  const api = notionStore([heading('old', 1, '完成版 面談メモ')]); global.fetch = api.mock;
  try {
    await assert.rejects(writeFinalMemoToNotionPage(env, 'page', ' ', []), /memo is empty/);
    assert.deepEqual(api.deleted, []);
  } finally { global.fetch = saved; }
});
