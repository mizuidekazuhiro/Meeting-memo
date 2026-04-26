import type { Env, InterviewInsights, InterviewReviewResult, TranscriptResult, TranscriptSegment } from '../types';
import { HttpError } from './http';
import { logEvent } from './logger';

const OPENAI_API = 'https://api.openai.com/v1';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe-diarize';
export const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
export const MAX_TRANSCRIBE_DURATION_SEC = 1400;
// Keep chunks around 10-12 minutes so we stay well under the 1400s model limit
// and leave headroom for metadata drift / duration estimation error.
export const TARGET_CHUNK_DURATION_SEC = 720;
export const PRIMARY_AUDIO_FORMAT = 'm4a';
export const FALLBACK_AUDIO_FORMAT = 'wav';
export const ENABLE_AUDIO_FALLBACK = true;
const MP4_BOX_HEADER_BYTES = 8;
const WAV_HEADER_BYTES = 44;

type AudioFormat = 'm4a' | 'wav';
type AudioContainer = 'm4a' | 'wav' | 'unknown';
type AudioCodec = 'aac-lc' | 'pcm_s16le' | 'unknown';
type ChunkStrategy = 'single-original' | 'reencoded-aac-m4a' | 'fallback-pcm-wav';

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

type SourceAudioMetadata = {
  fileName: string;
  extension: string;
  mimeType: string;
  originalMimeType?: string;
  bytes: number;
  container: AudioContainer;
  codec: AudioCodec;
  durationSec?: number;
  sampleRate?: number;
  channels?: number;
};

export type ChunkPlanEntry = {
  chunkIndex: number;
  chunkCount: number;
  startOffsetMs: number;
  endOffsetMs: number;
  estimatedDurationSec: number;
};

type ChunkPlan = {
  requiresSplit: boolean;
  entries: ChunkPlanEntry[];
};

export type PreparedTranscriptionChunk = {
  blob: Blob;
  fileName: string;
  extension: string;
  mimeType: string;
  originalMimeType?: string;
  bytes: number;
  codec: AudioCodec;
  container: AudioContainer;
  sampleRate?: number;
  channels?: number;
  estimatedDurationSec: number;
  actualDurationSec?: number;
  strategy: ChunkStrategy;
  validationPassed: boolean;
  validationErrors: string[];
  chunkIndex: number;
  chunkCount: number;
  startOffsetMs: number;
  endOffsetMs: number;
};

type UploadFailure = {
  responseStatus?: number;
  responseText?: string;
  code?: string;
  type?: string;
  param?: string;
};

type GenerateChunkOptions = { preferredFormat: AudioFormat };

type AudioChunkGenerator = (source: Blob, sourceMeta: SourceAudioMetadata, plan: ChunkPlanEntry, options: GenerateChunkOptions) => Promise<PreparedTranscriptionChunk>;

type UploadChunkFn = (env: Env, chunk: PreparedTranscriptionChunk, languageHint?: string) => Promise<TranscriptResult>;

function asSpeakerLabel(segment: DiarizedSegmentLike): string {
  const rawSpeaker = segment.speaker ?? segment.speaker_label ?? segment.speaker_id;
  return rawSpeaker === undefined || rawSpeaker === null || rawSpeaker === '' ? 'speaker_unknown' : String(rawSpeaker);
}

function toMilliseconds(value: number | undefined, alternateValue?: number): number | undefined {
  const candidate = value ?? alternateValue;
  if (candidate === undefined || Number.isNaN(candidate)) return undefined;
  return candidate >= 1000 ? Math.round(candidate) : Math.round(candidate * 1000);
}

function normalizeSegments(payload: OpenAiDiarizedTranscript): TranscriptSegment[] {
  const segments = payload.diarized_segments ?? payload.segments ?? [];
  return segments.map((segment) => ({
    speaker: asSpeakerLabel(segment),
    startMs: toMilliseconds(segment.start_ms, segment.start ?? segment.startMs),
    endMs: toMilliseconds(segment.end_ms, segment.end ?? segment.endMs),
    text: (segment.text ?? '').trim(),
  })).filter((segment) => Boolean(segment.text));
}

function mapTranscriptPayload(payload: OpenAiDiarizedTranscript): TranscriptResult {
  const segments = normalizeSegments(payload);
  const fullText = (payload.text ?? payload.transcript ?? '').trim() || segments.map((segment) => `[${segment.speaker}] ${segment.text}`.trim()).join('\n');
  return { fullText, segments, raw: payload };
}

async function readResponseTextSafely(response: Response): Promise<string> {
  try { return await response.text(); } catch (error) { return `<<failed to read response body: ${error instanceof Error ? error.message : String(error)}>>`; }
}

function extensionForFileName(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index).toLowerCase() : '';
}

function mimeTypeForFormat(format: AudioFormat): string {
  return format === 'm4a' ? 'audio/mp4' : 'audio/wav';
}

function normalizeMimeValue(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

function normalizeAudioMimeTypeForExtension(extension: string, mimeType: string): string {
  const normalized = normalizeMimeValue(mimeType);
  if (extension === '.m4a' || extension === '.mp4') {
    if (normalized === 'audio/mp4' || normalized === 'audio/m4a' || normalized === 'audio/x-m4a' || normalized === 'video/mp4') return 'audio/mp4';
    return normalized;
  }
  if (extension === '.wav') {
    if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'audio/wav';
    return normalized;
  }
  return normalized;
}

export function normalizeAudioMimeType(fileName: string, mimeType: string): string {
  return normalizeAudioMimeTypeForExtension(extensionForFileName(fileName), mimeType);
}

export function isAcceptedMimeTypeForExtension(extension: string, mimeType: string): boolean {
  if (extension === '.m4a' || extension === '.mp4') return normalizeAudioMimeTypeForExtension(extension, mimeType) === 'audio/mp4';
  if (extension === '.wav') return normalizeAudioMimeTypeForExtension(extension, mimeType) === 'audio/wav';
  return true;
}

function isEmptyOrOctetStreamMime(mimeType: string): boolean {
  const normalized = normalizeMimeValue(mimeType);
  return normalized === '' || normalized === 'application/octet-stream';
}

async function hasMp4FtypSignature(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (head.byteLength < 12) return false;
  for (let offset = 4; offset + 4 <= Math.min(head.byteLength, 20); offset += 1) {
    if (readAscii(head, offset, 4) === 'ftyp') return true;
  }
  return false;
}

function containerForFormat(format: AudioFormat): AudioContainer { return format; }
function codecForFormat(format: AudioFormat): AudioCodec { return format === 'm4a' ? 'aac-lc' : 'pcm_s16le'; }

function fileNameForChunk(fileName: string, chunkIndex: number, format: AudioFormat): string {
  const extension = format === 'm4a' ? '.m4a' : '.wav';
  const sourceExt = extensionForFileName(fileName);
  const stem = sourceExt ? fileName.slice(0, -sourceExt.length) : fileName;
  return `${stem}.part-${String(chunkIndex + 1).padStart(3, '0')}${extension}`;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string { return String.fromCharCode(...bytes.slice(start, start + length)); }
function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

type Mp4TopLevelBox = { type: string; start: number; end: number };
function readMp4TopLevelBoxes(bytes: Uint8Array): Mp4TopLevelBox[] {
  const boxes: Mp4TopLevelBox[] = [];
  let offset = 0;
  while (offset + MP4_BOX_HEADER_BYTES <= bytes.byteLength) {
    const size32 = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = readAscii(bytes, offset + 4, 4);
    let size = size32;
    let headerSize = MP4_BOX_HEADER_BYTES;
    if (size32 === 1) {
      if (offset + 16 > bytes.byteLength) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8);
      size = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
      headerSize = 16;
    } else if (size32 === 0) size = bytes.byteLength - offset;
    if (!size || size < headerSize || offset + size > bytes.byteLength) break;
    boxes.push({ type, start: offset, end: offset + size });
    offset += size;
  }
  return boxes;
}

function findFirstBox(bytes: Uint8Array, path: string[]): Uint8Array | null {
  let current: Uint8Array | null = bytes;
  for (const target of path) {
    if (!current) return null;
    let found: Uint8Array | null = null;
    let offset = 8;
    while (offset + 8 <= current.byteLength) {
      const size = new DataView(current.buffer, current.byteOffset + offset, 4).getUint32(0);
      const type = readAscii(current, offset + 4, 4);
      if (!size || offset + size > current.byteLength) break;
      if (type === target) { found = current.slice(offset, offset + size); break; }
      offset += size;
    }
    current = found;
  }
  return current;
}

function readMp4DurationSeconds(fileName: string, bytes: Uint8Array): number | undefined {
  const extension = extensionForFileName(fileName);
  if (extension !== '.m4a' && extension !== '.mp4') return undefined;
  const moov = readMp4TopLevelBoxes(bytes).find((box) => box.type === 'moov');
  if (!moov) return undefined;
  const moovBytes = bytes.slice(moov.start, moov.end);
  const mdhd = findFirstBox(moovBytes, ['trak', 'mdia', 'mdhd']);
  if (mdhd && mdhd.byteLength >= 28) {
    const version = mdhd[8];
    const view = new DataView(mdhd.buffer, mdhd.byteOffset, mdhd.byteLength);
    if (version === 1 && mdhd.byteLength >= 44) {
      const timescale = view.getUint32(28);
      const duration = view.getUint32(32) * 2 ** 32 + view.getUint32(36);
      if (timescale > 0 && duration > 0) return duration / timescale;
    }
    if (version === 0 && mdhd.byteLength >= 32) {
      const timescale = view.getUint32(20);
      const duration = view.getUint32(24);
      if (timescale > 0 && duration > 0) return duration / timescale;
    }
  }
  const mvhd = findFirstBox(moovBytes, ['mvhd']);
  if (!mvhd || mvhd.byteLength < 28) return undefined;
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

function inspectWav(bytes: Uint8Array): Pick<SourceAudioMetadata, 'durationSec' | 'sampleRate' | 'channels' | 'codec' | 'container'> | null {
  if (bytes.byteLength < WAV_HEADER_BYTES || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const blockAlign = Math.max(1, (channels * bitsPerSample) / 8);
  const durationSec = sampleRate > 0 ? dataBytes / blockAlign / sampleRate : undefined;
  return { durationSec, sampleRate, channels, codec: 'pcm_s16le', container: 'wav' };
}

export async function inspectAudioSource(audio: Blob, fileName: string): Promise<SourceAudioMetadata> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const extension = extensionForFileName(fileName);
  const wav = inspectWav(bytes);
  if (wav) {
    const originalMimeType = audio.type || 'audio/wav';
    const normalizedMimeType = normalizeAudioMimeTypeForExtension('.wav', originalMimeType);
    return { fileName, extension: '.wav', mimeType: normalizedMimeType, originalMimeType, bytes: audio.size, ...wav };
  }
  const durationSec = readMp4DurationSeconds(fileName, bytes);
  const originalMimeType = audio.type || (extension === '.m4a' || extension === '.mp4' ? 'audio/mp4' : 'application/octet-stream');
  const normalizedMimeType = normalizeAudioMimeTypeForExtension(extension, originalMimeType);
  return {
    fileName,
    extension,
    mimeType: normalizedMimeType,
    originalMimeType,
    bytes: audio.size,
    container: extension === '.m4a' || extension === '.mp4' ? 'm4a' : 'unknown',
    codec: extension === '.m4a' || extension === '.mp4' ? 'aac-lc' : 'unknown',
    durationSec,
  };
}

export function createChunkPlan(sourceDurationSec: number | undefined, sourceBytes: number): ChunkPlan {
  const needsDurationSplit = Boolean(sourceDurationSec && sourceDurationSec > TARGET_CHUNK_DURATION_SEC);
  const needsSizeSplit = sourceBytes > MAX_TRANSCRIPTION_BYTES;
  if (!needsDurationSplit && !needsSizeSplit) {
    return { requiresSplit: false, entries: [{ chunkIndex: 0, chunkCount: 1, startOffsetMs: 0, endOffsetMs: Math.round((sourceDurationSec ?? 0) * 1000), estimatedDurationSec: sourceDurationSec ?? 0 }] };
  }

  const durationCount = sourceDurationSec ? Math.ceil(sourceDurationSec / TARGET_CHUNK_DURATION_SEC) : 1;
  const sizeCount = Math.ceil(sourceBytes / MAX_TRANSCRIPTION_BYTES);
  const chunkCount = Math.max(1, durationCount, sizeCount);
  const sourceDurationMs = Math.round((sourceDurationSec ?? TARGET_CHUNK_DURATION_SEC * chunkCount) * 1000);
  const entries: ChunkPlanEntry[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const startOffsetMs = Math.floor((sourceDurationMs * index) / chunkCount);
    const endOffsetMs = index === chunkCount - 1 ? sourceDurationMs : Math.floor((sourceDurationMs * (index + 1)) / chunkCount);
    entries.push({ chunkIndex: index, chunkCount, startOffsetMs, endOffsetMs, estimatedDurationSec: Math.max(0.001, (endOffsetMs - startOffsetMs) / 1000) });
  }
  return { requiresSplit: true, entries };
}

function encodeWavPcm16(samples: Int16Array, sampleRate: number, channels: number): Uint8Array {
  const dataBytes = samples.byteLength;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  const byteRate = sampleRate * channels * 2; view.setUint32(28, byteRate, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data');
  view.setUint32(40, dataBytes, true); out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), WAV_HEADER_BYTES);
  return out;
}

async function generateChunkFromWav(source: Blob, sourceMeta: SourceAudioMetadata, plan: ChunkPlanEntry, format: AudioFormat): Promise<PreparedTranscriptionChunk> {
  const bytes = new Uint8Array(await source.arrayBuffer());
  const wav = inspectWav(bytes);
  if (!wav?.sampleRate || !wav.channels) throw new Error('WAV metadata is incomplete.');
  const bytesPerSampleFrame = wav.channels * 2;
  const frameStart = Math.floor((plan.startOffsetMs / 1000) * wav.sampleRate);
  const frameEnd = Math.max(frameStart + 1, Math.floor((plan.endOffsetMs / 1000) * wav.sampleRate));
  const sampleStart = frameStart * wav.channels;
  const sampleEnd = frameEnd * wav.channels;
  const pcm = new Int16Array(bytes.buffer.slice(WAV_HEADER_BYTES));
  const trimmed = pcm.slice(sampleStart, Math.min(sampleEnd, pcm.length));
  if (trimmed.byteLength === 0) throw new Error('Trimmed WAV chunk is empty.');
  const encodedBytes = encodeWavPcm16(trimmed, wav.sampleRate, wav.channels);
  const actualDurationSec = trimmed.length / wav.channels / wav.sampleRate;
  const chosenFormat: AudioFormat = 'wav';
  return {
    blob: new Blob([new Uint8Array(encodedBytes)], { type: mimeTypeForFormat(chosenFormat) }),
    fileName: fileNameForChunk(sourceMeta.fileName, plan.chunkIndex, chosenFormat),
    extension: '.wav',
    mimeType: mimeTypeForFormat(chosenFormat),
    bytes: encodedBytes.byteLength,
    codec: codecForFormat(chosenFormat),
    container: containerForFormat(chosenFormat),
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    estimatedDurationSec: plan.estimatedDurationSec,
    actualDurationSec,
    strategy: 'fallback-pcm-wav',
    validationPassed: false,
    validationErrors: [],
    chunkIndex: plan.chunkIndex,
    chunkCount: plan.chunkCount,
    startOffsetMs: plan.startOffsetMs,
    endOffsetMs: plan.endOffsetMs,
  };
}

const defaultChunkGenerator: AudioChunkGenerator = async (source, sourceMeta, plan, options) => {
  if (sourceMeta.container === 'wav') return generateChunkFromWav(source, sourceMeta, plan, options.preferredFormat);
  throw new Error(`Safe decode -> trim -> re-encode chunk generation is unavailable for ${sourceMeta.container} in this runtime.`);
};

export async function validateChunk(chunk: PreparedTranscriptionChunk): Promise<PreparedTranscriptionChunk> {
  const errors: string[] = [];
  const originalMimeType = chunk.originalMimeType ?? chunk.mimeType;
  const extension = chunk.extension || extensionForFileName(chunk.fileName);
  let normalizedMimeType = normalizeAudioMimeTypeForExtension(extension, originalMimeType);
  let usedFallback = false;
  let usedSignatureCheck = false;

  if ((extension === '.m4a' || extension === '.mp4') && isEmptyOrOctetStreamMime(originalMimeType)) {
    usedFallback = true;
    usedSignatureCheck = true;
    if (await hasMp4FtypSignature(chunk.blob)) {
      normalizedMimeType = 'audio/mp4';
    } else {
      errors.push('m4a signature check failed');
    }
  }

  if (usedFallback) {
    logEvent('info', 'mime normalized from extension', {
      fileName: chunk.fileName,
      originalMimeType,
      normalizedMimeType,
      extension,
      usedFallback,
      usedSignatureCheck,
    });
  }

  if (chunk.bytes <= 0) errors.push('bytes must be > 0');
  const duration = chunk.actualDurationSec ?? chunk.estimatedDurationSec;
  if (!duration || duration <= 0) errors.push('duration must be > 0');
  if (!isAcceptedMimeTypeForExtension(extension, normalizedMimeType)) errors.push('extension and mimeType mismatch');
  if (chunk.codec === 'unknown' || chunk.container === 'unknown') errors.push('codec/container metadata missing');
  if (chunk.blob.size <= 0) errors.push('chunk blob is empty');
  return { ...chunk, mimeType: normalizedMimeType, originalMimeType, validationPassed: errors.length === 0, validationErrors: errors };
}

function getChunkDurationMs(result: TranscriptResult, fallbackDurationSec: number): number {
  const segmentEndMs = result.segments.reduce((max, segment) => Math.max(max, segment.endMs ?? segment.startMs ?? 0), 0);
  return segmentEndMs > 0 ? segmentEndMs : Math.round(fallbackDurationSec * 1000);
}

function applyOffsetToTranscript(result: TranscriptResult, offsetMs: number): TranscriptResult {
  if (!offsetMs) return result;
  return { ...result, segments: result.segments.map((segment) => ({ ...segment, startMs: segment.startMs !== undefined ? segment.startMs + offsetMs : undefined, endMs: segment.endMs !== undefined ? segment.endMs + offsetMs : undefined })) };
}

function mergeTranscriptResults(results: TranscriptResult[]): TranscriptResult {
  const ordered = [...results].sort((a, b) => (a.segments[0]?.startMs ?? 0) - (b.segments[0]?.startMs ?? 0));
  const segments = ordered.flatMap((result) => result.segments);
  const texts = ordered.map((result) => result.fullText.trim()).filter(Boolean);
  return { fullText: texts.join('\n\n').trim() || segments.map((segment) => `[${segment.speaker}] ${segment.text}`.trim()).join('\n'), segments, raw: ordered.map((result) => result.raw) };
}

function parseOpenAiFailure(responseText: string): UploadFailure {
  try {
    const parsed = JSON.parse(responseText) as { error?: { type?: string; code?: string; param?: string; message?: string } };
    return { responseText, type: parsed.error?.type, code: parsed.error?.code, param: parsed.error?.param };
  } catch {
    return { responseText };
  }
}

function shouldFallbackToWav(error: unknown): boolean {
  if (!ENABLE_AUDIO_FALLBACK || !(error instanceof HttpError)) return false;
  const details = (error.details ?? {}) as UploadFailure;
  const responseText = details.responseText ?? '';
  return details.responseStatus !== undefined
    && details.responseStatus >= 400
    && details.responseStatus < 500
    && (details.param === 'file' || /corrupted|unsupported|invalid_value|file/i.test(responseText));
}

async function uploadPreparedChunk(env: Env, chunk: PreparedTranscriptionChunk, languageHint?: string): Promise<TranscriptResult> {
  const model = env.OPENAI_MODEL_TRANSCRIBE ?? DEFAULT_TRANSCRIBE_MODEL;
  const form = new FormData();
  const uploadBlob = chunk.blob.type === chunk.mimeType ? chunk.blob : new Blob([chunk.blob], { type: chunk.mimeType });
  form.append('file', uploadBlob, chunk.fileName);
  form.append('model', model);
  form.append('response_format', 'diarized_json');
  form.append('chunking_strategy', 'auto');
  if (languageHint) form.append('language', languageHint);
  const response = await fetch(`${OPENAI_API}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form });
  if (!response.ok) {
    const responseText = await readResponseTextSafely(response);
    const parsed = parseOpenAiFailure(responseText);
    logEvent('error', 'upload request failed', { fileName: chunk.fileName, chunkIndex: chunk.chunkIndex + 1, chunkCount: chunk.chunkCount, strategy: chunk.strategy, format: chunk.extension, responseStatus: response.status, responseText });
    throw new HttpError('OpenAI transcription request failed.', 502, { ...parsed, responseStatus: response.status, fileName: chunk.fileName, chunkIndex: chunk.chunkIndex + 1, chunkCount: chunk.chunkCount, strategy: chunk.strategy, format: chunk.extension });
  }
  return mapTranscriptPayload((await response.json()) as OpenAiDiarizedTranscript);
}

async function transcribeChunkWithFallback(env: Env, source: Blob, sourceMeta: SourceAudioMetadata, plan: ChunkPlanEntry, languageHint: string | undefined, chunkGenerator: AudioChunkGenerator, uploadChunk: UploadChunkFn, context: Record<string, unknown>): Promise<TranscriptResult> {
  let chunk = await validateChunk(await chunkGenerator(source, sourceMeta, plan, { preferredFormat: PRIMARY_AUDIO_FORMAT }));
  if (!chunk.validationPassed) {
    logEvent('error', 'chunk validation failed', { ...context, fileName: sourceMeta.fileName, chunkIndex: plan.chunkIndex + 1, chunkCount: plan.chunkCount, strategy: chunk.strategy, extension: chunk.extension, originalMimeType: chunk.originalMimeType, normalizedMimeType: chunk.mimeType, validationErrors: chunk.validationErrors });
    throw new HttpError('chunk validation failed', 500, { fileName: sourceMeta.fileName, chunkIndex: plan.chunkIndex + 1, chunkCount: plan.chunkCount, strategy: chunk.strategy, extension: chunk.extension, format: chunk.extension, originalMimeType: chunk.originalMimeType, normalizedMimeType: chunk.mimeType, validationErrors: chunk.validationErrors });
  }
  logEvent('info', 'openai.transcription.chunk', { ...context, ...buildChunkLogMeta(sourceMeta, chunk) });
  try {
    return await uploadChunk(env, chunk, languageHint);
  } catch (error) {
    if (!shouldFallbackToWav(error) || chunk.extension === '.wav') throw error;
    logEvent('warn', 'chunk upload failed with m4a, fallback to wav', { ...context, fileName: sourceMeta.fileName, chunkIndex: plan.chunkIndex + 1, chunkCount: plan.chunkCount, details: error instanceof HttpError ? error.details : error });
    const fallbackChunk = await validateChunk(await chunkGenerator(source, sourceMeta, plan, { preferredFormat: FALLBACK_AUDIO_FORMAT }));
    if (!fallbackChunk.validationPassed) {
      logEvent('error', 'chunk validation failed', { ...context, fileName: sourceMeta.fileName, chunkIndex: plan.chunkIndex + 1, chunkCount: plan.chunkCount, strategy: fallbackChunk.strategy, extension: fallbackChunk.extension, originalMimeType: fallbackChunk.originalMimeType, normalizedMimeType: fallbackChunk.mimeType, validationErrors: fallbackChunk.validationErrors });
      throw new HttpError('chunk validation failed', 500, { fileName: sourceMeta.fileName, chunkIndex: plan.chunkIndex + 1, chunkCount: plan.chunkCount, strategy: fallbackChunk.strategy, extension: fallbackChunk.extension, format: fallbackChunk.extension, originalMimeType: fallbackChunk.originalMimeType, normalizedMimeType: fallbackChunk.mimeType, validationErrors: fallbackChunk.validationErrors });
    }
    logEvent('info', 'fallback wav upload started', { ...context, ...buildChunkLogMeta(sourceMeta, fallbackChunk) });
    try {
      const result = await uploadChunk(env, fallbackChunk, languageHint);
      logEvent('info', 'fallback wav upload succeeded', { ...context, fileName: sourceMeta.fileName, chunkIndex: plan.chunkIndex + 1, chunkCount: plan.chunkCount });
      return result;
    } catch (fallbackError) {
      logEvent('error', 'fallback wav upload failed', { ...context, fileName: sourceMeta.fileName, chunkIndex: plan.chunkIndex + 1, chunkCount: plan.chunkCount, details: fallbackError instanceof HttpError ? fallbackError.details : fallbackError });
      throw fallbackError;
    }
  }
}

export function buildChunkLogMeta(sourceMeta: SourceAudioMetadata, chunk: PreparedTranscriptionChunk): Record<string, unknown> {
  return {
    sourceFileName: sourceMeta.fileName,
    sourceDurationSec: sourceMeta.durationSec,
    sourceBytes: sourceMeta.bytes,
    chunkIndex: chunk.chunkIndex + 1,
    chunkCount: chunk.chunkCount,
    startOffsetMs: chunk.startOffsetMs,
    estimatedDurationSec: chunk.estimatedDurationSec,
    bytes: chunk.bytes,
    extension: chunk.extension,
    mimeType: chunk.mimeType,
    originalMimeType: chunk.originalMimeType,
    codec: chunk.codec,
    container: chunk.container,
    sampleRate: chunk.sampleRate,
    channels: chunk.channels,
    strategy: chunk.strategy,
    validationPassed: chunk.validationPassed,
  };
}

export async function transcribeWithDiarization(env: Env, audio: Blob, fileName: string, languageHint?: string, deps: { chunkGenerator?: AudioChunkGenerator; uploadChunk?: UploadChunkFn; recordingId?: string; dropboxFileId?: string; dropboxPathLower?: string } = {}): Promise<TranscriptResult> {
  const chunkGenerator = deps.chunkGenerator ?? defaultChunkGenerator;
  const uploadChunk = deps.uploadChunk ?? uploadPreparedChunk;

  let sourceMeta: SourceAudioMetadata;
  try {
    sourceMeta = await inspectAudioSource(audio, fileName);
  } catch (error) {
    logEvent('error', 'source inspection failed', { recordingId: deps.recordingId, fileName, dropboxFileId: deps.dropboxFileId, dropboxPathLower: deps.dropboxPathLower, details: error instanceof Error ? error.message : error });
    throw new HttpError('source file inspection failed', 500, { fileName, cause: error instanceof Error ? error.message : error });
  }

  let plan: ChunkPlan;
  try {
    plan = createChunkPlan(sourceMeta.durationSec, sourceMeta.bytes);
  } catch (error) {
    logEvent('error', 'chunk generation failed', { recordingId: deps.recordingId, fileName, dropboxFileId: deps.dropboxFileId, dropboxPathLower: deps.dropboxPathLower, details: error instanceof Error ? error.message : error });
    throw new HttpError('chunk plan creation failed', 500, { fileName, cause: error instanceof Error ? error.message : error });
  }

  const context = { recordingId: deps.recordingId, fileName, dropboxFileId: deps.dropboxFileId, dropboxPathLower: deps.dropboxPathLower };
  logEvent('info', 'openai.transcription.plan', { ...context, sourceDurationSec: sourceMeta.durationSec, sourceBytes: sourceMeta.bytes, chunkCount: plan.entries.length, targetChunkDurationSec: TARGET_CHUNK_DURATION_SEC, maxModelDurationSec: MAX_TRANSCRIBE_DURATION_SEC, primaryAudioFormat: PRIMARY_AUDIO_FORMAT, fallbackAudioFormat: FALLBACK_AUDIO_FORMAT });

  if (!plan.requiresSplit) {
    const chunk = await validateChunk({ blob: audio, fileName, extension: sourceMeta.extension || extensionForFileName(fileName), mimeType: sourceMeta.mimeType, originalMimeType: sourceMeta.originalMimeType ?? sourceMeta.mimeType, bytes: sourceMeta.bytes, codec: sourceMeta.codec, container: sourceMeta.container, sampleRate: sourceMeta.sampleRate, channels: sourceMeta.channels, estimatedDurationSec: sourceMeta.durationSec ?? 0, actualDurationSec: sourceMeta.durationSec, strategy: 'single-original', validationPassed: false, validationErrors: [], chunkIndex: 0, chunkCount: 1, startOffsetMs: 0, endOffsetMs: Math.round((sourceMeta.durationSec ?? 0) * 1000) });
    if (!chunk.validationPassed) {
      logEvent('error', 'chunk validation failed', { ...context, chunkIndex: 1, chunkCount: 1, strategy: chunk.strategy, extension: chunk.extension, originalMimeType: chunk.originalMimeType, normalizedMimeType: chunk.mimeType, validationErrors: chunk.validationErrors });
      throw new HttpError('chunk validation failed', 500, { fileName, chunkIndex: 1, chunkCount: 1, strategy: chunk.strategy, extension: chunk.extension, format: chunk.extension, originalMimeType: chunk.originalMimeType, normalizedMimeType: chunk.mimeType, validationErrors: chunk.validationErrors });
    }
    logEvent('info', 'openai.transcription.chunk', { ...context, ...buildChunkLogMeta(sourceMeta, chunk) });
    return uploadChunk(env, chunk, languageHint);
  }

  const results: TranscriptResult[] = [];
  let accumulatedOffsetMs = 0;
  for (const entry of plan.entries) {
    try {
      const result = await transcribeChunkWithFallback(env, audio, sourceMeta, entry, languageHint, chunkGenerator, uploadChunk, context);
      const baseOffset = accumulatedOffsetMs || entry.startOffsetMs;
      results.push(applyOffsetToTranscript(result, baseOffset));
      accumulatedOffsetMs = baseOffset + getChunkDurationMs(result, entry.estimatedDurationSec);
    } catch (error) {
      const details = error instanceof HttpError ? error.details : error instanceof Error ? error.message : error;
      logEvent('error', 'OpenAI 4xx/5xx', { ...context, chunkIndex: entry.chunkIndex + 1, chunkCount: entry.chunkCount, details });
      throw new HttpError('Transcription request failed.', 502, { fileName, chunkIndex: entry.chunkIndex + 1, chunkCount: entry.chunkCount, sourceDurationSec: sourceMeta.durationSec, sourceBytes: sourceMeta.bytes, cause: details });
    }
  }

  try {
    return mergeTranscriptResults(results);
  } catch (error) {
    logEvent('error', 'transcript merge failed', { ...context, details: error instanceof Error ? error.message : error });
    throw new HttpError('transcription merge failed', 500, { fileName, cause: error instanceof Error ? error.message : error });
  }
}

export async function summarizeInterview(env: Env, transcript: TranscriptResult): Promise<InterviewInsights> {
  let response: Response;
  try {
    response = await fetch(`${OPENAI_API}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.OPENAI_MODEL_SUMMARIZE ?? 'gpt-4.1-mini', input: [{ role: 'system', content: [{ type: 'input_text', text: [
            'あなたは面談メモ作成アシスタントです。',
            '回答は文字起こし(transcript)に含まれる情報のみを根拠にし、事実と未確認事項を明確に分けてください。',
            'JSONは summary, myTasks, otherTasks, ambiguities の4キーだけを返してください。',
            'myTasks と otherTasks は既存仕様どおり文字列配列で作成し、担当不明なタスクは推測せず ambiguities に書いてください。',
            'summary は単なる説明文ではなく、面談後にそのまま使える業務用の「面談メモ」形式で日本語出力してください。',
            'summary の先頭は必ず「【面談メモ｜{面談テーマを短く推定}】」とし、続けて次の見出しをこの順番・表記で必ず含めてください: 「■ 面談テーマ」「■ 確認できた内容」「■ 重要な発言・示唆」「■ 未確認事項」「■ 次アクション」。',
            '「会話では〜について話されています」のような説明文は禁止です。',
            '「〜と思われます」「〜かもしれません」の多用は禁止です。根拠のない断定も禁止です。',
            '確認できた内容は箇条書きで、工程・部署・製品・設備・論点などの単位で整理してください。',
            '未確認事項には会話だけでは断定できない点を列挙し、判断材料がなければ「不明」と明記してください。',
            '次アクションは確認・調査・整理など具体的な動詞で記述してください。',
            'transcript にない内容を補完しないでください。',
            '人名・会社名・設備名・数値が出てきた場合は、可能な限り落とさず summary に含めてください。',
            'summary 全体の分量は800〜1,500字程度にしてください。',
          ].join(' ') }] }, { role: 'user', content: [{ type: 'input_text', text: transcript.fullText }] }], text: { format: { type: 'json_schema', name: 'interview_insights', schema: { type: 'object', additionalProperties: false, required: ['summary', 'myTasks', 'otherTasks', 'ambiguities'], properties: { summary: { type: 'string' }, myTasks: { type: 'array', items: { type: 'string' } }, otherTasks: { type: 'array', items: { type: 'string' } }, ambiguities: { type: 'array', items: { type: 'string' } } } } } } }),
    });
  } catch (error) {
    logEvent('error', 'summary request failed', { details: error instanceof Error ? error.message : error });
    throw new HttpError('Summary request failed.', 502, { cause: error instanceof Error ? error.message : error });
  }
  if (!response.ok) {
    const responseText = await readResponseTextSafely(response);
    logEvent('error', 'summary request failed', { responseStatus: response.status, responseTextPreview: responseText.slice(0, 300) });
    throw new HttpError('Summary generation failed.', 502, { responseStatus: response.status, responseTextPreview: responseText.slice(0, 300) });
  }
  const payload = (await response.json()) as unknown;
  const summaryText = extractSummaryTextFromResponsesPayload(payload);
  if (!summaryText) {
    const payloadPreview = buildSummaryPayloadPreview(payload);
    logEvent('error', 'summary response text missing', payloadPreview);
    throw new HttpError('Summary response text missing.', 502, payloadPreview);
  }
  try {
    const parsed = JSON.parse(summaryText) as Omit<InterviewInsights, 'raw'>;
    return { ...parsed, raw: payload };
  } catch (error) {
    const details = { ...buildSummaryPayloadPreview(payload), summaryTextPreview: summaryText.slice(0, 400), parseMessage: error instanceof Error ? error.message : String(error) };
    logEvent('error', 'summary response parse failed', details);
    throw new HttpError('Summary response parse failed.', 502, details);
  }
}

type ResponsesOutputContent = { type?: string; text?: string };
type ResponsesOutputItem = { content?: ResponsesOutputContent[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildSummaryPayloadPreview(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return { payloadType: typeof payload };
  const output = Array.isArray(payload.output) ? payload.output : [];
  return {
    payloadKeys: Object.keys(payload).slice(0, 20),
    outputLength: output.length,
    firstOutputContentTypes: isRecord(output[0]) && Array.isArray(output[0].content)
      ? output[0].content.map((entry) => (isRecord(entry) && typeof entry.type === 'string' ? entry.type : typeof entry)).slice(0, 10)
      : [],
  };
}

export function extractSummaryTextFromResponsesPayload(payload: unknown): string | undefined {
  return extractOutputTextFromResponsesPayload(payload);
}

export function extractOutputTextFromResponsesPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  if (!Array.isArray(payload.output)) return undefined;

  for (const outputItem of payload.output as ResponsesOutputItem[]) {
    if (!outputItem || !Array.isArray(outputItem.content)) continue;
    for (const contentItem of outputItem.content) {
      if (contentItem?.type === 'output_text' && typeof contentItem.text === 'string' && contentItem.text.trim()) return contentItem.text;
    }
  }
  return undefined;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
}

function normalizeReviewResult(parsed: unknown): Omit<InterviewReviewResult, 'raw'> {
  const record = isRecord(parsed) ? parsed : {};
  return {
    finalMemoMarkdown: typeof record.finalMemoMarkdown === 'string' ? record.finalMemoMarkdown : '',
    correctedTermsMarkdown: typeof record.correctedTermsMarkdown === 'string' ? record.correctedTermsMarkdown : '',
    summaryForEmail: typeof record.summaryForEmail === 'string' ? record.summaryForEmail : '',
    uncertainItemsMarkdown: typeof record.uncertainItemsMarkdown === 'string' ? record.uncertainItemsMarkdown : '',
    nextActionsMarkdown: typeof record.nextActionsMarkdown === 'string' ? record.nextActionsMarkdown : '',
    humanCheckRequired: record.humanCheckRequired === true,
    humanCheckReason: typeof record.humanCheckReason === 'string' ? record.humanCheckReason : '',
    myTasks: normalizeStringArray(record.myTasks),
    otherTasks: normalizeStringArray(record.otherTasks),
    sourceUrls: normalizeStringArray(record.sourceUrls),
  };
}

export async function reviewInterviewWithWebSearch(
  env: Env,
  input: {
    transcript: TranscriptResult;
    insights?: InterviewInsights;
    title?: string;
    fileName?: string;
    notionPageUrl?: string;
  },
): Promise<InterviewReviewResult> {
  const model = env.OPENAI_MODEL_REVIEW ?? env.OPENAI_MODEL_SUMMARIZE ?? 'gpt-5.4-mini';
  const webSearchEnabled = env.INTERVIEW_REVIEW_WEB_SEARCH_ENABLED?.toLowerCase() !== 'false';

  const tools = webSearchEnabled ? [{ type: 'web_search_preview' as const }] : [];
  let response: Response;
  try {
    response = await fetch(`${OPENAI_API}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        tools,
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: [
                'あなたは面談メモの二次レビュー担当です。',
                'Transcriptと一次要約を読み、必要に応じてWeb検索で固有名詞・会社名・人物名・略称を確認してください。',
                '不明な事項を推測で埋めてはいけません。',
                '事実、推測、提案を分けて明記してください。',
                '金額、株式比率、株主間協定、契約条件、会計処理、法務論点は断定しないでください。',
                'correctedTermsMarkdown には「文字起こし上の表記 / 推定される正確な表記 / 確度 / 根拠」を必ず含めてください。',
                '確度は「高 / 中 / 低 / 不明」の4段階のみを使ってください。',
                'Web検索で断定できないものは「不明」と書いてください。',
                'sourceUrls には根拠URLのみを入れてください。根拠がなければ空配列でよいです。',
                'myTasks / otherTasks は二次レビュー結果を優先してください。ただし担当者不明を勝手にmyTasksへ入れないでください。',
                'humanCheckRequired は次の場合 true: 確度が低または不明を含む、金額/株式比率/株主間協定/会計/法務論点がある、誤変換が多い、Web検索とTranscriptが矛盾しうる、sourceUrls空かつ固有名詞補正あり。',
                'finalMemoMarkdown は以下のプレーンテキスト構成を厳守: 「完成版 面談メモ」「補足説明」の2部構成。',
                '完成版 面談メモは社内共有用の報告調。体言止め中心。説明調・解説調・外部資料検証調を避ける。',
                '完成版 面談メモには URL・Markdown記号（#, ##, ###, **, [text](url), ```）を含めない。',
                '完成版 面談メモは「1. 面談の主題 2. 確認事項 3. 主要論点 4. 示唆 5. 次アクション」の順。',
                '補足説明は「1. 要確認事項 2. 聞き取り不明語 3. 外部資料で確認した内容 4. 参考リンク」の順。',
                '不明事項・聞き取り不明語・外部確認事項・リンクは補足説明へ分離し、完成版に混在させない。',
                '既知用語の一般説明は不要。',
                'nextActionsMarkdown は箇条書きのみ。各行先頭は「・」。URLやMarkdown記号を含めない。',
                'summaryForEmail は「完成版 面談メモ」の要点のみ。補足説明やリンクを含めない。',
              ].join(' '),
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'input_text',
              text: JSON.stringify({
                title: input.title ?? '',
                fileName: input.fileName ?? '',
                notionPageUrl: input.notionPageUrl ?? '',
                transcript: input.transcript.fullText,
                primarySummary: input.insights?.summary ?? '',
                primaryMyTasks: input.insights?.myTasks ?? [],
                primaryOtherTasks: input.insights?.otherTasks ?? [],
                primaryAmbiguities: input.insights?.ambiguities ?? [],
              }),
            }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'interview_review_result',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'finalMemoMarkdown',
                'correctedTermsMarkdown',
                'summaryForEmail',
                'uncertainItemsMarkdown',
                'nextActionsMarkdown',
                'humanCheckRequired',
                'humanCheckReason',
                'myTasks',
                'otherTasks',
                'sourceUrls',
              ],
              properties: {
                finalMemoMarkdown: { type: 'string' },
                correctedTermsMarkdown: { type: 'string' },
                summaryForEmail: { type: 'string' },
                uncertainItemsMarkdown: { type: 'string' },
                nextActionsMarkdown: { type: 'string' },
                humanCheckRequired: { type: 'boolean' },
                humanCheckReason: { type: 'string' },
                myTasks: { type: 'array', items: { type: 'string' } },
                otherTasks: { type: 'array', items: { type: 'string' } },
                sourceUrls: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      }),
    });
  } catch (error) {
    logEvent('error', 'review request failed', { details: error instanceof Error ? error.message : error });
    throw new HttpError('Interview review request failed.', 502, { cause: error instanceof Error ? error.message : error });
  }

  if (!response.ok) {
    const responseText = await readResponseTextSafely(response);
    logEvent('error', 'review request failed', { responseStatus: response.status, responseTextPreview: responseText.slice(0, 300) });
    throw new HttpError('Interview review failed.', 502, { responseStatus: response.status, responseTextPreview: responseText.slice(0, 300) });
  }

  const payload = (await response.json()) as unknown;
  const outputText = extractOutputTextFromResponsesPayload(payload);
  if (!outputText) {
    const payloadPreview = buildSummaryPayloadPreview(payload);
    logEvent('error', 'review response text missing', payloadPreview);
    throw new HttpError('Interview review response text missing.', 502, payloadPreview);
  }

  try {
    const parsed = JSON.parse(outputText);
    return { ...normalizeReviewResult(parsed), raw: payload };
  } catch (error) {
    const details = {
      ...buildSummaryPayloadPreview(payload),
      reviewTextPreview: outputText.slice(0, 400),
      parseMessage: error instanceof Error ? error.message : String(error),
    };
    logEvent('error', 'review response parse failed', details);
    throw new HttpError('Interview review response parse failed.', 502, details);
  }
}
