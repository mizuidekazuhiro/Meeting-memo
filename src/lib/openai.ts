import type { Env, InterviewInsights, TranscriptResult, TranscriptSegment } from '../types';
import { HttpError } from './http';

const OPENAI_API = 'https://api.openai.com/v1';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe-diarize';
const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
const TARGET_CHUNK_DURATION_SEC = 1200;
const MAX_MODEL_DURATION_SEC = 1400;
const MP4_BOX_HEADER_BYTES = 8;

const textEncoder = new TextEncoder();

type DiarizedSegmentLike = {
  speaker?: string | number;
  speaker_label?: string | number;
  speaker_id?: string | number;
  start?: number;
  end?: number;
  start_ms?: number;
  end_ms?: number;
  startMs?: number;
  endMs?: number;
  text?: string;
};

type OpenAiDiarizedTranscript = {
  text?: string;
  transcript?: string;
  segments?: DiarizedSegmentLike[];
  diarized_segments?: DiarizedSegmentLike[];
};

type Mp4TopLevelBox = { type: string; start: number; end: number };

type TranscriptionChunkStrategy = 'single' | 'blob-slice' | 'mp4-fragmented' | 'mp4-rewrapped';

type TranscriptionChunk = {
  blob: Blob;
  fileName: string;
  strategy: TranscriptionChunkStrategy;
  chunkIndex: number;
  chunkCount: number;
  startOffsetMs: number;
  estimatedDurationSec: number;
};

type ChunkPlan = {
  chunkCount: number;
  targetMaxBytes: number;
  targetDurationSec: number;
  durationSec?: number;
};

function asSpeakerLabel(segment: DiarizedSegmentLike): string {
  const rawSpeaker = segment.speaker ?? segment.speaker_label ?? segment.speaker_id;
  if (rawSpeaker === undefined || rawSpeaker === null || rawSpeaker === '') {
    return 'speaker_unknown';
  }
  return String(rawSpeaker);
}

function toMilliseconds(value: number | undefined, alternateValue?: number): number | undefined {
  const candidate = value ?? alternateValue;
  if (candidate === undefined || Number.isNaN(candidate)) {
    return undefined;
  }
  return candidate >= 1000 ? Math.round(candidate) : Math.round(candidate * 1000);
}

function normalizeSegments(payload: OpenAiDiarizedTranscript): TranscriptSegment[] {
  const segments = payload.diarized_segments ?? payload.segments ?? [];
  return segments
    .map((segment) => ({
      speaker: asSpeakerLabel(segment),
      startMs: toMilliseconds(segment.start_ms, segment.start ?? segment.startMs),
      endMs: toMilliseconds(segment.end_ms, segment.end ?? segment.endMs),
      text: (segment.text ?? '').trim(),
    }))
    .filter((segment) => Boolean(segment.text));
}

function mapTranscriptPayload(payload: OpenAiDiarizedTranscript): TranscriptResult {
  const segments = normalizeSegments(payload);
  const fullText =
    (payload.text ?? payload.transcript ?? '').trim() ||
    segments.map((segment) => `[${segment.speaker}] ${segment.text}`.trim()).join('\n');

  return {
    fullText,
    segments,
    raw: payload,
  };
}

async function readResponseTextSafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return `<<failed to read response body: ${error instanceof Error ? error.message : String(error)}>>`;
  }
}

function extensionForFileName(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index).toLowerCase() : '';
}

function fileNameForChunk(fileName: string, chunkIndex: number): string {
  const extension = extensionForFileName(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${stem}.part-${String(chunkIndex + 1).padStart(3, '0')}${extension || '.bin'}`;
}

function finalizeChunks(chunks: Omit<TranscriptionChunk, 'chunkCount' | 'chunkIndex'>[]): TranscriptionChunk[] {
  return chunks.map((chunk, index, all) => ({
    ...chunk,
    chunkIndex: index,
    chunkCount: all.length,
  }));
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function readMp4TopLevelBoxes(bytes: Uint8Array): Mp4TopLevelBox[] {
  const boxes: Mp4TopLevelBox[] = [];
  let offset = 0;

  while (offset + MP4_BOX_HEADER_BYTES <= bytes.byteLength) {
    const size32 = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    let size = size32;
    let headerSize = MP4_BOX_HEADER_BYTES;

    if (size32 === 1) {
      if (offset + 16 > bytes.byteLength) {
        break;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8);
      const high = view.getUint32(0);
      const low = view.getUint32(4);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size32 === 0) {
      size = bytes.byteLength - offset;
    }

    if (!size || size < headerSize || offset + size > bytes.byteLength) {
      break;
    }

    boxes.push({ type, start: offset, end: offset + size });
    offset += size;
  }

  return boxes;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function findFirstBox(bytes: Uint8Array, path: string[]): Uint8Array | null {
  let current: Uint8Array | null = bytes;
  for (const target of path) {
    if (!current) {
      return null;
    }
    let found: Uint8Array | null = null;
    let offset = 8;
    while (offset + 8 <= current.byteLength) {
      const size = new DataView(current.buffer, current.byteOffset + offset, 4).getUint32(0);
      const type = readAscii(current, offset + 4, 4);
      if (!size || offset + size > current.byteLength) {
        break;
      }
      if (type === target) {
        found = current.slice(offset, offset + size);
        break;
      }
      offset += size;
    }
    current = found;
  }
  return current;
}

function readMp4DurationSeconds(audio: Blob, fileName: string, bytes: Uint8Array): number | undefined {
  const extension = extensionForFileName(fileName);
  if (extension !== '.m4a' && extension !== '.mp4') {
    return undefined;
  }

  const moov = readMp4TopLevelBoxes(bytes).find((box) => box.type === 'moov');
  if (!moov) {
    return undefined;
  }

  const moovBytes = bytes.slice(moov.start, moov.end);
  const mdhd = findFirstBox(moovBytes, ['trak', 'mdia', 'mdhd']);
  if (mdhd && mdhd.byteLength >= 28) {
    const version = mdhd[8];
    const view = new DataView(mdhd.buffer, mdhd.byteOffset, mdhd.byteLength);
    if (version === 1 && mdhd.byteLength >= 44) {
      const timescale = view.getUint32(28);
      const duration = view.getUint32(32) * 2 ** 32 + view.getUint32(36);
      if (timescale > 0 && duration > 0) {
        return duration / timescale;
      }
    }
    if (version === 0 && mdhd.byteLength >= 32) {
      const timescale = view.getUint32(20);
      const duration = view.getUint32(24);
      if (timescale > 0 && duration > 0) {
        return duration / timescale;
      }
    }
  }

  const mvhd = findFirstBox(moovBytes, ['mvhd']);
  if (!mvhd || mvhd.byteLength < 28) {
    return undefined;
  }
  const version = mvhd[8];
  const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
  if (version === 1 && mvhd.byteLength >= 40) {
    const timescale = view.getUint32(28);
    const duration = view.getUint32(32) * 2 ** 32 + view.getUint32(36);
    return timescale > 0 && duration > 0 ? duration / timescale : undefined;
  }
  const timescale = view.getUint32(20);
  const duration = view.getUint32(24);
  return timescale > 0 && duration > 0 ? duration / timescale : undefined;
}

function buildChunkPlan(audio: Blob, durationSec?: number): ChunkPlan {
  const byteDrivenCount = Math.max(1, Math.ceil(audio.size / MAX_TRANSCRIPTION_BYTES));
  const durationDrivenCount = durationSec ? Math.max(1, Math.ceil(durationSec / TARGET_CHUNK_DURATION_SEC)) : 1;
  const chunkCount = Math.max(byteDrivenCount, durationDrivenCount);
  const targetMaxBytes = Math.min(MAX_TRANSCRIPTION_BYTES, Math.ceil(audio.size / chunkCount));
  const targetDurationSec = durationSec ? Math.min(TARGET_CHUNK_DURATION_SEC, durationSec / chunkCount) : TARGET_CHUNK_DURATION_SEC;

  return {
    chunkCount,
    targetMaxBytes: Math.max(1, targetMaxBytes),
    targetDurationSec,
    durationSec,
  };
}

function estimatedDurationSecForRange(totalDurationSec: number | undefined, partBytes: number, totalBytes: number): number {
  if (!totalDurationSec || totalBytes <= 0) {
    return 0;
  }
  return Math.round((partBytes / totalBytes) * totalDurationSec * 1000) / 1000;
}

function buildBlobSliceChunks(audio: Blob, fileName: string, plan: ChunkPlan): TranscriptionChunk[] {
  const chunks: Omit<TranscriptionChunk, 'chunkCount' | 'chunkIndex'>[] = [];
  let offset = 0;
  let startOffsetMs = 0;

  while (offset < audio.size) {
    const blob = audio.slice(offset, Math.min(offset + plan.targetMaxBytes, audio.size), audio.type);
    const estimatedDurationSec = estimatedDurationSecForRange(plan.durationSec, blob.size, audio.size);
    chunks.push({
      blob,
      fileName: fileNameForChunk(fileName, chunks.length),
      strategy: chunks.length === 0 && blob.size === audio.size ? 'single' : 'blob-slice',
      startOffsetMs,
      estimatedDurationSec,
    });
    startOffsetMs += Math.round(estimatedDurationSec * 1000);
    offset += blob.size;
  }

  return finalizeChunks(chunks);
}

async function splitFragmentedMp4Blob(audio: Blob, fileName: string, plan: ChunkPlan, bytes: Uint8Array): Promise<TranscriptionChunk[] | null> {
  const boxes = readMp4TopLevelBoxes(bytes);
  const initBoxes = boxes.filter((box) => box.type === 'ftyp' || box.type === 'moov');
  const mediaBoxes = boxes.filter((box) => box.type !== 'ftyp' && box.type !== 'moov');

  if (!initBoxes.length || !mediaBoxes.some((box) => box.type === 'moof')) {
    return null;
  }

  const initBytes = concatUint8Arrays(initBoxes.map((box) => bytes.slice(box.start, box.end)));
  if (initBytes.byteLength >= MAX_TRANSCRIPTION_BYTES || initBytes.byteLength >= plan.targetMaxBytes) {
    return null;
  }

  const chunks: Omit<TranscriptionChunk, 'chunkCount' | 'chunkIndex'>[] = [];
  let currentParts: Uint8Array[] = [initBytes];
  let currentBytes = initBytes.byteLength;
  let currentStartMediaOffset = mediaBoxes[0]?.start ?? 0;

  for (const box of mediaBoxes) {
    const boxBytes = bytes.slice(box.start, box.end);
    const wouldExceed = currentBytes + boxBytes.byteLength > plan.targetMaxBytes;

    if (wouldExceed && currentParts.length > 1) {
      const mediaBytes = currentBytes - initBytes.byteLength;
      const startRatio = currentStartMediaOffset / Math.max(1, audio.size);
      chunks.push({
        blob: new Blob(currentParts.map(toOwnedArrayBuffer), { type: audio.type || 'audio/mp4' }),
        fileName: fileNameForChunk(fileName, chunks.length),
        strategy: 'mp4-fragmented',
        startOffsetMs: Math.round((plan.durationSec ?? 0) * startRatio * 1000),
        estimatedDurationSec: estimatedDurationSecForRange(plan.durationSec, mediaBytes, audio.size),
      });
      currentParts = [initBytes, boxBytes];
      currentBytes = initBytes.byteLength + boxBytes.byteLength;
      currentStartMediaOffset = box.start;
      continue;
    }

    if (wouldExceed && currentParts.length === 1) {
      return null;
    }

    currentParts.push(boxBytes);
    currentBytes += boxBytes.byteLength;
  }

  if (currentParts.length > 1) {
    const mediaBytes = currentBytes - initBytes.byteLength;
    const startRatio = currentStartMediaOffset / Math.max(1, audio.size);
    chunks.push({
      blob: new Blob(currentParts.map(toOwnedArrayBuffer), { type: audio.type || 'audio/mp4' }),
      fileName: fileNameForChunk(fileName, chunks.length),
      strategy: 'mp4-fragmented',
      startOffsetMs: Math.round((plan.durationSec ?? 0) * startRatio * 1000),
      estimatedDurationSec: estimatedDurationSecForRange(plan.durationSec, mediaBytes, audio.size),
    });
  }

  return chunks.length ? finalizeChunks(chunks) : null;
}

async function splitMp4AudioBlob(audio: Blob, fileName: string, plan: ChunkPlan, bytes: Uint8Array): Promise<TranscriptionChunk[] | null> {
  const boxes = readMp4TopLevelBoxes(bytes);
  const ftyp = boxes.find((box) => box.type === 'ftyp');
  const moov = boxes.find((box) => box.type === 'moov');
  const mdat = boxes.find((box) => box.type === 'mdat');

  if (!ftyp || !moov || !mdat || ftyp.start !== 0) {
    return null;
  }

  const header = concatUint8Arrays([bytes.slice(ftyp.start, ftyp.end), bytes.slice(moov.start, moov.end)]);
  const mdatPayload = bytes.slice(mdat.start + MP4_BOX_HEADER_BYTES, mdat.end);
  const maxPayloadBytes = Math.min(MAX_TRANSCRIPTION_BYTES, plan.targetMaxBytes) - header.byteLength - MP4_BOX_HEADER_BYTES;

  if (maxPayloadBytes <= 0) {
    throw new HttpError('Split configuration failed because MP4 headers already exceed the transcription size budget.', 500, {
      fileName,
      headerBytes: header.byteLength,
      targetMaxBytes: plan.targetMaxBytes,
      maxTranscriptionBytes: MAX_TRANSCRIPTION_BYTES,
    });
  }

  const chunks: Omit<TranscriptionChunk, 'chunkCount' | 'chunkIndex'>[] = [];
  let offset = 0;

  while (offset < mdatPayload.byteLength) {
    const payloadSlice = mdatPayload.slice(offset, Math.min(offset + maxPayloadBytes, mdatPayload.byteLength));
    const mdatHeader = new Uint8Array(MP4_BOX_HEADER_BYTES);
    new DataView(mdatHeader.buffer).setUint32(0, payloadSlice.byteLength + MP4_BOX_HEADER_BYTES);
    mdatHeader.set(textEncoder.encode('mdat'), 4);

    const chunkBytes = concatUint8Arrays([header, mdatHeader, payloadSlice]);
    chunks.push({
      blob: new Blob([toOwnedArrayBuffer(chunkBytes)], { type: audio.type || 'audio/mp4' }),
      fileName: fileNameForChunk(fileName, chunks.length),
      strategy: 'mp4-rewrapped',
      startOffsetMs: Math.round(((plan.durationSec ?? 0) * offset) / Math.max(1, mdatPayload.byteLength) * 1000),
      estimatedDurationSec: estimatedDurationSecForRange(plan.durationSec, payloadSlice.byteLength, mdatPayload.byteLength),
    });
    offset += payloadSlice.byteLength;
  }

  return finalizeChunks(chunks);
}

async function buildTranscriptionChunks(audio: Blob, fileName: string): Promise<{ chunks: TranscriptionChunk[]; durationSec?: number; strategyReason: string }> {
  if (audio.size <= MAX_TRANSCRIPTION_BYTES && extensionForFileName(fileName) !== '.m4a' && extensionForFileName(fileName) !== '.mp4') {
    return {
      chunks: [{
        blob: audio,
        fileName,
        strategy: 'single',
        chunkIndex: 0,
        chunkCount: 1,
        startOffsetMs: 0,
        estimatedDurationSec: 0,
      }],
      strategyReason: 'single-no-duration-metadata',
    };
  }

  const bytes = new Uint8Array(await audio.arrayBuffer());
  const durationSec = readMp4DurationSeconds(audio, fileName, bytes);
  const plan = buildChunkPlan(audio, durationSec);
  const requiresDurationSplit = Boolean(durationSec && durationSec > TARGET_CHUNK_DURATION_SEC);
  const requiresSizeSplit = audio.size > MAX_TRANSCRIPTION_BYTES;

  if (!requiresDurationSplit && !requiresSizeSplit) {
    return {
      chunks: [{
        blob: audio,
        fileName,
        strategy: 'single',
        chunkIndex: 0,
        chunkCount: 1,
        startOffsetMs: 0,
        estimatedDurationSec: durationSec ?? 0,
      }],
      durationSec,
      strategyReason: durationSec ? 'single-with-duration-metadata' : 'single-under-budgets',
    };
  }

  const extension = extensionForFileName(fileName);
  if (extension === '.m4a' || extension === '.mp4') {
    const fragmentedChunks = await splitFragmentedMp4Blob(audio, fileName, plan, bytes);
    if (fragmentedChunks?.length) {
      return { chunks: fragmentedChunks, durationSec, strategyReason: 'mp4-fragmented-duration-or-size-split' };
    }

    const mp4Chunks = await splitMp4AudioBlob(audio, fileName, plan, bytes);
    if (mp4Chunks?.length) {
      return { chunks: mp4Chunks, durationSec, strategyReason: 'mp4-rewrapped-duration-or-size-split' };
    }
  }

  return { chunks: buildBlobSliceChunks(audio, fileName, plan), durationSec, strategyReason: 'fallback-blob-slice' };
}

function getChunkDurationMs(result: TranscriptResult, fallbackDurationSec: number): number {
  const segmentEndMs = result.segments.reduce((max, segment) => Math.max(max, segment.endMs ?? segment.startMs ?? 0), 0);
  if (segmentEndMs > 0) {
    return segmentEndMs;
  }
  return Math.round(fallbackDurationSec * 1000);
}

function applyOffsetToTranscript(result: TranscriptResult, offsetMs: number): TranscriptResult {
  if (!offsetMs) {
    return result;
  }

  return {
    ...result,
    segments: result.segments.map((segment) => ({
      ...segment,
      startMs: segment.startMs !== undefined ? segment.startMs + offsetMs : undefined,
      endMs: segment.endMs !== undefined ? segment.endMs + offsetMs : undefined,
    })),
  };
}

function mergeTranscriptResults(results: TranscriptResult[]): TranscriptResult {
  const segments: TranscriptSegment[] = [];
  const texts: string[] = [];

  for (const result of results) {
    if (result.fullText.trim()) {
      texts.push(result.fullText.trim());
    }
    segments.push(...result.segments);
  }

  const fullText = texts.join('\n\n').trim() || segments.map((segment) => `[${segment.speaker}] ${segment.text}`.trim()).join('\n');
  return {
    fullText,
    segments,
    raw: results.map((result) => result.raw),
  };
}

async function transcribeChunk(
  env: Env,
  chunk: TranscriptionChunk,
  languageHint?: string,
): Promise<TranscriptResult> {
  const model = env.OPENAI_MODEL_TRANSCRIBE ?? DEFAULT_TRANSCRIBE_MODEL;
  const form = new FormData();
  form.append('file', chunk.blob, chunk.fileName);
  form.append('model', model);
  form.append('response_format', 'diarized_json');
  form.append('chunking_strategy', 'auto');

  if (languageHint) {
    form.append('language', languageHint);
  }

  const response = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const responseText = await readResponseTextSafely(response);
    console.error('openai.transcription.failed', {
      fileName: chunk.fileName,
      bytes: chunk.blob.size,
      model,
      strategy: chunk.strategy,
      chunkIndex: chunk.chunkIndex + 1,
      chunkCount: chunk.chunkCount,
      startOffsetMs: chunk.startOffsetMs,
      estimatedDurationSec: chunk.estimatedDurationSec,
      responseStatus: response.status,
      responseText,
    });
    throw new HttpError('OpenAI transcription request failed.', 502, {
      fileName: chunk.fileName,
      bytes: chunk.blob.size,
      model,
      strategy: chunk.strategy,
      chunkIndex: chunk.chunkIndex + 1,
      chunkCount: chunk.chunkCount,
      startOffsetMs: chunk.startOffsetMs,
      estimatedDurationSec: chunk.estimatedDurationSec,
      responseStatus: response.status,
      responseText,
    });
  }

  return mapTranscriptPayload((await response.json()) as OpenAiDiarizedTranscript);
}

export async function transcribeWithDiarization(
  env: Env,
  audio: Blob,
  fileName: string,
  languageHint?: string,
): Promise<TranscriptResult> {
  const { chunks, durationSec, strategyReason } = await buildTranscriptionChunks(audio, fileName);
  const results: TranscriptResult[] = [];
  let accumulatedOffsetMs = 0;

  console.log('openai.transcription.plan', {
    fileName,
    bytes: audio.size,
    durationSec,
    strategyReason,
    chunkCount: chunks.length,
    targetChunkDurationSec: TARGET_CHUNK_DURATION_SEC,
    maxModelDurationSec: MAX_MODEL_DURATION_SEC,
  });

  for (const chunk of chunks) {
    console.log('openai.transcription.chunk', {
      chunkIndex: chunk.chunkIndex + 1,
      chunkCount: chunk.chunkCount,
      bytes: chunk.blob.size,
      strategy: chunk.strategy,
      fileName: chunk.fileName,
      startOffsetMs: chunk.startOffsetMs,
      estimatedDurationSec: chunk.estimatedDurationSec,
      sourceBytes: audio.size,
      sourceDurationSec: durationSec,
    });

    try {
      const chunkResult = await transcribeChunk(env, chunk, languageHint);
      const normalizedResult = applyOffsetToTranscript(chunkResult, accumulatedOffsetMs || chunk.startOffsetMs);
      results.push(normalizedResult);
      accumulatedOffsetMs = (accumulatedOffsetMs || chunk.startOffsetMs) + getChunkDurationMs(chunkResult, chunk.estimatedDurationSec);
    } catch (error) {
      throw new HttpError('Transcription request failed.', 502, {
        chunkIndex: chunk.chunkIndex + 1,
        chunkCount: chunk.chunkCount,
        fileName: chunk.fileName,
        bytes: chunk.blob.size,
        strategy: chunk.strategy,
        startOffsetMs: chunk.startOffsetMs,
        estimatedDurationSec: chunk.estimatedDurationSec,
        sourceDurationSec: durationSec,
        sourceBytes: audio.size,
        cause: error instanceof HttpError ? error.details : error instanceof Error ? error.message : error,
      });
    }
  }

  return mergeTranscriptResults(results);
}

export async function summarizeInterview(env: Env, transcript: TranscriptResult): Promise<InterviewInsights> {
  const response = await fetch(`${OPENAI_API}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL_SUMMARIZE ?? 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You extract structured interview notes.',
                'Return strict JSON with keys: summary, myTasks, otherTasks, ambiguities.',
                'myTasks and otherTasks must be string arrays.',
                'If task ownership is unclear, do not guess and instead explain it in ambiguities.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: transcript.fullText }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'interview_insights',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['summary', 'myTasks', 'otherTasks', 'ambiguities'],
            properties: {
              summary: { type: 'string' },
              myTasks: { type: 'array', items: { type: 'string' } },
              otherTasks: { type: 'array', items: { type: 'string' } },
              ambiguities: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const responseText = await readResponseTextSafely(response);
    console.error('openai.summary.failed', {
      responseStatus: response.status,
      responseText,
    });
    throw new HttpError('Summary generation failed.', 502, {
      responseStatus: response.status,
      responseText,
    });
  }

  const payload = (await response.json()) as { output_text?: string };
  if (!payload.output_text) {
    throw new HttpError('Summary response did not include output_text.', 502, payload);
  }

  const parsed = JSON.parse(payload.output_text) as Omit<InterviewInsights, 'raw'>;
  return { ...parsed, raw: payload };
}
