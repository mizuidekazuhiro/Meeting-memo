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
  global.fetch = (async (input: string, init?: RequestInit) => {
    calls += 1;
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/databases/') && url.endsWith('/query')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/pages')) {
      return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return {
    getCalls: () => calls,
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
