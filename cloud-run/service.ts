import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FALLBACK_AUDIO_FORMAT, PRIMARY_AUDIO_FORMAT, createChunkPlan, validateChunk } from '../src/lib/openai.js';
import { mergeTranscriptResultsInOrder } from '../src/lib/cloud-run-plan.js';
import type { RecordingJobCallbackPayload, TranscriptResult } from '../src/types.js';

export type CloudRunInput = {
  recordingId: string;
  dropboxFileId: string;
  dropboxPathLower?: string;
  fileName: string;
  sourceBytes?: number;
  callbackUrl?: string;
  request?: { languageHint?: string };
};

export type FfprobeMetadata = {
  durationSec: number;
  codec: string;
  sampleRate?: number;
  channels?: number;
  container: string;
};

export type CloudRunDeps = {
  fetchDropboxFile: (input: CloudRunInput) => Promise<Uint8Array>;
  ffprobe: (filePath: string) => Promise<FfprobeMetadata>;
  ffmpegChunk: (inputFile: string, outputFile: string, startOffsetSec: number, durationSec: number, format: 'm4a' | 'wav') => Promise<void>;
  transcribeChunk: (filePath: string, meta: { chunkIndex: number; chunkCount: number; languageHint?: string }) => Promise<TranscriptResult>;
  callback: (payload: RecordingJobCallbackPayload) => Promise<void>;
};

export async function processCloudRunJob(input: CloudRunInput, deps: CloudRunDeps): Promise<RecordingJobCallbackPayload> {
  const tempDir = await mkdtemp(join(tmpdir(), 'meeting-memo-'));
  const sourceFile = join(tempDir, input.fileName);
  try {
    const sourceBytes = await deps.fetchDropboxFile(input);
    await writeFile(sourceFile, sourceBytes);
    const sourceMeta = await deps.ffprobe(sourceFile);
    const plan = createChunkPlan(sourceMeta.durationSec, input.sourceBytes ?? sourceBytes.byteLength);
    const results: Array<{ chunkIndex: number; startOffsetMs: number; transcript: TranscriptResult }> = [];

    for (const entry of plan.entries) {
      let lastError: unknown;
      for (const format of [PRIMARY_AUDIO_FORMAT, FALLBACK_AUDIO_FORMAT] as const) {
        const outputFile = join(tempDir, `chunk-${String(entry.chunkIndex + 1).padStart(3, '0')}.${format}`);
        try {
          await deps.ffmpegChunk(sourceFile, outputFile, entry.startOffsetMs / 1000, entry.estimatedDurationSec, format);
          const outputBytes = await readFile(outputFile);
          const validated = validateChunk({
            blob: new Blob([outputBytes], { type: format === 'm4a' ? 'audio/mp4' : 'audio/wav' }),
            fileName: outputFile.split('/').pop()!,
            extension: format === 'm4a' ? '.m4a' : '.wav',
            mimeType: format === 'm4a' ? 'audio/mp4' : 'audio/wav',
            bytes: outputBytes.byteLength,
            codec: format === 'm4a' ? 'aac-lc' : 'pcm_s16le',
            container: format,
            sampleRate: sourceMeta.sampleRate,
            channels: sourceMeta.channels,
            estimatedDurationSec: entry.estimatedDurationSec,
            actualDurationSec: entry.estimatedDurationSec,
            strategy: format === 'm4a' ? 'reencoded-aac-m4a' : 'fallback-pcm-wav',
            validationPassed: false,
            validationErrors: [],
            chunkIndex: entry.chunkIndex,
            chunkCount: entry.chunkCount,
            startOffsetMs: entry.startOffsetMs,
            endOffsetMs: entry.endOffsetMs,
          });
          if (!validated.validationPassed) throw new Error(`chunk validation failed: ${validated.validationErrors.join(', ')}`);
          const transcript = await deps.transcribeChunk(outputFile, { chunkIndex: entry.chunkIndex, chunkCount: entry.chunkCount, languageHint: input.request?.languageHint });
          results.push({ chunkIndex: entry.chunkIndex, startOffsetMs: entry.startOffsetMs, transcript });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (format === FALLBACK_AUDIO_FORMAT) throw error;
        }
      }
      if (lastError) throw lastError;
    }

    const mergedTranscript = mergeTranscriptResultsInOrder(results);
    const payload: RecordingJobCallbackPayload = {
      recordingId: input.recordingId,
      dropboxFileId: input.dropboxFileId,
      dropboxPathLower: input.dropboxPathLower,
      fileName: input.fileName,
      sourceDurationSec: sourceMeta.durationSec,
      transcript: mergedTranscript,
    };
    await deps.callback(payload);
    return payload;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function createFfprobeCommand(filePath: string): Promise<FfprobeMetadata> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', filePath]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr}`));
      const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }> };
      const stream = parsed.streams?.[0] ?? {};
      resolve({ durationSec: Number(parsed.format?.duration ?? 0), codec: stream.codec_name ?? 'unknown', sampleRate: stream.sample_rate ? Number(stream.sample_rate) : undefined, channels: stream.channels, container: inputContainer(filePath) });
    });
  });
}

function inputContainer(filePath: string): string {
  if (filePath.endsWith('.m4a')) return 'm4a';
  if (filePath.endsWith('.wav')) return 'wav';
  return 'unknown';
}
