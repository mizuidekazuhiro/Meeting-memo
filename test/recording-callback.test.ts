// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

async function importFirst(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch {
      // try next
    }
  }
  throw new Error(`Unable to import module from candidates: ${candidates.join(', ')}`);
}

async function loadDeps() {
  const workerMod = await importFirst(['../src/index.js', '../.tmp-test/src/index.js']);
  const httpMod = await importFirst(['../src/lib/http.js', '../.tmp-test/src/lib/http.js']);
  const jobsMod = await importFirst(['../src/lib/jobs.js', '../.tmp-test/src/lib/jobs.js']);
  const processingMod = await importFirst(['../src/lib/processing.js', '../.tmp-test/src/lib/processing.js']);
  const loggerMod = await importFirst(['../src/lib/logger.js', '../.tmp-test/src/lib/logger.js']);
  const gmailMod = await importFirst(['../src/lib/gmail.js', '../.tmp-test/src/lib/gmail.js']);
  const notionMod = await importFirst(['../src/lib/notion.js', '../.tmp-test/src/lib/notion.js']);
  return { workerMod, httpMod, jobsMod, processingMod, loggerMod, gmailMod, notionMod };
}

class MockKv {
  map = new Map<string, string>();

  async get(key: string, type?: 'text' | 'json') {
    const value = this.map.get(key);
    if (value === undefined) return null;
    if (type === 'json') return JSON.parse(value);
    return value;
  }

  async put(key: string, value: string) {
    this.map.set(key, value);
  }
}

function makeEnv(kv: MockKv, overrides: Record<string, unknown> = {}) {
  return {
    APP_ENV: 'test',
    INTERVIEW_WEBHOOK_SECRET: 'secret',
    NOTION_TOKEN: 'token',
    INBOX_DB_ID: 'db',
    OPENAI_API_KEY: 'openai-test',
    INTERVIEW_REVIEW_ENABLED: 'false',
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

function installFinalizeFetchMock() {
  const originalFetch = global.fetch;
  const stats = {
    notionTranscriptAppendCalls: 0,
    notionPageCreateCalls: 0,
    notionPagePatchCalls: 0,
    summaryCalls: 0,
    summaryPayloads: [] as any[],
    reviewCalls: 0,
    createdInboxTaskTitles: [] as string[],
  };
  const inboxPagesByDedupKey = new Map<string, string>();
  let nextInboxPageId = 1;

  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/responses')) {
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const formatName = parsedBody?.text?.format?.name;
      if (formatName === 'interview_insights') {
        stats.summaryCalls += 1;
        return new Response(
          JSON.stringify({ output_text: JSON.stringify({ summary: '要約です', myTasks: ['task1'], otherTasks: ['task2'], ambiguities: [] }) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      stats.reviewCalls += 1;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            finalMemoMarkdown: 'final memo',
            correctedTermsMarkdown: '',
            summaryForEmail: 'email summary',
            uncertainItemsMarkdown: '',
            nextActionsMarkdown: '- review-next-action',
            humanCheckRequired: false,
            humanCheckReason: '',
            myTasks: ['review-task-1', 'review-task-2'],
            otherTasks: [],
            sourceUrls: [],
          }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/databases/db') && init?.method === 'GET') {
      return new Response(JSON.stringify({
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
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/databases/') && url.endsWith('/query')) {
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const dedupKey = parsedBody?.filter?.property === 'Dedup Key'
        ? parsedBody?.filter?.rich_text?.equals
        : parsedBody?.filter?.and?.find?.((item: any) => item?.property === 'Dedup Key')?.rich_text?.equals;
      if (typeof dedupKey === 'string' && inboxPagesByDedupKey.has(dedupKey)) {
        return new Response(JSON.stringify({ results: [{ id: inboxPagesByDedupKey.get(dedupKey) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/pages') && init?.method === 'POST') {
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      stats.notionPageCreateCalls += 1;
      const isInboxTask = parsedBody?.parent?.database_id === 'db' && parsedBody?.properties?.['Record Type']?.select?.name === 'Task';
      if (isInboxTask) {
        const taskTitle = parsedBody?.properties?.Name?.title?.[0]?.text?.content ?? '';
        const dedupKey = parsedBody?.properties?.['Dedup Key']?.rich_text?.[0]?.text?.content;
        const pageId = `inbox_${nextInboxPageId++}`;
        if (typeof taskTitle === 'string' && taskTitle) stats.createdInboxTaskTitles.push(taskTitle);
        if (typeof dedupKey === 'string' && dedupKey) inboxPagesByDedupKey.set(dedupKey, pageId);
        return new Response(JSON.stringify({ id: pageId }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/pages/') && init?.method === 'PATCH') {
      stats.notionPagePatchCalls += 1;
      if (typeof init?.body === 'string') stats.summaryPayloads.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') {
      stats.notionTranscriptAppendCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/children?')) return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  return { stats, restore: () => { global.fetch = originalFetch; } };
}

test('callback endpoint returns 202, stores callback state, and schedules finalize via waitUntil', async () => {
  const { workerMod, jobsMod, processingMod, loggerMod } = await loadDeps();
  const worker = workerMod.default;
  const { createRecordingJob, upsertRecordingJob, getRecordingJob } = jobsMod;

  const kv = new MockKv();
  const env = makeEnv(kv);
  const job = createRecordingJob({ request: { fileName: 'a.m4a' }, dropboxFileId: 'id:1', dropboxPathLower: '/apps/meetingmemo/inbox/a.m4a', fileName: 'a.m4a' });
  await upsertRecordingJob(env, job);

  const waitUntilPromises: Promise<unknown>[] = [];
  const calls: string[] = [];
  const originalFinalize = processingMod.finalizeInterviewJob;
  const originalLogEvent = loggerMod.logEvent;
  processingMod.finalizeInterviewJob = async () => {
    calls.push('finalize-called');
    return { ok: true, status: 'completed' };
  };
  loggerMod.logEvent = ((_: string, message: string) => calls.push(message)) as any;

  const request = new Request('https://example.com/api/interviews/transcription-callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': env.INTERVIEW_WEBHOOK_SECRET },
    body: JSON.stringify(transcriptPayload({ recordingId: job.recordingId, dropboxFileId: job.dropboxFileId, dropboxPathLower: job.dropboxPathLower })),
  });
  const response = await worker.fetch(request, env, { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) });
  await Promise.all(waitUntilPromises);

  processingMod.finalizeInterviewJob = originalFinalize;
  loggerMod.logEvent = originalLogEvent;

  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(response.status, 202);
  assert.equal(updated?.status, 'callback_received');
  assert.equal(updated?.callbackStatus, 'received');
  assert.equal(waitUntilPromises.length, 1);
  assert.ok(calls.includes('callback_ack_returned'));
  assert.ok(calls.includes('finalize-called'));
});

test('callback persistence path stores transcript payload and remains lightweight', async () => {
  const { jobsMod, processingMod } = await loadDeps();
  const { createRecordingJob, upsertRecordingJob, getRecordingJob } = jobsMod;
  const { persistTranscriptionCallback } = processingMod;

  const kv = new MockKv();
  const env = makeEnv(kv);
  const job = createRecordingJob({ request: { fileName: 'b.m4a' }, dropboxFileId: 'id:2', dropboxPathLower: '/apps/meetingmemo/inbox/b.m4a', fileName: 'b.m4a' });
  await upsertRecordingJob(env, job);

  const result = await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));
  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(result.action, 'processed');
  assert.equal(updated?.status, 'callback_received');
  assert.equal(updated?.transcript?.fullText, 'hello world');
  assert.equal(updated?.finalizeStatus, 'pending');
});

test('finalizeInterviewJob executes transcript -> summary -> email and marks completed', async () => {
  const { jobsMod, processingMod, gmailMod } = await loadDeps();
  const { createRecordingJob, upsertRecordingJob, getRecordingJob } = jobsMod;
  const { persistTranscriptionCallback, finalizeInterviewJob } = processingMod;

  const kv = new MockKv();
  const env = makeEnv(kv, { GMAIL_NOTIFY_ENABLED: 'true', MAIL_TO: 'to@example.com', MAIL_FROM: 'from@example.com', MAIL_PASSWORD: 'password', INTERVIEW_REVIEW_ENABLED: 'true' });
  const job = createRecordingJob({ request: { fileName: 'finalize.m4a' }, dropboxFileId: 'id:3', dropboxPathLower: '/apps/meetingmemo/inbox/finalize.m4a', fileName: 'finalize.m4a' });
  await upsertRecordingJob(env, job);
  await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));

  const fetchMock = installFinalizeFetchMock();
  const emailCalls: any[] = [];
  const originalSendEmail = gmailMod.sendCompletionEmail;
  gmailMod.sendCompletionEmail = (async (_env: any, payload: any) => emailCalls.push(payload)) as any;

  await finalizeInterviewJob(env, job.recordingId);

  gmailMod.sendCompletionEmail = originalSendEmail;
  fetchMock.restore();

  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(updated?.status, 'completed');
  assert.equal(updated?.finalizeStatus, 'completed');
  assert.ok(updated?.transcriptWrittenAt);
  assert.ok(updated?.summaryWrittenAt);
  assert.ok(updated?.emailSentAt);
  assert.ok(fetchMock.stats.notionTranscriptAppendCalls >= 1);
  assert.ok(fetchMock.stats.summaryCalls >= 1);
  assert.ok(fetchMock.stats.reviewCalls >= 1);
  assert.ok(fetchMock.stats.notionPagePatchCalls >= 1);
  assert.equal(emailCalls.length, 1);
  assert.deepEqual(fetchMock.stats.createdInboxTaskTitles, ['review-task-1', 'review-task-2']);
});

test('finalize resumes from partial state and skips transcript append when transcriptWrittenAt exists', async () => {
  const { jobsMod, processingMod, gmailMod } = await loadDeps();
  const { createRecordingJob, upsertRecordingJob, getRecordingJob } = jobsMod;
  const { persistTranscriptionCallback, finalizeInterviewJob } = processingMod;

  const kv = new MockKv();
  const env = makeEnv(kv, { GMAIL_NOTIFY_ENABLED: 'true', MAIL_TO: 'to@example.com', MAIL_FROM: 'from@example.com', MAIL_PASSWORD: 'password' });
  const job = createRecordingJob({ request: { fileName: 'resume.m4a' }, dropboxFileId: 'id:4', dropboxPathLower: '/apps/meetingmemo/inbox/resume.m4a', fileName: 'resume.m4a' });
  await upsertRecordingJob(env, job);
  await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));
  await upsertRecordingJob(env, {
    ...(await getRecordingJob(env, { recordingId: job.recordingId }))!,
    transcriptWrittenAt: new Date().toISOString(),
    notionPageId: 'page_existing',
    notionPageUrl: 'https://www.notion.so/pageexisting',
  } as any);

  const fetchMock = installFinalizeFetchMock();
  let emailCount = 0;
  const originalSendEmail = gmailMod.sendCompletionEmail;
  gmailMod.sendCompletionEmail = (async () => {
    emailCount += 1;
  }) as any;

  await finalizeInterviewJob(env, job.recordingId);

  gmailMod.sendCompletionEmail = originalSendEmail;
  fetchMock.restore();

  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(fetchMock.stats.notionTranscriptAppendCalls, 0);
  assert.ok(fetchMock.stats.summaryCalls >= 1);
  assert.equal(emailCount, 1);
  assert.equal(updated?.status, 'completed');
});

test('finalize idempotency skips duplicate heavy work unless force=true', async () => {
  const { jobsMod, processingMod, gmailMod } = await loadDeps();
  const { createRecordingJob, upsertRecordingJob } = jobsMod;
  const { persistTranscriptionCallback, finalizeInterviewJob } = processingMod;

  const kv = new MockKv();
  const env = makeEnv(kv, { GMAIL_NOTIFY_ENABLED: 'true', MAIL_TO: 'to@example.com', MAIL_FROM: 'from@example.com', MAIL_PASSWORD: 'password', INTERVIEW_REVIEW_ENABLED: 'true' });
  const job = createRecordingJob({ request: { fileName: 'idempotent.m4a' }, dropboxFileId: 'id:5', dropboxPathLower: '/apps/meetingmemo/inbox/idempotent.m4a', fileName: 'idempotent.m4a' });
  await upsertRecordingJob(env, job);
  await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));

  const fetchMock = installFinalizeFetchMock();
  let emailCount = 0;
  const originalSendEmail = gmailMod.sendCompletionEmail;
  gmailMod.sendCompletionEmail = (async () => {
    emailCount += 1;
  }) as any;

  await finalizeInterviewJob(env, job.recordingId);
  const first = { notion: fetchMock.stats.notionTranscriptAppendCalls, summary: fetchMock.stats.summaryCalls, email: emailCount };
  await finalizeInterviewJob(env, job.recordingId);
  assert.equal(fetchMock.stats.notionTranscriptAppendCalls, first.notion);
  assert.equal(fetchMock.stats.summaryCalls, first.summary);
  assert.equal(emailCount, first.email);

  await finalizeInterviewJob(env, job.recordingId, { force: true });
  assert.ok(fetchMock.stats.notionTranscriptAppendCalls > first.notion);
  assert.ok(fetchMock.stats.summaryCalls > first.summary);
  assert.ok(emailCount > first.email);
  assert.equal(fetchMock.stats.createdInboxTaskTitles.filter((task) => task === 'review-task-1').length, 1);
  assert.equal(fetchMock.stats.createdInboxTaskTitles.filter((task) => task === 'review-task-2').length, 1);

  gmailMod.sendCompletionEmail = originalSendEmail;
  fetchMock.restore();
});

test('finalizeInterviewJob uses review.nextActionsMarkdown when review.myTasks is empty', async () => {
  const { jobsMod, processingMod, gmailMod } = await loadDeps();
  const { createRecordingJob, upsertRecordingJob } = jobsMod;
  const { persistTranscriptionCallback, finalizeInterviewJob } = processingMod;

  const kv = new MockKv();
  const env = makeEnv(kv, { GMAIL_NOTIFY_ENABLED: 'true', MAIL_TO: 'to@example.com', MAIL_FROM: 'from@example.com', MAIL_PASSWORD: 'password', INTERVIEW_REVIEW_ENABLED: 'true' });
  const job = createRecordingJob({ request: { fileName: 'review-next-actions.m4a' }, dropboxFileId: 'id:6', dropboxPathLower: '/apps/meetingmemo/inbox/review-next-actions.m4a', fileName: 'review-next-actions.m4a' });
  await upsertRecordingJob(env, job);
  await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));

  const originalFetch = global.fetch;
  const createdInboxTaskTitles: string[] = [];
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/responses')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const formatName = body?.text?.format?.name;
      if (formatName === 'interview_insights') {
        return new Response(JSON.stringify({ output_text: JSON.stringify({ summary: '要約です', myTasks: ['primary-task'], otherTasks: [], ambiguities: [] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          finalMemoMarkdown: 'final',
          correctedTermsMarkdown: '',
          summaryForEmail: '',
          uncertainItemsMarkdown: '',
          nextActionsMarkdown: '- fallback-from-next-actions',
          humanCheckRequired: false,
          humanCheckReason: '',
          myTasks: [],
          otherTasks: [],
          sourceUrls: [],
        }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/databases/db') && init?.method === 'GET') {
      return new Response(JSON.stringify({
        properties: { Name: {}, Source: {}, 'Record Type': {}, 'Source Recording ID': {}, 'Source Interview Page ID': {}, 'Source Interview URL': {}, 'Imported At': {}, 'Dedup Key': {} },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/databases/') && url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/pages') && init?.method === 'POST') {
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const isInboxTask = parsedBody?.properties?.['Record Type']?.select?.name === 'Task';
      if (isInboxTask) {
        createdInboxTaskTitles.push(parsedBody?.properties?.Name?.title?.[0]?.text?.content ?? '');
        return new Response(JSON.stringify({ id: `inbox_${createdInboxTaskTitles.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/pages/') && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/blocks/') && url.endsWith('/children') && init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/children?')) return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const originalSendEmail = gmailMod.sendCompletionEmail;
  gmailMod.sendCompletionEmail = (async () => undefined) as any;
  await finalizeInterviewJob(env, job.recordingId);
  gmailMod.sendCompletionEmail = originalSendEmail;
  global.fetch = originalFetch;

  assert.deepEqual(createdInboxTaskTitles, ['fallback-from-next-actions']);
});

test('finalizeInterviewJob continues when final my task import fails', async () => {
  const { jobsMod, processingMod, gmailMod } = await loadDeps();
  const { createRecordingJob, upsertRecordingJob, getRecordingJob } = jobsMod;
  const { persistTranscriptionCallback, finalizeInterviewJob } = processingMod;

  const kv = new MockKv();
  const env = makeEnv(kv, { GMAIL_NOTIFY_ENABLED: 'true', MAIL_TO: 'to@example.com', MAIL_FROM: 'from@example.com', MAIL_PASSWORD: 'password', INTERVIEW_REVIEW_ENABLED: 'true' });
  const job = createRecordingJob({ request: { fileName: 'import-fail.m4a' }, dropboxFileId: 'id:7', dropboxPathLower: '/apps/meetingmemo/inbox/import-fail.m4a', fileName: 'import-fail.m4a' });
  await upsertRecordingJob(env, job);
  await persistTranscriptionCallback(env, transcriptPayload({ recordingId: job.recordingId }));

  const fetchMock = installFinalizeFetchMock();
  const originalFetch = global.fetch;
  global.fetch = (async (input: string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/databases/db') && init?.method === 'GET') {
      return new Response(JSON.stringify({ message: 'simulated failure' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input as any, init);
  }) as any;
  const originalSendEmail = gmailMod.sendCompletionEmail;
  gmailMod.sendCompletionEmail = (async () => undefined) as any;

  await finalizeInterviewJob(env, job.recordingId);

  global.fetch = originalFetch;
  gmailMod.sendCompletionEmail = originalSendEmail;
  fetchMock.restore();

  const updated = await getRecordingJob(env, { recordingId: job.recordingId });
  assert.equal(updated?.status, 'completed');
  assert.equal(updated?.finalizeStatus, 'completed');
});

test('callback not found still returns lookup error', async () => {
  const { processingMod, httpMod } = await loadDeps();
  const { persistTranscriptionCallback } = processingMod;
  const { HttpError } = httpMod;

  const kv = new MockKv();
  const env = makeEnv(kv);
  await assert.rejects(
    () => persistTranscriptionCallback(env, transcriptPayload({ recordingId: 'missing', dropboxFileId: 'missing', dropboxPathLower: '/missing' })),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      assert.equal((error.details as any).phase, 'lookup_job');
      return true;
    },
  );
});
