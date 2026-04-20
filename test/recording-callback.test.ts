// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HttpError } from '../src/lib/http';
import { createRecordingJob, getRecordingJob, normalizeDropboxPath, upsertRecordingJob } from '../src/lib/jobs';
import { persistTranscriptionCallback } from '../src/lib/processing';

class MockKv {
  map = new Map<string, string>();
  puts: string[] = [];

  async get(key: string, type?: 'text' | 'json') {
    const value = this.map.get(key);
    if (value === undefined) return null;
    if (type === 'json') return JSON.parse(value);
    return value;
  }

  async put(key: string, value: string) {
    this.puts.push(key);
    this.map.set(key, value);
  }
}

class EventuallyConsistentMockKv extends MockKv {
  missesRemainingByKey = new Map<string, number>();

  setMisses(key: string, misses: number) {
    this.missesRemainingByKey.set(key, misses);
  }

  async get(key: string, type?: 'text' | 'json') {
    const missesRemaining = this.missesRemainingByKey.get(key) ?? 0;
    if (missesRemaining > 0) {
      this.missesRemainingByKey.set(key, missesRemaining - 1);
      return null;
    }
    return super.get(key, type);
  }
}

function makeEnv(kv: MockKv, overrides: Record<string, unknown> = {}) {
  return {
    APP_ENV: 'test',
    NOTION_TOKEN: 'token',
    INBOX_DB_ID: 'db',
    RECORDING_JOB_KV: kv,
    ...overrides,
  } as any;
}

function transcriptPayload(overrides: Record<string, unknown> = {}) {
  return {
    transcript: {
      fullText: 'hello world',
      segments: [{ speaker: 'spk_0', text: 'hello world', startMs: 0, endMs: 1000 }],
      raw: { provider: 'python' },
    },
    ...overrides,
  };
}

function installNotionFetchMock() {
  const originalFetch = global.fetch;
  let calls = 0;
  const pagePayloads: any[] = [];
  global.fetch = (async (input: string, init?: RequestInit) => {
    calls += 1;
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/responses')) {
      return new Response(JSON.stringify({ output_text: JSON.stringify({ summary: '要約', myTasks: ['自分タスク'], otherTasks: ['相手タスク'], ambiguities: [] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/databases/') && url.endsWith('/query')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/pages')) {
      if (init?.body && typeof init.body === 'string') pagePayloads.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return {
    getCalls: () => calls,
    getPagePayloads: () => pagePayloads,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

test('callback lookup finds job by recordingId', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv);
  const job = createRecordingJob({ request: { fileName: 'a.m4a' }, dropboxFileId: 'id:1', dropboxPathLower: '/apps/meetingmemo/inbox/a.m4a', fileName: 'a.m4a' });
  await upsertRecordingJob(env, job);

  const fetchMock = installNotionFetchMock();
  const result = await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId, dropboxFileId: 'different', dropboxPathLower: '/different' }));
  fetchMock.restore();

  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(result.action, 'processed');
  assert.equal(updated?.status, 'persisted');
  assert.equal(updated?.callbackStatus, 'persisted');
});

test('callback lookup retries and succeeds when KV index visibility is delayed', async () => {
  const kv = new EventuallyConsistentMockKv();
  const env = makeEnv(kv, {
    CALLBACK_JOB_LOOKUP_MAX_ATTEMPTS: '6',
    CALLBACK_JOB_LOOKUP_BASE_DELAY_MS: '1',
    CALLBACK_JOB_LOOKUP_MAX_DELAY_MS: '2',
  });
  const job = createRecordingJob({ request: { fileName: 'late-index.m4a' }, dropboxFileId: 'id:late', dropboxPathLower: '/apps/meetingmemo/inbox/late-index.m4a', fileName: 'late-index.m4a' });
  await upsertRecordingJob(env, job);

  kv.setMisses(`recordingJob:index:dropboxFileId:${job.dropboxFileId}`, 2);

  const fetchMock = installNotionFetchMock();
  const result = await persistTranscriptionCallback(
    env,
    transcriptPayload({ recordingId: 'unknown-recording-id', dropboxFileId: job.dropboxFileId, dropboxPathLower: '/different' }),
  );
  fetchMock.restore();

  assert.equal(result.action, 'processed');
});

test('callback lookup falls back to dropboxPathLower with normalized path', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv);
  const job = createRecordingJob({ request: { fileName: 'c.m4a' }, dropboxFileId: 'id:3', dropboxPathLower: ' /apps/meetingmemo/inbox/c.m4a ', fileName: 'c.m4a' });
  await upsertRecordingJob(env, job);

  const fetchMock = installNotionFetchMock();
  const result = await persistTranscriptionCallback(
    env,
    transcriptPayload({
      recordingId: 'wrong-recording-id',
      dropboxFileId: 'wrong-dropbox-id',
      dropboxPathLower: '/APPS/MEETINGMEMO/INBOX/C.M4A',
    }),
  );
  fetchMock.restore();

  assert.equal(result.action, 'processed');
});

test('callback returns not found with retry details when no lookup key resolves', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv, {
    CALLBACK_JOB_LOOKUP_MAX_ATTEMPTS: '3',
    CALLBACK_JOB_LOOKUP_BASE_DELAY_MS: '1',
    CALLBACK_JOB_LOOKUP_MAX_DELAY_MS: '1',
  });

  await assert.rejects(
    () => persistTranscriptionCallback(env, transcriptPayload({ recordingId: 'missing', dropboxFileId: 'missing', dropboxPathLower: '/missing' })),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      assert.equal((error.details as any).phase, 'lookup_job');
      assert.equal((error.details as any).attempts, 3);
      assert.equal((error.details as any).totalWaitMs, 2);
      return true;
    },
  );
});

test('duplicate callback is idempotent after persisted status', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv);
  const job = createRecordingJob({ request: { fileName: 'd.m4a' }, dropboxFileId: 'id:4', dropboxPathLower: '/apps/meetingmemo/inbox/d.m4a', fileName: 'd.m4a' });
  await upsertRecordingJob(env, job);

  const fetchMock = installNotionFetchMock();
  const first = await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId, dropboxFileId: job.dropboxFileId, dropboxPathLower: job.dropboxPathLower }));
  const notionCallsAfterFirst = fetchMock.getCalls();
  const second = await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId, dropboxFileId: job.dropboxFileId, dropboxPathLower: job.dropboxPathLower }));
  fetchMock.restore();

  assert.equal(first.action, 'processed');
  assert.match(second.reason, /Duplicate callback ignored/);
  assert.equal(fetchMock.getCalls(), notionCallsAfterFirst);
});

test('callback path writes Summary/My Tasks/Other Tasks in Notion payload', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv, { OPENAI_API_KEY: 'test' });
  const job = createRecordingJob({ request: { fileName: 'summary.m4a' }, dropboxFileId: 'id:summary', dropboxPathLower: '/apps/meetingmemo/inbox/summary.m4a', fileName: 'summary.m4a' });
  await upsertRecordingJob(env, job);

  const fetchMock = installNotionFetchMock();
  await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId, dropboxFileId: job.dropboxFileId, dropboxPathLower: job.dropboxPathLower }));
  fetchMock.restore();

  const pagePayload = fetchMock.getPagePayloads()[0];
  assert.ok(pagePayload.properties.Summary.rich_text[0].text.content.includes('要約'));
  assert.ok(pagePayload.properties['My Tasks'].rich_text[0].text.content.includes('自分タスク'));
  assert.ok(pagePayload.properties['Other Tasks'].rich_text[0].text.content.includes('相手タスク'));
});

test('callback imports only My Tasks into inbox task pages', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv, { OPENAI_API_KEY: 'test' });
  const job = createRecordingJob({ request: { fileName: 'tasks-only.m4a' }, dropboxFileId: 'id:tasks-only', dropboxPathLower: '/apps/meetingmemo/inbox/tasks-only.m4a', fileName: 'tasks-only.m4a' });
  await upsertRecordingJob(env, job);

  const originalFetch = global.fetch;
  const pagePayloads: any[] = [];
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/responses')) {
      return new Response(JSON.stringify({ output_text: JSON.stringify({ summary: 'ok', myTasks: ['私タスク1'], otherTasks: ['他者タスク1'], ambiguities: [] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/databases/') && url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/pages')) {
      if (typeof init?.body === 'string') pagePayloads.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `page_${pagePayloads.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));
  global.fetch = originalFetch;

  const taskPages = pagePayloads.filter((payload) => payload.properties?.['Record Type']?.select?.name === 'Task');
  assert.equal(taskPages.length, 1);
  assert.equal(taskPages[0].properties.Name.title[0].text.content, '私タスク1');
});

test('summary generation failure still persists transcript in callback path', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv, { OPENAI_API_KEY: 'test' });
  const job = createRecordingJob({ request: { fileName: 'summary-fail.m4a' }, dropboxFileId: 'id:summary-fail', dropboxPathLower: '/apps/meetingmemo/inbox/summary-fail.m4a', fileName: 'summary-fail.m4a' });
  await upsertRecordingJob(env, job);

  const originalFetch = global.fetch;
  const pagePayloads: any[] = [];
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/responses')) {
      return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '{broken-json' }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/databases/') && url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/pages')) {
      if (typeof init?.body === 'string') pagePayloads.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const result = await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));
  global.fetch = originalFetch;

  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(result.action, 'processed');
  assert.equal(updated?.status, 'persisted');
  assert.match(updated?.errorMessage ?? '', /Summary response parse failed/);
  const rawJsonContent = pagePayloads[0]?.properties?.['Raw JSON']?.rich_text?.[0]?.text?.content ?? '';
  assert.ok(pagePayloads[0]?.properties?.['Error Message']?.rich_text?.[0]?.text?.content.includes('Summary response parse failed'));
  assert.ok(rawJsonContent.includes('"summaryErrorMessage"'));
});

test('callback returns partial success when status update fails after Notion persistence', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv, { OPENAI_API_KEY: 'test' });
  const job = createRecordingJob({ request: { fileName: 'status-fail.m4a' }, dropboxFileId: 'id:status-fail', dropboxPathLower: '/apps/meetingmemo/inbox/status-fail.m4a', fileName: 'status-fail.m4a' });
  await upsertRecordingJob(env, job);

  const originalFetch = global.fetch;
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/responses')) return new Response(JSON.stringify({ output_text: JSON.stringify({ summary: 'ok', myTasks: [], otherTasks: [], ambiguities: [] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/databases/') && url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/pages')) return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  let updates = 0;
  const originalPut = kv.put.bind(kv);
  kv.put = async (key: string, value: string) => {
    if (key === `recordingJob:recordingId:${job.recordingId}`) {
      const parsed = JSON.parse(value);
      if (parsed.status === 'persisted') {
        updates += 1;
        if (updates >= 1) throw new Error('kv persisted write failed');
      }
    }
    await originalPut(key, value);
  };

  const result = await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));
  global.fetch = originalFetch;

  assert.equal(result.action, 'processed');
  assert.match(result.reason, /status update failed after Notion persistence/);
  assert.equal(result.pageId, 'page_1');
});

test('gmail send failure does not fail callback persistence', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv, {
    OPENAI_API_KEY: 'test',
    GMAIL_NOTIFY_ENABLED: 'true',
    GMAIL_TO: 'to@example.com',
    GMAIL_FROM: 'from@example.com',
    GMAIL_OAUTH_CLIENT_ID: 'cid',
    GMAIL_OAUTH_CLIENT_SECRET: 'secret',
    GMAIL_OAUTH_REFRESH_TOKEN: 'refresh',
  });
  const job = createRecordingJob({ request: { fileName: 'gmail-fail.m4a' }, dropboxFileId: 'id:gmail-fail', dropboxPathLower: '/apps/meetingmemo/inbox/gmail-fail.m4a', fileName: 'gmail-fail.m4a' });
  await upsertRecordingJob(env, job);

  const originalFetch = global.fetch;
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/responses')) return new Response(JSON.stringify({ output_text: JSON.stringify({ summary: 'ok', myTasks: ['task a'], otherTasks: ['other'], ambiguities: [] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/databases/') && url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/pages')) return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/gmail/v1/users/me/messages/send')) return new Response(JSON.stringify({ error: 'send failed' }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const result = await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));
  global.fetch = originalFetch;

  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(result.action, 'processed');
  assert.equal(updated?.status, 'persisted');
});

test('upsert uses persistent KV abstraction for writes', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv);
  const job = createRecordingJob({ request: { fileName: 'e.m4a' }, dropboxFileId: 'id:5', dropboxPathLower: '/apps/meetingmemo/inbox/e.m4a', fileName: 'e.m4a' });
  await upsertRecordingJob(env, job);

  assert.ok(kv.puts.some((key) => key.startsWith('recordingJob:recordingId:')));
  assert.ok(kv.puts.some((key) => key.startsWith('recordingJob:index:dropboxFileId:')));
  assert.ok(kv.puts.some((key) => key.startsWith('recordingJob:index:dropboxPathLower:')));
});

test('dropboxPathLower normalization is consistent across upload/save/lookup', async () => {
  const kv = new MockKv();
  const env = makeEnv(kv);
  const rawPath = ' /Apps/MeetingMemo/Inbox/Normalize.M4A ';
  const job = createRecordingJob({ request: { fileName: 'normalize.m4a' }, dropboxFileId: 'id:norm', dropboxPathLower: rawPath, fileName: 'normalize.m4a' });
  await upsertRecordingJob(env, job);

  const found = await getRecordingJob(env, { dropboxPathLower: '/apps/meetingmemo/inbox/normalize.m4a' });

  assert.equal(normalizeDropboxPath(rawPath), '/apps/meetingmemo/inbox/normalize.m4a');
  assert.equal(found?.dropboxPathLower, '/apps/meetingmemo/inbox/normalize.m4a');
});

test('upload flow persists job before transcription dispatch path is invoked', async () => {
  const indexSource = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8');
  const upsertIndex = indexSource.indexOf('await upsertRecordingJob(env, seededJob)');
  const processIndex = indexSource.indexOf('await processUploadedInterview(env, requestWithDropbox, metadata, job, { dryRun })');
  assert.notEqual(upsertIndex, -1);
  assert.notEqual(processIndex, -1);
  assert.ok(upsertIndex < processIndex);
});
