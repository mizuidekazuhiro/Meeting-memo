// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { createRecordingJob, getRecordingJob, upsertRecordingJob } from '../src/lib/jobs';
import { mergeTranscriptResultsInOrder } from '../src/lib/cloud-run-plan';
import { shouldAttemptDirectWorkerTranscription } from '../src/lib/processing';

const env = {} as any;

test('upload metadata immediately creates a job without Dropbox scan', async () => {
  const seeded = createRecordingJob({
    request: { fileName: 'meeting.m4a', dropboxFileId: 'id:1', dropboxPathLower: '/apps/meetingmemo/inbox/meeting.m4a', fileSizeBytes: 123 },
    dropboxFileId: 'id:1',
    dropboxPathLower: '/apps/meetingmemo/inbox/meeting.m4a',
    fileName: 'meeting.m4a',
    sourceBytes: 123,
    clientModified: '2026-03-22T10:00:00Z',
    serverModified: '2026-03-22T10:01:00Z',
  });
  const stored = await upsertRecordingJob(env, seeded);
  const found = await getRecordingJob(env, { dropboxFileId: 'id:1' });
  assert.equal(stored.created, true);
  assert.equal(found?.dropboxPathLower, '/apps/meetingmemo/inbox/meeting.m4a');
  assert.equal(found?.status, 'uploaded');
});

test('dropboxFileId deduplicates repeated uploads before any scan', async () => {
  const first = createRecordingJob({ request: { fileName: 'dup.m4a' }, dropboxFileId: 'id:dup', fileName: 'dup.m4a' });
  const second = createRecordingJob({ request: { fileName: 'dup-again.m4a' }, dropboxFileId: 'id:dup', fileName: 'dup-again.m4a' });
  const inserted = await upsertRecordingJob(env, first);
  const deduped = await upsertRecordingJob(env, second);
  assert.equal(inserted.created, true);
  assert.equal(deduped.created, false);
  assert.equal(deduped.job.dropboxFileId, 'id:dup');
});

test('short duration files stay in Workers direct path', () => {
  assert.equal(shouldAttemptDirectWorkerTranscription({ name: 'short.wav' }, 120), true);
  assert.equal(shouldAttemptDirectWorkerTranscription({ name: 'short.m4a' }, 1200), true);
});

test('long duration files are delegated away from Workers', () => {
  assert.equal(shouldAttemptDirectWorkerTranscription({ name: 'long.m4a' }, 2707.75), false);
  assert.equal(shouldAttemptDirectWorkerTranscription({ name: 'unknown.m4a' }, undefined), false);
});

test('cloud run transcript merge preserves chunkIndex order and offsets', () => {
  const merged = mergeTranscriptResultsInOrder([
    { chunkIndex: 1, startOffsetMs: 600000, transcript: { fullText: 'second', segments: [{ speaker: 'spk2', startMs: 0, endMs: 1000, text: 'second' }], raw: { idx: 1 } } },
    { chunkIndex: 0, startOffsetMs: 0, transcript: { fullText: 'first', segments: [{ speaker: 'spk1', startMs: 0, endMs: 1000, text: 'first' }], raw: { idx: 0 } } },
  ]);
  assert.equal(merged.fullText, 'first\n\nsecond');
  assert.deepEqual(merged.segments.map((segment) => segment.startMs), [0, 600000]);
});
