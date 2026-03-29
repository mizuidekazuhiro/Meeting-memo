// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Blob } from 'node:buffer';

import { createChunkPlan, validateChunk, transcribeWithDiarization, buildChunkLogMeta, summarizeInterview } from '../src/lib/openai';
import { HttpError } from '../src/lib/http';

const env = { OPENAI_API_KEY: 'test' } as any;

function makeTestWav(durationSec: number, sampleRate = 1, channels = 1): Blob {
  const frames = durationSec * sampleRate * channels;
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, dataBytes, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

test('sourceDurationSec below threshold does not split', () => {
  const plan = createChunkPlan(600, 1024);
  assert.equal(plan.requiresSplit, false);
  assert.equal(plan.entries.length, 1);
});

test('sourceDurationSec above threshold creates multiple chunks', () => {
  const plan = createChunkPlan(1800, 1024);
  assert.equal(plan.requiresSplit, true);
  assert.equal(plan.entries.length, 3);
});

test('chunk plan start/end offsets are ordered correctly', () => {
  const plan = createChunkPlan(1800, 1024);
  assert.deepEqual(plan.entries.map(({ startOffsetMs, endOffsetMs }) => [startOffsetMs, endOffsetMs]), [
    [0, 600000],
    [600000, 1200000],
    [1200000, 1800000],
  ]);
});

test('invalid empty chunk is rejected by validation', () => {
  const chunk = validateChunk({
    blob: new Blob([]), fileName: 'a.part-001.wav', extension: '.wav', mimeType: 'audio/wav', bytes: 0,
    codec: 'pcm_s16le', container: 'wav', estimatedDurationSec: 0, actualDurationSec: 0,
    strategy: 'fallback-pcm-wav', validationPassed: false, validationErrors: [], chunkIndex: 0, chunkCount: 1, startOffsetMs: 0, endOffsetMs: 0,
  });
  assert.equal(chunk.validationPassed, false);
  assert.ok(chunk.validationErrors.length >= 2);
});

test('m4a failure triggers one wav fallback and succeeds', async () => {
  const calls: string[] = [];
  const source = makeTestWav(1440);
  const result = await transcribeWithDiarization(env, source, 'meeting.wav', undefined, {
    chunkGenerator: async (_source, _meta, plan, options) => ({
      blob: new Blob([new Uint8Array([1,2,3])], { type: options.preferredFormat === 'm4a' ? 'audio/mp4' : 'audio/wav' }),
      fileName: options.preferredFormat === 'm4a' ? `meeting.part-${plan.chunkIndex + 1}.m4a` : `meeting.part-${plan.chunkIndex + 1}.wav`,
      extension: options.preferredFormat === 'm4a' ? '.m4a' : '.wav',
      mimeType: options.preferredFormat === 'm4a' ? 'audio/mp4' : 'audio/wav',
      bytes: 3,
      codec: options.preferredFormat === 'm4a' ? 'aac-lc' : 'pcm_s16le',
      container: options.preferredFormat === 'm4a' ? 'm4a' : 'wav',
      sampleRate: 16000,
      channels: 1,
      estimatedDurationSec: 720,
      actualDurationSec: 720,
      strategy: options.preferredFormat === 'm4a' ? 'reencoded-aac-m4a' : 'fallback-pcm-wav',
      validationPassed: false,
      validationErrors: [],
      chunkIndex: plan.chunkIndex,
      chunkCount: plan.chunkCount,
      startOffsetMs: plan.startOffsetMs,
      endOffsetMs: plan.endOffsetMs,
    }),
    uploadChunk: async (_env, chunk) => {
      calls.push(chunk.extension);
      if (calls.length === 1) throw new HttpError('OpenAI transcription request failed.', 502, { responseStatus: 400, responseText: 'Audio file might be corrupted or unsupported', param: 'file' });
      return { fullText: 'ok', segments: [{ speaker: 'spk1', startMs: 0, endMs: 1000, text: 'ok' }], raw: { ok: true } };
    },
  });
  assert.deepEqual(calls.slice(0, 2), ['.m4a', '.wav']);
  assert.equal(result.fullText, 'ok\n\nok');
});

test('fallback runs only once and surfaces final error', async () => {
  const source = makeTestWav(1440);
  await assert.rejects(
    transcribeWithDiarization(env, source, 'meeting.wav', undefined, {
      chunkGenerator: async (_source, _meta, plan, options) => ({
        blob: new Blob([new Uint8Array([1,2,3])]), fileName: `meeting.part-${plan.chunkIndex + 1}${options.preferredFormat === 'm4a' ? '.m4a' : '.wav'}`,
        extension: options.preferredFormat === 'm4a' ? '.m4a' : '.wav', mimeType: options.preferredFormat === 'm4a' ? 'audio/mp4' : 'audio/wav', bytes: 3,
        codec: options.preferredFormat === 'm4a' ? 'aac-lc' : 'pcm_s16le', container: options.preferredFormat === 'm4a' ? 'm4a' : 'wav', sampleRate: 16000, channels: 1,
        estimatedDurationSec: 720, actualDurationSec: 720, strategy: options.preferredFormat === 'm4a' ? 'reencoded-aac-m4a' : 'fallback-pcm-wav',
        validationPassed: false, validationErrors: [], chunkIndex: plan.chunkIndex, chunkCount: plan.chunkCount, startOffsetMs: plan.startOffsetMs, endOffsetMs: plan.endOffsetMs,
      }),
      uploadChunk: async () => { throw new HttpError('OpenAI transcription request failed.', 502, { responseStatus: 400, responseText: 'Audio file might be corrupted or unsupported', param: 'file' }); },
    }),
    /Transcription request failed/,
  );
});

test('log metadata contains required fields', () => {
  const meta = buildChunkLogMeta({ fileName: 'meeting.wav', extension: '.wav', mimeType: 'audio/wav', bytes: 100, container: 'wav', codec: 'pcm_s16le', durationSec: 12, sampleRate: 16000, channels: 1 }, {
    blob: new Blob([new Uint8Array([1])]), fileName: 'meeting.part-001.wav', extension: '.wav', mimeType: 'audio/wav', bytes: 1, codec: 'pcm_s16le', container: 'wav', sampleRate: 16000, channels: 1,
    estimatedDurationSec: 12, actualDurationSec: 12, strategy: 'fallback-pcm-wav', validationPassed: true, validationErrors: [], chunkIndex: 0, chunkCount: 1, startOffsetMs: 0, endOffsetMs: 12000,
  });
  for (const key of ['sourceFileName','sourceDurationSec','sourceBytes','chunkIndex','chunkCount','startOffsetMs','estimatedDurationSec','bytes','extension','mimeType','codec','container','sampleRate','channels','strategy','validationPassed']) {
    assert.ok(key in meta, `missing ${key}`);
  }
});

test('summarizeInterview accepts payload.output_text', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    output_text: JSON.stringify({ summary: '要約A', myTasks: ['A'], otherTasks: ['B'], ambiguities: [] }),
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

  const result = await summarizeInterview(env, { fullText: 'text', segments: [], raw: { source: true } });
  global.fetch = originalFetch;

  assert.equal(result.summary, '要約A');
  assert.deepEqual(result.myTasks, ['A']);
});

test('summarizeInterview accepts payload.output[].content[].text', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: '要約B', myTasks: ['C'], otherTasks: ['D'], ambiguities: [] }) }] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

  const result = await summarizeInterview(env, { fullText: 'text', segments: [], raw: { source: true } });
  global.fetch = originalFetch;

  assert.equal(result.summary, '要約B');
  assert.deepEqual(result.otherTasks, ['D']);
});

test('summarizeInterview throws parse error when summary json is invalid', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    output: [{ content: [{ type: 'output_text', text: '{broken-json' }] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

  await assert.rejects(
    summarizeInterview(env, { fullText: 'text', segments: [], raw: { source: true } }),
    /Summary response parse failed/,
  );
  global.fetch = originalFetch;
});
