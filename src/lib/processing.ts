import type { DropboxFileMetadata, Env, IntakeRequest, ProcessInterviewResult, RecordingJob, RecordingJobCallbackPayload } from '../types';
import { buildDedupCandidates } from './dedup';
import { downloadDropboxFile } from './dropbox';
import { HttpError } from './http';
import { findRecordingJobWithSource, markJobFailed, updateRecordingJobStatus } from './jobs';
import { logEvent } from './logger';
import { upsertInterviewFromTranscript } from './notion';
import { inspectAudioSource, MAX_TRANSCRIBE_DURATION_SEC, transcribeWithDiarization } from './openai';

export function shouldAttemptDirectWorkerTranscription(metadata: DropboxFileMetadata, durationSec: number | undefined): boolean {
  const extension = metadata.name.includes('.') ? metadata.name.split('.').pop()?.toLowerCase() : '';
  if (durationSec !== undefined && durationSec > MAX_TRANSCRIBE_DURATION_SEC) return false;
  if (extension === 'wav') return true;
  return durationSec !== undefined && durationSec <= MAX_TRANSCRIBE_DURATION_SEC;
}

function resolvePythonTranscribeDispatchUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    throw new HttpError(
      'Python transcribe API URL is not configured. Set PYTHON_TRANSCRIBE_API_URL to the base URL of the Python service, for example https://your-service.example.com',
      500,
    );
  }
  const normalized = baseUrl.trim().replace(/\/$/, '');
  if (!normalized) {
    throw new HttpError(
      'Python transcribe API URL is not configured. Set PYTHON_TRANSCRIBE_API_URL to the base URL of the Python service, for example https://your-service.example.com',
      500,
    );
  }
  return `${normalized}/jobs/transcribe`;
}

export async function dispatchLongAudioJob(env: Env, job: RecordingJob, metadata: DropboxFileMetadata): Promise<void> {
  const dispatchUrl = resolvePythonTranscribeDispatchUrl(env.PYTHON_TRANSCRIBE_API_URL);
  const callbackUrl = env.WORKERS_CALLBACK_BASE_URL ? `${env.WORKERS_CALLBACK_BASE_URL}/api/interviews/transcription-callback` : undefined;

  logEvent('info', 'transcription dispatched', {
    recordingId: job.recordingId,
    callbackUrl,
    details: {
      dispatchUrl,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
    },
  });

  const response = await fetch(dispatchUrl, {
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
      sourceDurationSec: job.sourceDurationSec,
      client_modified: metadata.client_modified,
      server_modified: metadata.server_modified,
      request: job.request,
      callbackUrl,
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
  const recordingId = payload.recordingId?.trim();
  const dropboxFileId = payload.dropboxFileId?.trim();
  const dropboxPathLower = payload.dropboxPathLower?.trim().toLowerCase();
  const fileName = payload.fileName?.trim();

  logEvent('info', 'recording job lookup started', {
    event: 'recording job lookup started',
    recordingId: recordingId ?? null,
    dropboxFileId: dropboxFileId ?? null,
    dropboxPathLower: dropboxPathLower ?? null,
  });
  logEvent('info', 'recording job lookup tried', { triedBy: 'recordingId', recordingId: recordingId ?? null });
  logEvent('info', 'recording job lookup tried', { triedBy: 'dropboxFileId', dropboxFileId: dropboxFileId ?? null });
  logEvent('info', 'recording job lookup tried', { triedBy: 'dropboxPathLower', dropboxPathLower: dropboxPathLower ?? null });

  const lookup = await findRecordingJobWithSource(env, { recordingId, dropboxFileId, dropboxPathLower });
  const job = lookup.job;
  if (!job) {
    const transcriptPreview = payload.transcript?.fullText ? payload.transcript.fullText.slice(0, 512) : '';
    logEvent('error', 'recording job lookup not found', {
      event: 'recording job lookup not found',
      recordingId: recordingId ?? null,
      dropboxFileId: dropboxFileId ?? null,
      dropboxPathLower: dropboxPathLower ?? null,
      transcriptPreview,
      transcriptPreviewLength: transcriptPreview.length,
      transcriptSegmentCount: payload.transcript?.segments?.length ?? 0,
    });
    throw new HttpError('Recording job not found for callback.', 404, {
      phase: 'lookup_job',
      recordingId: recordingId ?? null,
      dropboxFileId: dropboxFileId ?? null,
      dropboxPathLower: dropboxPathLower ?? null,
    });
  }

  logEvent('info', 'recording job lookup hit', {
    foundBy: lookup.source,
    recordingId: job.recordingId,
    internalKey: `recordingJob:recordingId:${job.recordingId}`,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: job.dropboxPathLower,
  });

  if (job.status === 'persisted' && job.callbackStatus === 'persisted') {
    logEvent('info', 'callback duplicate ignored', {
      recordingId: job.recordingId,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      status: job.status,
    });
    return {
      action: 'processed',
      reason: 'Duplicate callback ignored because recording job is already persisted.',
      dedupCandidates: buildDedupCandidates(job.request, {
        id: job.dropboxFileId,
        path_lower: job.dropboxPathLower,
        name: job.fileName,
      }),
    };
  }

  const metadata: DropboxFileMetadata = {
    id: job.dropboxFileId,
    path_lower: job.dropboxPathLower ?? dropboxPathLower,
    name: job.fileName || fileName || 'unknown-audio',
    size: job.sourceBytes,
    client_modified: job.clientModified,
    server_modified: job.serverModified,
  };

  try {
    logEvent('info', 'callback phase started', { phase: 'persist_transcript', recordingId: job.recordingId });
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribed', {
      transcript: payload.transcript,
      sourceDurationSec: payload.sourceDurationSec,
      callbackStatus: 'received',
    });
    const persisted = await upsertInterviewFromTranscript(env, job.request, metadata, payload.transcript);

    logEvent('info', 'callback phase started', { phase: 'update_status', recordingId: job.recordingId });
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'persisted', {
      transcript: payload.transcript,
      sourceDurationSec: payload.sourceDurationSec,
      callbackStatus: 'persisted',
    });
    logEvent('info', 'recording job status updated', {
      recordingId: job.recordingId,
      status: 'persisted',
      callbackStatus: 'persisted',
    });

    return {
      action: 'processed',
      reason: 'Python API callback persisted to Notion.',
      pageId: persisted.pageId,
      created: persisted.created,
      dedupCandidates: buildDedupCandidates(job.request, metadata),
      record: persisted.record,
    };
  } catch (error) {
    await markJobFailed(env, { recordingId: job.recordingId }, error instanceof Error ? error.message : 'callback failed', { callbackStatus: 'failed' });
    logEvent('error', 'callback failed', {
      phase: error instanceof HttpError ? 'persist_transcript' : 'update_status',
      recordingId: job.recordingId,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: error instanceof HttpError ? error.details : error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
