// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { HttpError } from '../src/lib/http';
import { createRecordingJob, getRecordingJob, upsertRecordingJob } from '../src/lib/jobs';

function createSeededJob() {
  return createRecordingJob({
    request: { fileName: 'storage-test.m4a' },
    dropboxFileId: 'id:storage',
    dropboxPathLower: '/apps/meetingmemo/inbox/storage-test.m4a',
    fileName: 'storage-test.m4a',
  });
}

test('RECORDING_JOB_KV missing and fallback disabled returns explicit 500', async () => {
  const env = {
    APP_ENV: 'production',
  } as any;

  await assert.rejects(
    () => upsertRecordingJob(env, createSeededJob()),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 500);
      assert.match(error.message, /RECORDING_JOB_KV binding is required/);
      assert.equal((error.details as any).storageModeDecision, 'kv_missing_and_fallback_disabled');
      return true;
    },
  );
});

test('in-memory fallback store is enabled only by explicit test flag', async () => {
  const env = {
    APP_ENV: 'production',
    ALLOW_IN_MEMORY_RECORDING_JOB_STORE: 'true',
  } as any;

  const stored = await upsertRecordingJob(env, createSeededJob());
  const found = await getRecordingJob(env, { recordingId: stored.job.recordingId });
  assert.equal(stored.created, true);
  assert.equal(found?.recordingId, stored.job.recordingId);
});
