import type { Env, InterviewInsights, TranscriptResult, TranscriptSegment } from '../types';
import { HttpError } from './http';

const OPENAI_API = 'https://api.openai.com/v1';
const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
const MP4_BOX_HEADER_BYTES = 8;
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe-diarize';

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
  chunkCount?: number;
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
  const fullText = (payload.text ?? payload.transcript ?? '').trim() || segments.map((segment) => `[${segment.speaker}] ${segment.text}`.trim()).join('\n');

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

async function transcribeChunk(
  env: Env,
  audio: Blob,
  fileName: string,
  languageHint?: string,
): Promise<TranscriptResult> {
  const model = env.OPENAI_MODEL_TRANSCRIBE ?? DEFAULT_TRANSCRIBE_MODEL;
  const form = new FormData();
  form.append('file', audio, fileName);
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
      fileName,
      bytes: audio.size,
      model,
      responseStatus: response.status,
      responseText,
    });
    throw new HttpError('OpenAI transcription request failed.', 502, {
      fileName,
      bytes: audio.size,
      model,
      responseStatus: response.status,
      responseText,
    });
  }

  return mapTranscriptPayload((await response.json()) as OpenAiDiarizedTranscript);
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

function finalizeChunks(chunks: Omit<TranscriptionChunk, 'chunkCount'>[]): TranscriptionChunk[] {
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
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, Math.min(16, bytes.byteLength - offset));
    let size = view.getUint32(0);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    let headerSize = MP4_BOX_HEADER_BYTES;

    if (size === 1) {
      if (offset + 16 > bytes.byteLength) {
        break;
      }
      const high = view.getUint32(8);
      const low = view.getUint32(12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
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

async function splitFragmentedMp4Blob(audio: Blob, fileName: string): Promise<TranscriptionChunk[] | null> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const boxes = readMp4TopLevelBoxes(bytes);
  const initBoxes = boxes.filter((box) => box.type === 'ftyp' || box.type === 'moov');
  const mediaBoxes = boxes.filter((box) => box.type !== 'ftyp' && box.type !== 'moov');

  if (!initBoxes.length || !mediaBoxes.some((box) => box.type === 'moof')) {
    return null;
  }

  const initBytes = concatUint8Arrays(initBoxes.map((box) => bytes.slice(box.start, box.end)));
  if (initBytes.byteLength >= MAX_TRANSCRIPTION_BYTES) {
    return null;
  }

  const chunks: Omit<TranscriptionChunk, 'chunkCount'>[] = [];
  let currentParts: Uint8Array[] = [initBytes];
  let currentBytes = initBytes.byteLength;

  for (const box of mediaBoxes) {
    const boxBytes = bytes.slice(box.start, box.end);
    const wouldExceed = currentBytes + boxBytes.byteLength > MAX_TRANSCRIPTION_BYTES;

    if (wouldExceed && currentParts.length > 1) {
      chunks.push({
        blob: new Blob(currentParts.map(toOwnedArrayBuffer), { type: audio.type || 'audio/mp4' }),
        fileName: fileNameForChunk(fileName, chunks.length),
        strategy: 'mp4-fragmented',
        chunkIndex: chunks.length,
      });
      currentParts = [initBytes, boxBytes];
      currentBytes = initBytes.byteLength + boxBytes.byteLength;
      continue;
    }

    if (wouldExceed && currentParts.length === 1) {
      return null;
    }

    currentParts.push(boxBytes);
    currentBytes += boxBytes.byteLength;
  }

  if (currentParts.length > 1) {
    chunks.push({
      blob: new Blob(currentParts.map(toOwnedArrayBuffer), { type: audio.type || 'audio/mp4' }),
      fileName: fileNameForChunk(fileName, chunks.length),
      strategy: 'mp4-fragmented',
      chunkIndex: chunks.length,
    });
  }

  return chunks.length ? finalizeChunks(chunks) : null;
}

async function splitMp4AudioBlob(audio: Blob, fileName: string): Promise<TranscriptionChunk[] | null> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const boxes = readMp4TopLevelBoxes(bytes);

  const ftyp = boxes.find((box) => box.type === 'ftyp');
  const moov = boxes.find((box) => box.type === 'moov');
  const mdat = boxes.find((box) => box.type === 'mdat');

  if (!ftyp || !moov || !mdat || ftyp.start !== 0) {
    return null;
  }

  const header = concatUint8Arrays([bytes.slice(ftyp.start, ftyp.end), bytes.slice(moov.start, moov.end)]);
  const mdatPayload = bytes.slice(mdat.start + MP4_BOX_HEADER_BYTES, mdat.end);
  const maxPayloadBytes = MAX_TRANSCRIPTION_BYTES - header.byteLength - MP4_BOX_HEADER_BYTES;

  if (maxPayloadBytes <= 0) {
    throw new HttpError('Split configuration failed because MP4 headers already exceed the transcription size budget.', 500, {
      fileName,
      headerBytes: header.byteLength,
      maxTranscriptionBytes: MAX_TRANSCRIPTION_BYTES,
    });
  }

  const chunks: Omit<TranscriptionChunk, 'chunkCount'>[] = [];
  let offset = 0;

  while (offset < mdatPayload.byteLength) {
    const payloadSlice = mdatPayload.slice(offset, Math.min(offset + maxPayloadBytes, mdatPayload.byteLength));
    const mdatHeader = new Uint8Array(MP4_BOX_HEADER_BYTES);
    new DataView(mdatHeader.buffer).setUint32(0, payloadSlice.byteLength + MP4_BOX_HEADER_BYTES);
    mdatHeader.set(new TextEncoder().encode('mdat'), 4);

    const chunkBytes = concatUint8Arrays([header, mdatHeader, payloadSlice]);
    chunks.push({
      blob: new Blob([toOwnedArrayBuffer(chunkBytes)], { type: audio.type || 'audio/mp4' }),
      fileName: fileNameForChunk(fileName, chunks.length),
      strategy: 'mp4-rewrapped',
      chunkIndex: chunks.length,
    });
    offset += payloadSlice.byteLength;
  }

  return finalizeChunks(chunks);
}

function splitBlobByByteBudget(audio: Blob, fileName: string): TranscriptionChunk[] {
  const chunks: Omit<TranscriptionChunk, 'chunkCount'>[] = [];
  let offset = 0;

  while (offset < audio.size) {
    const chunk = audio.slice(offset, Math.min(offset + MAX_TRANSCRIPTION_BYTES, audio.size), audio.type);
    chunks.push({
      blob: chunk,
      fileName: fileNameForChunk(fileName, chunks.length),
      strategy: 'blob-slice',
      chunkIndex: chunks.length,
    });
    offset += chunk.size;
  }

  return finalizeChunks(chunks);
}

async function buildTranscriptionChunks(audio: Blob, fileName: string): Promise<TranscriptionChunk[]> {
  if (audio.size <= MAX_TRANSCRIPTION_BYTES) {
    return [{ blob: audio, fileName, strategy: 'single', chunkIndex: 0, chunkCount: 1 }];
  }

  const extension = extensionForFileName(fileName);
  if (extension === '.m4a' || extension === '.mp4') {
    const fragmentedChunks = await splitFragmentedMp4Blob(audio, fileName);
    if (fragmentedChunks?.length) {
      return fragmentedChunks;
    }

    const mp4Chunks = await splitMp4AudioBlob(audio, fileName);
    if (mp4Chunks?.length) {
      return mp4Chunks;
    }
  }

  return splitBlobByByteBudget(audio, fileName);
}

function getChunkDurationMs(result: TranscriptResult): number {
  const segmentEndMs = result.segments.reduce((max, segment) => Math.max(max, segment.endMs ?? segment.startMs ?? 0), 0);
  return segmentEndMs;
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

export async function transcribeWithDiarization(
  env: Env,
  audio: Blob,
  fileName: string,
  languageHint?: string,
): Promise<TranscriptResult> {
  const chunks = await buildTranscriptionChunks(audio, fileName);
  const results: TranscriptResult[] = [];
  let accumulatedOffsetMs = 0;

  for (const chunk of chunks) {
    console.log('openai.transcription.chunk', {
      chunkIndex: chunk.chunkIndex + 1,
      chunkCount: chunk.chunkCount,
      bytes: chunk.blob.size,
      strategy: chunk.strategy,
      fileName: chunk.fileName,
    });

    try {
      const chunkResult = await transcribeChunk(env, chunk.blob, chunk.fileName, languageHint);
      const normalizedResult = applyOffsetToTranscript(chunkResult, accumulatedOffsetMs);
      results.push(normalizedResult);
      accumulatedOffsetMs += getChunkDurationMs(chunkResult);
    } catch (error) {
      throw new HttpError('Transcription request failed.', 502, {
        chunkIndex: chunk.chunkIndex + 1,
        chunkCount: chunk.chunkCount,
        fileName: chunk.fileName,
        bytes: chunk.blob.size,
        strategy: chunk.strategy,
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
