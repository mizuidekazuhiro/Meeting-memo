import type { Env, InterviewInsights, TranscriptResult, TranscriptSegment } from '../types';
import { HttpError } from './http';

const OPENAI_API = 'https://api.openai.com/v1';
const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
const MP4_BOX_HEADER_BYTES = 8;

type OpenAiVerboseTranscript = {
  text?: string;
  segments?: Array<{ speaker?: string; start?: number; end?: number; text?: string }>;
};

type TranscriptionChunk = {
  blob: Blob;
  fileName: string;
  startOffsetMs: number;
  strategy: 'single' | 'blob-slice' | 'mp4-rewrapped';
};

function mapTranscriptPayload(payload: OpenAiVerboseTranscript): TranscriptResult {
  const segments = (payload.segments ?? []).map((segment) => ({
    speaker: segment.speaker ?? 'speaker_unknown',
    startMs: segment.start !== undefined ? Math.round(segment.start * 1000) : undefined,
    endMs: segment.end !== undefined ? Math.round(segment.end * 1000) : undefined,
    text: segment.text ?? '',
  }));

  return {
    fullText: payload.text ?? segments.map((segment) => `[${segment.speaker}] ${segment.text}`).join('\n'),
    segments,
    raw: payload,
  };
}

async function transcribeChunk(env: Env, audio: Blob, fileName: string, languageHint?: string): Promise<TranscriptResult> {
  const form = new FormData();
  form.append('file', audio, fileName);
  form.append('model', env.OPENAI_MODEL_TRANSCRIBE ?? 'gpt-4o-transcribe');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (languageHint) form.append('language', languageHint);
  form.append('prompt', 'Create a diarized transcript. Label speakers consistently as speaker_1, speaker_2, etc.');

  const response = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!response.ok) {
    throw new HttpError('Transcription request failed.', 502, await response.text());
  }

  return mapTranscriptPayload((await response.json()) as OpenAiVerboseTranscript);
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

function readMp4TopLevelBoxes(bytes: Uint8Array): Array<{ type: string; start: number; end: number }> {
  const boxes: Array<{ type: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset + MP4_BOX_HEADER_BYTES <= bytes.byteLength) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const typeBytes = bytes.slice(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    if (!size || offset + size > bytes.byteLength) break;
    boxes.push({ type, start: offset, end: offset + size });
    offset += size;
  }
  return boxes;
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

  const chunks: TranscriptionChunk[] = [];
  let offset = 0;
  while (offset < mdatPayload.byteLength) {
    const payloadSlice = mdatPayload.slice(offset, Math.min(offset + maxPayloadBytes, mdatPayload.byteLength));
    const mdatHeader = new Uint8Array(MP4_BOX_HEADER_BYTES);
    new DataView(mdatHeader.buffer).setUint32(0, payloadSlice.byteLength + MP4_BOX_HEADER_BYTES);
    mdatHeader.set(new TextEncoder().encode('mdat'), 4);
    const chunkBytes = concatUint8Arrays([header, mdatHeader, payloadSlice]);
    const chunkBlobBytes = new Uint8Array(chunkBytes.byteLength);
    chunkBlobBytes.set(chunkBytes);
    chunks.push({
      blob: new Blob([chunkBlobBytes], { type: audio.type || 'audio/mp4' }),
      fileName: fileNameForChunk(fileName, chunks.length),
      startOffsetMs: 0,
      strategy: 'mp4-rewrapped',
    });
    offset += payloadSlice.byteLength;
  }

  return chunks;
}

function splitBlobByByteBudget(audio: Blob, fileName: string): TranscriptionChunk[] {
  const chunks: TranscriptionChunk[] = [];
  let offset = 0;
  while (offset < audio.size) {
    const chunk = audio.slice(offset, Math.min(offset + MAX_TRANSCRIPTION_BYTES, audio.size), audio.type);
    chunks.push({
      blob: chunk,
      fileName: fileNameForChunk(fileName, chunks.length),
      startOffsetMs: 0,
      strategy: 'blob-slice',
    });
    offset += chunk.size;
  }
  return chunks;
}

async function buildTranscriptionChunks(audio: Blob, fileName: string): Promise<TranscriptionChunk[]> {
  if (audio.size <= MAX_TRANSCRIPTION_BYTES) {
    return [{ blob: audio, fileName, startOffsetMs: 0, strategy: 'single' }];
  }

  const extension = extensionForFileName(fileName);
  if (extension === '.m4a' || extension === '.mp4') {
    const mp4Chunks = await splitMp4AudioBlob(audio, fileName);
    if (mp4Chunks?.length) return mp4Chunks;
  }

  return splitBlobByByteBudget(audio, fileName);
}

function mergeTranscriptResults(results: TranscriptResult[]): TranscriptResult {
  const segments: TranscriptSegment[] = [];
  const texts: string[] = [];
  for (const result of results) {
    texts.push(result.fullText.trim());
    segments.push(...result.segments);
  }

  return {
    fullText: texts.filter(Boolean).join('\n\n').trim(),
    segments,
    raw: results.map((result) => result.raw),
  };
}

export async function transcribeWithDiarization(env: Env, audio: Blob, fileName: string, languageHint?: string): Promise<TranscriptResult> {
  const chunks = await buildTranscriptionChunks(audio, fileName);
  const results: TranscriptResult[] = [];

  for (const [index, chunk] of chunks.entries()) {
    try {
      console.log('openai.transcription.chunk', {
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        fileName: chunk.fileName,
        bytes: chunk.blob.size,
        strategy: chunk.strategy,
      });
      const result = await transcribeChunk(env, chunk.blob, chunk.fileName, languageHint);
      results.push({
        ...result,
        segments: result.segments.map((segment) => ({
          ...segment,
          startMs: segment.startMs !== undefined ? segment.startMs + chunk.startOffsetMs : undefined,
          endMs: segment.endMs !== undefined ? segment.endMs + chunk.startOffsetMs : undefined,
        })),
      });
    } catch (error) {
      throw new HttpError('Transcription request failed.', 502, {
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        fileName: chunk.fileName,
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
    throw new HttpError('Summary generation failed.', 502, await response.text());
  }

  const payload = (await response.json()) as { output_text?: string };
  if (!payload.output_text) {
    throw new HttpError('Summary response did not include output_text.', 502, payload);
  }
  const parsed = JSON.parse(payload.output_text) as Omit<InterviewInsights, 'raw'>;
  return { ...parsed, raw: payload };
}
