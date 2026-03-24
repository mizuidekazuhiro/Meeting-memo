import type { DropboxFileMetadata, Env, IntakeRequest, ProcessInterviewResult, RecordingJob, RecordingJobCallbackPayload } from '../types';
import { buildDedupCandidates } from './dedup';
import { downloadDropboxFile } from './dropbox';
import { HttpError } from './http';
import { getRecordingJob, markJobFailed, updateRecordingJobStatus } from './jobs';
import { logEvent } from './logger';
import { upsertInterviewFromTranscript } from './notion';
import { inspectAudioSource, MAX_TRANSCRIBE_DURATION_SEC, transcribeWithDiarization } from './openai';

export function shouldAttemptDirectWorkerTranscription(metadata: DropboxFileMetadata, durationSec: number | undefined): boolean {
  const extension = metadata.name.includes('.') ? metadata.name.split('.').pop()?.toLowerCase() : '';
  if (durationSec !== undefined && durationSec > MAX_TRANSCRIBE_DURATION_SEC) return false;
  if (extension === 'wav') return true;
  return durationSec !== undefined && durationSec <= MAX_TRANSCRIBE_DURATION_SEC;
}

export async function dispatchLongAudioJob(env: Env, job: RecordingJob, metadata: DropboxFileMetadata): Promise<void> {
  if (!env.PYTHON_TRANSCRIBE_API_URL) throw new HttpError('Python transcribe API URL is not configured.', 500);
  logEvent('info', 'python service dispatch started', {
    recordingId: job.recordingId,
    fileName: job.fileName,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: job.dropboxPathLower,
    details: { dispatchUrl: env.PYTHON_TRANSCRIBE_API_URL },
  });

  const response = await fetch(`${env.PYTHON_TRANSCRIBE_API_URL.replace(/\/$/, '')}/jobs/transcribe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.PYTHON_TRANSCRIBE_API_TOKEN ?? ''}`,
    },
    body: JSON.stringify({
      recordingId: job.recordingId,
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      fileName: metadata.name,
      sourceBytes: metadata.size,
      client_modified: metadata.client_modified,
      server_modified: metadata.server_modified,
      request: job.request,
      callbackUrl: env.WORKERS_CALLBACK_BASE_URL ? `${env.WORKERS_CALLBACK_BASE_URL}/api/interviews/transcription-callback` : undefined,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    logEvent('error', 'python service dispatch failed', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: { responseStatus: response.status, responseText },
    });
    throw new HttpError('Python API dispatch failed.', 502, { responseStatus: response.status, responseText });
  }
}

export async function processUploadedInterview(env: Env, request: IntakeRequest, metadata: DropboxFileMetadata, job: RecordingJob, options: { dryRun?: boolean } = {}): Promise<ProcessInterviewResult> {
  const dedupCandidates = buildDedupCandidates(request, metadata);
  if (options.dryRun) {
    return { action: 'processed', reason: 'Dry run: job created from Dropbox upload metadata.', dedupCandidates, record: undefined };
  }

  let audio: Blob | undefined;
  let durationSec = job.sourceDurationSec;
  try {
    audio = await downloadDropboxFile(env, metadata);
    const inspected = await inspectAudioSource(audio, metadata.name);
    durationSec = inspected.durationSec;
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'queued', { sourceDurationSec: durationSec, sourceBytes: inspected.bytes });

    if (shouldAttemptDirectWorkerTranscription(metadata, durationSec)) {
      await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribing');
      const transcript = await transcribeWithDiarization(env, audio, metadata.name, request.languageHint, {
        recordingId: job.recordingId,
        dropboxFileId: job.dropboxFileId,
        dropboxPathLower: job.dropboxPathLower,
      });
      await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribed', { transcript });
      const persisted = await upsertInterviewFromTranscript(env, request, metadata, transcript);
      await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'persisted');
      return {
        action: 'processed',
        reason: 'Processed in Workers and persisted to Notion.',
        pageId: persisted.pageId,
        created: persisted.created,
        dedupCandidates,
        record: persisted.record,
      };
    }

    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcoding', { sourceDurationSec: durationSec });
    await dispatchLongAudioJob(env, job, metadata);
    return { action: 'processed', reason: 'Long audio delegated to Python transcription API service.', dedupCandidates };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown processing error';
    await markJobFailed(env, { recordingId: job.recordingId }, message);
    logEvent('error', 'processing pipeline failed', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: error instanceof HttpError ? error.details : message,
    });
    if (error instanceof HttpError) throw error;
    throw new HttpError(message, 500, error);
  }
}

export async function persistTranscriptionCallback(env: Env, payload: RecordingJobCallbackPayload): Promise<ProcessInterviewResult> {
  const job = await getRecordingJob(env, { recordingId: payload.recordingId, dropboxFileId: payload.dropboxFileId });
  if (!job) throw new HttpError('Recording job not found for callback.', 404, payload);
  const metadata: DropboxFileMetadata = {
    id: payload.dropboxFileId,
    path_lower: payload.dropboxPathLower,
    name: payload.fileName,
    size: job.sourceBytes,
    client_modified: job.clientModified,
    server_modified: job.serverModified,
  };
  try {
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribed', {
      transcript: payload.transcript,
      sourceDurationSec: payload.sourceDurationSec,
    });
    const persisted = await upsertInterviewFromTranscript(env, job.request, metadata, payload.transcript);
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'persisted');
    return {
      action: 'processed',
      reason: 'Python API callback persisted to Notion.',
      pageId: persisted.pageId,
      created: persisted.created,
      dedupCandidates: buildDedupCandidates(job.request, metadata),
      record: persisted.record,
    };
  } catch (error) {
    await markJobFailed(env, { recordingId: job.recordingId }, error instanceof Error ? error.message : 'callback failed');
    logEvent('error', 'callback failed', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: error instanceof HttpError ? error.details : error,
    });
    throw error;
  }
}
