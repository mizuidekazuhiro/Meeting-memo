// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const oldPage = '38adec27-c9aa-81e9-bfba-e8ae63d8af70';
const newPage = '3fadec27-c9aa-8179-b8a6-f53e1152f8c1';
const backup = '3fadec27-c9aa-81b8-9a1c-fc97b32901bf';
const oldId = 'id:jb_wTME9uNwAAAAAAAAAUw';
const newId = 'id:jb_wTME9uNwAAAAAAAAAuw';
const recording = `${newId}:2026-10-15-11_02_59.m4a`;
const jobKey = `recordingJob:recordingId:${recording}`;
const rt = value => ({ type: 'rich_text', rich_text: [{ plain_text: value, type: 'text', text: { content: value } }] });
const pt = p => p?.rich_text?.map(x => x.text?.content ?? x.plain_text).join('');

test('incident recovery preserves notification state, snapshots originals, and repoints only the intended job', async () => {
  const savedFetch = global.fetch;
  const names = ['NOTION_TOKEN', 'INBOX_DB_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  const savedEnv = names.map(x => process.env[x]);
  names.forEach(x => { process.env[x] = 'test'; });
  const originalJob = { recordingId: recording, dropboxFileId: newId, fileName: '2026-10-15-11_02_59.m4a', status: 'completed', notionPageId: oldPage, notificationSentAt: 'sent', emailSentAt: 'sent', transcriptFileUrl: 'https://example.com/new-transcript' };
  const oldRecording = `${oldId}:2026-06-25-14_54_23.m4a`;
  const oldJob = { recordingId: oldRecording, dropboxFileId: oldId, summaryInsights: { myTasks: ['old task'], otherTasks: ['old other task'] } };
  const kv = new Map([[jobKey, originalJob], [`recordingJob:recordingId:${oldRecording}`, oldJob]]);
  const pages = new Map([
    [oldPage, { properties: { 'Dedup Key': rt(`dropbox:id:${newId}`), 'Dropbox File Id': rt(newId), 'Summary': rt('new memo'), 'My Tasks': rt('new task') } }],
    [newPage, { properties: { 'Dedup Key': rt('staging'), 'Dropbox File Id': rt(newId) } }],
    [backup, { properties: { 'Dedup Key': rt(''), 'Dropbox File Id': rt('') } }],
  ]);
  const mutations = [];
  global.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.cloudflare.com') {
      const k = decodeURIComponent(url.pathname.split('/values/')[1]);
      if (init.method === 'PUT') { mutations.push(k); kv.set(k, JSON.parse(init.body)); return Response.json({ success: true }); }
      return kv.has(k) ? Response.json(kv.get(k)) : Response.json({}, { status: 404 });
    }
    if (url.pathname.includes('/databases/')) return Response.json({ results: [pages.get(oldPage)] });
    const id = url.pathname.split('/pages/')[1];
    assert.ok(pages.has(id));
    if (init.method === 'PATCH') { mutations.push(id); Object.assign(pages.get(id).properties, JSON.parse(init.body).properties); }
    return Response.json(pages.get(id));
  };
  try {
    const run = new Function('url', 'return import(url)');
    const url = pathToFileURL(resolve('scripts/recover-20261015-identity.mjs')).href;
    await run(url);
    assert.equal(mutations[0], 'recordingJob:recovery:20261015-identity:before');
    assert.equal(kv.get(jobKey).notionPageId, newPage);
    for (const field of ['recordingId', 'dropboxFileId', 'fileName', 'status', 'notificationSentAt', 'emailSentAt', 'transcriptFileUrl']) assert.equal(kv.get(jobKey)[field], originalJob[field]);
    assert.deepEqual(kv.get(`recordingJob:recordingId:${oldRecording}`), oldJob);
    assert.equal(pt(pages.get(oldPage).properties['Dropbox File Id']), oldId);
    assert.equal(pt(pages.get(newPage).properties['Dropbox File Id']), newId);
    assert.equal(pt(pages.get(oldPage).properties['My Tasks']), '- old task');
    // Running the repair a second time must not replace the original snapshot.
    await run(`${url}?retry`);
    assert.deepEqual(kv.get('recordingJob:recovery:20261015-identity:before').job, originalJob);
    assert.equal(pt(pages.get(newPage).properties['Summary']), 'new memo');
  } finally {
    global.fetch = savedFetch;
    names.forEach((name, i) => { if (savedEnv[i] === undefined) delete process.env[name]; else process.env[name] = savedEnv[i]; });
  }
});
