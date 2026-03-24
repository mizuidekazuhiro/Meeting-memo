// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { createRecordingJob } from '../src/lib/jobs';
import { dispatchLongAudioJob } from '../src/lib/processing';

const metadata = {
  id: 'id:abc',
  name: 'meeting.m4a',
  path_lower: '/apps/meetingmemo/inbox/meeting.m4a',
  size: 123,
};

test('PYTHON_TRANSCRIBE_API_URL 未設定時に明確なエラーを返す', async () => {
  const job = createRecordingJob({
    request: { fileName: 'meeting.m4a' },
    dropboxFileId: 'id:abc',
    dropboxPathLower: '/apps/meetingmemo/inbox/meeting.m4a',
    fileName: 'meeting.m4a',
  });

  await assert.rejects(
    () => dispatchLongAudioJob({} as any, job, metadata as any),
    /Set PYTHON_TRANSCRIBE_API_URL to the base URL of the Python service/,
  );
});
