// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildCompletionEmailMessage,
  downloadTranscriptAttachment,
} from '../src/lib/gmail';

test('completion email attaches UTF-8 transcript as base64 text file', () => {
  const transcriptText = 'recordingId: rec-1\n\nfull transcript text:\n日本語の文字起こし全文です。';
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl: 'https://www.notion.so/example',
    transcriptFileUrl: 'https://www.dropbox.com/scl/fi/id/sample-transcript.txt?dl=0',
    transcriptAttachment: {
      fileName: 'sample-transcript.txt',
      content: transcriptText,
    },
    finalMemo: 'memo',
    sourceUrls: [],
    myTasks: [],
  });

  assert.ok(message.includes('Content-Type: multipart/mixed; boundary='));
  assert.ok(message.includes('Content-Type: text/html; charset=UTF-8'));
  assert.ok(message.includes('Content-Type: text/plain; charset=UTF-8; name="sample-transcript.txt"'));
  assert.ok(message.includes('Content-Disposition: attachment; filename="sample-transcript.txt"'));
  assert.ok(message.includes('Transcript全文リンク'));

  const attachmentPart = message.split('Content-Transfer-Encoding: base64\r\n')[1];
  assert.ok(attachmentPart);
  const encoded = attachmentPart.split('\r\n--')[0].replace(/\r\n/g, '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), transcriptText);
});

test('completion email stays html-only when attachment is unavailable', () => {
  const message = buildCompletionEmailMessage({
    to: ['to@example.com'],
    from: 'from@example.com',
    subject: 'Interview completed',
    notionPageUrl: 'https://www.notion.so/example',
    transcriptFileUrl: 'https://dropbox.example.com/transcript.txt',
    finalMemo: 'memo',
    sourceUrls: [],
    myTasks: [],
  });

  assert.ok(message.includes('Content-Type: text/html; charset=UTF-8'));
  assert.equal(message.includes('Content-Type: multipart/mixed'), false);
  assert.ok(message.includes('Transcript全文リンク'));
});

test('Dropbox transcript download switches shared link to direct download', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (input: string) => {
    requestedUrl = String(input);
    return new Response('full transcript text', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }) as any;

  try {
    const attachment = await downloadTranscriptAttachment(
      'https://www.dropbox.com/scl/fi/id/meeting-transcript.txt?rlkey=abc&dl=0',
    );
    assert.equal(attachment.fileName, 'meeting-transcript.txt');
    assert.equal(attachment.content, 'full transcript text');
    assert.match(requestedUrl, /[?&]dl=1(?:&|$)/);
    assert.equal(requestedUrl.includes('dl=0'), false);
  } finally {
    global.fetch = originalFetch;
  }
});
