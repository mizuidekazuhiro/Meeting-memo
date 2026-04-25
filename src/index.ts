import { buildIntakeRequestFromMetadata } from './lib/dedup';
import {
  debugDropboxAppFolderRoot,
  fetchDropboxMetadata,
  getDropboxCredentialStatus,
  isAudioDropboxFile,
  listAllDropboxEntries,
  uploadAudioToDropbox,
} from './lib/dropbox';
import { HttpError, jsonResponse, parseJson } from './lib/http';
import { processInterviewFromMetadata } from './lib/interviews';
import { createRecordingJob, findRecordingJobWithSource, getRecordingJob, getRecordingJobStorageMeta, normalizeDropboxPath, shouldSkipProcessingForExistingJob, upsertRecordingJob } from './lib/jobs';
import { logEvent } from './lib/logger';
import { updateRecordingJobStatus } from './lib/jobs';
import { finalizeInterviewJob, getInterviewJobStatus, persistTranscriptionCallback, processUploadedInterview, resendInterviewEmail } from './lib/processing';
import { requireWebhookSecret } from './lib/security';
import type { Env, FinalizeQueueMessage, IntakeRequest, RecordingJobCallbackPayload, ScanRequest, UploadRequestMetadata } from './types';

type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };
type QueueMessageLike<T> = { body: T; ack?: () => void; retry?: () => void; attempts?: number };
type QueueBatchLike<T> = { messages: Array<QueueMessageLike<T>> };

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

function parseLimit(value: number | undefined, envValue: string | undefined): number {
  if (value !== undefined) {
    if (!Number.isInteger(value) || value <= 0) throw new HttpError('limit must be a positive integer.', 400);
    return value;
  }
  if (!envValue) return 20;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError('INTERVIEW_SCAN_MAX_FILES must be a positive integer.', 500);
  return parsed;
}

function sortEntriesByServerModifiedDesc<T extends { server_modified?: string; path_lower?: string; name: string }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => {
    const leftTime = left.server_modified ? new Date(left.server_modified).valueOf() : 0;
    const rightTime = right.server_modified ? new Date(right.server_modified).valueOf() : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return (left.path_lower ?? left.name).localeCompare(right.path_lower ?? right.name);
  });
}

function sanitizeFileName(value: string): string {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || `interview-${new Date().toISOString().replace(/[.:]/g, '-')}.m4a`;
}

function parseJsonField<T>(value: FormDataEntryValue | null, fieldName: string): T | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new HttpError(`${fieldName} must be valid JSON.`, 400, error);
  }
}

function asString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildUploadRequest(form: FormData, file: File): IntakeRequest {
  const metadata = parseJsonField<UploadRequestMetadata>(form.get('metadata'), 'metadata') ?? {};
  const participants = parseJsonField<string[]>(form.get('participants'), 'participants') ?? metadata.participants;
  return {
    fileName: sanitizeFileName((asString(form.get('fileName')) ?? file.name) || ''),
    mimeType: file.type || asString(form.get('mimeType')) || 'application/octet-stream',
    recordedAt: asString(form.get('recordedAt')) ?? metadata.recordedAt,
    fileSizeBytes: file.size,
    idempotencyKey: asString(form.get('idempotencyKey')) ?? metadata.idempotencyKey,
    source: asString(form.get('source')) ?? metadata.source ?? 'Interview',
    initiatedBy: asString(form.get('initiatedBy')) ?? metadata.initiatedBy ?? 'iPhone Shortcut',
    participants,
    languageHint: asString(form.get('languageHint')) ?? metadata.languageHint,
    notes: asString(form.get('notes')) ?? metadata.notes,
  };
}

async function handleIntake(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const intake = await parseJson<IntakeRequest>(request);
  const metadata = await fetchDropboxMetadata(env, intake);
  const result = await processInterviewFromMetadata(env, intake, metadata);
  return jsonResponse({ ok: result.action === 'processed', status: result.record?.processingStatus ?? (result.action === 'skipped' ? 'skipped' : 'error'), created: result.created, pageId: result.pageId, dedupCandidates: result.dedupCandidates, errorMessage: result.record?.errorMessage, reason: result.reason });
}

async function parseOptionalScanRequest(request: Request): Promise<{ bodyText: string; scan: ScanRequest }> {
  const bodyText = await request.text();
  if (!bodyText.trim()) return { bodyText, scan: {} };
  try {
    return { bodyText, scan: JSON.parse(bodyText) as ScanRequest };
  } catch (error) {
    throw new HttpError('Request body must be valid JSON.', 400, error);
  }
}

async function handleScan(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { bodyText, scan } = await parseOptionalScanRequest(request);
  const dropboxCredentialStatus = getDropboxCredentialStatus(env);
  logEvent('info', 'interviews.scan.request', {
    path: url.pathname,
    method: request.method,
    requestBody: bodyText || null,
    hasWebhookSecret: Boolean(env.INTERVIEW_WEBHOOK_SECRET),
    hasDropboxAccessToken: dropboxCredentialStatus.hasDropboxAccessToken,
    hasDropboxAppKey: dropboxCredentialStatus.hasDropboxAppKey,
    hasDropboxAppSecret: dropboxCredentialStatus.hasDropboxAppSecret,
    hasDropboxRefreshToken: dropboxCredentialStatus.hasDropboxRefreshToken,
  });

  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const folderPath = scan.folderPath ?? env.DROPBOX_INTERVIEW_SCAN_FOLDER;
  if (!folderPath) throw new HttpError('folderPath is required when DROPBOX_INTERVIEW_SCAN_FOLDER is not configured.', 400);

  const recursive = scan.recursive ?? parseBooleanEnv(env.DROPBOX_INTERVIEW_SCAN_RECURSIVE, false);
  const limit = parseLimit(scan.limit, env.INTERVIEW_SCAN_MAX_FILES);
  const scannedEntries = await listAllDropboxEntries(env, folderPath, recursive);
  const audioEntries = sortEntriesByServerModifiedDesc(scannedEntries.filter(isAudioDropboxFile));
  const selectedEntries = audioEntries.slice(0, limit);

  const results: Array<{ pathLower?: string; dropboxFileId?: string; action: 'processed' | 'skipped'; reason: string }> = [];
  let processedCount = 0;
  let skippedCount = 0;
  for (const metadata of selectedEntries) {
    const intake = buildIntakeRequestFromMetadata(metadata);
    const existing = await getRecordingJob(env, { dropboxFileId: metadata.id, recordingId: metadata.id });
    if (existing) {
      skippedCount += 1;
      results.push({ pathLower: metadata.path_lower, dropboxFileId: metadata.id, action: 'skipped', reason: 'Supplemental scan only: file already known from upload metadata.' });
      continue;
    }
    processedCount += 1;
    results.push({ pathLower: metadata.path_lower, dropboxFileId: metadata.id, action: 'processed', reason: `Supplemental scan can requeue ${intake.fileName ?? metadata.name} for manual recovery.` });
  }

  return jsonResponse({ ok: true, folderPath, scannedCount: scannedEntries.length, audioCandidateCount: audioEntries.length, processedCount, skippedCount, errorCount: 0, dryRun: scan.dryRun ?? false, mode: 'supplemental-only', results });
}

async function handleUpload(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) throw new HttpError('Upload endpoint requires multipart/form-data.', 415);

  const form = await request.formData();
  const audioField = form.get('file') ?? form.get('audio');
  if (!(audioField instanceof File)) throw new HttpError('Upload failed: multipart field "file" (or "audio") is required.', 400);
  if (!audioField.type.startsWith('audio/')) throw new HttpError('Upload failed: only audio/* files are accepted.', 400, { mimeType: audioField.type || null });

  const intake = buildUploadRequest(form, audioField);
  const dryRun = asString(form.get('dryRun')) === 'true' || parseJsonField<boolean>(form.get('dryRunJson'), 'dryRunJson') === true;
  const requestId = request.headers.get('cf-ray') ?? request.headers.get('x-request-id') ?? crypto.randomUUID();
  const storageMeta = getRecordingJobStorageMeta(env);
  logEvent('info', 'interviews.upload.received', {
    requestId,
    fileName: intake.fileName,
    mimeType: intake.mimeType,
    bytes: audioField.size,
    recordedAt: intake.recordedAt,
    initiatedBy: intake.initiatedBy,
    dryRun,
    storageType: storageMeta.storageType,
    storageModeDecision: storageMeta.storageModeDecision,
  });

  let metadata;
  try {
    metadata = await uploadAudioToDropbox(env, audioField, intake.fileName ?? sanitizeFileName(audioField.name || ''));
  } catch (error) {
    logEvent('error', 'dropbox persistence failed', { fileName: intake.fileName, bytes: audioField.size, details: error instanceof HttpError ? error.details : error });
    throw new HttpError('Storage failed for uploaded audio.', 502, error instanceof HttpError ? error.details : error);
  }

  try {
    const requestWithDropbox: IntakeRequest = {
      ...intake,
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      fileName: metadata.name,
      mimeType: intake.mimeType,
      fileSizeBytes: metadata.size ?? intake.fileSizeBytes,
      recordedAt: intake.recordedAt ?? metadata.client_modified ?? metadata.server_modified,
    };
    const seededJob = createRecordingJob({ request: requestWithDropbox, dropboxFileId: metadata.id ?? '', dropboxPathLower: metadata.path_lower, fileName: metadata.name, sourceBytes: metadata.size ?? intake.fileSizeBytes, clientModified: metadata.client_modified, serverModified: metadata.server_modified });
    const dedupeLookup = {
      recordingId: seededJob.recordingId,
      dropboxFileId: seededJob.dropboxFileId,
      dropboxPathLower: seededJob.dropboxPathLower,
    };
    const existingLookup = await findRecordingJobWithSource(env, dedupeLookup);
    logEvent('info', 'upload dedupe lookup', {
      requestId,
      dedupeLookupKey: dedupeLookup,
      foundExistingJob: Boolean(existingLookup.job),
      existingStatus: existingLookup.job?.status ?? null,
      foundBy: existingLookup.source ?? null,
    });

    const { job, created } = await upsertRecordingJob(env, seededJob);
    const duplicateGate = existingLookup.job ? shouldSkipProcessingForExistingJob(existingLookup.job) : { shouldSkip: false };
    const normalizedDropboxPathLower = normalizeDropboxPath(metadata.path_lower);
    logEvent('info', 'recording job created', {
      event: 'recording job created',
      requestId,
      recordingId: job.recordingId,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      fileName: job.fileName,
      storageType: storageMeta.storageType,
      storageModeDecision: storageMeta.storageModeDecision,
      internalKey: `recordingJob:recordingId:${job.recordingId}`,
      indexKeyDropboxFileId: `recordingJob:index:dropboxFileId:${job.dropboxFileId}`,
      indexKeyDropboxPathLower: normalizedDropboxPathLower ? `recordingJob:index:dropboxPathLower:${normalizedDropboxPathLower}` : null,
      normalizedDropboxPathLower,
      created,
      dispatchExecuted: !duplicateGate.shouldSkip,
      dispatchSkippedReason: duplicateGate.reason ?? null,
    });
    if (duplicateGate.shouldSkip) {
      logEvent('info', 'upload dispatch skipped', {
        requestId,
        recordingId: job.recordingId,
        dedupeLookupKey: dedupeLookup,
        existingStatus: existingLookup.job?.status,
        skipReason: duplicateGate.reason,
        dispatchExecuted: false,
      });
      return jsonResponse({ ok: true, action: 'skipped', reason: `Duplicate upload skipped: ${duplicateGate.reason}.`, dropboxFileId: metadata.id, dropboxPathLower: metadata.path_lower, storedFileName: metadata.name, fileSizeBytes: metadata.size, recordingId: job.recordingId, jobStatus: job.status, createdJob: created });
    }

    ctx.waitUntil(
      processUploadedInterview(env, requestWithDropbox, metadata, job, { dryRun, forcePythonTranscription: true }).catch((error) => {
        logEvent('error', 'background upload processing failed', {
          phase: 'background_upload_processing',
          recordingId: job.recordingId,
          fileName: metadata.name,
          dropboxFileId: metadata.id,
          dropboxPathLower: metadata.path_lower,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }),
    );

    return jsonResponse({
      ok: true,
      action: 'queued',
      reason: 'Upload accepted. Transcription will continue in background.',
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      storedFileName: metadata.name,
      fileSizeBytes: metadata.size,
      recordingId: job.recordingId,
      jobStatus: 'queued',
      createdJob: created,
    }, { status: 202 });
  } catch (error) {
    logEvent('error', 'job creation failed', {
      requestId,
      fileName: metadata.name,
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      storageType: storageMeta.storageType,
      storageModeDecision: storageMeta.storageModeDecision,
      details: error instanceof HttpError ? error.details : error,
    });
    throw error;
  }
}

async function handleTranscriptionCallback(request: Request, env: Env): Promise<Response> {
  try {
    requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  } catch (error) {
    logEvent('error', 'callback_auth_failed', { details: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  let payload: RecordingJobCallbackPayload;
  try {
    logEvent('info', 'callback_received', { path: '/api/interviews/transcription-callback' });
    payload = await parseJson<RecordingJobCallbackPayload>(request);
    logEvent('info', 'callback_payload_validated', {
      recordingId: payload.recordingId ?? null,
      fileName: payload.fileName ?? null,
      dropboxFileId: payload.dropboxFileId ?? null,
      dropboxPathLower: payload.dropboxPathLower ?? null,
    });
  } catch (error) {
    logEvent('error', 'callback_payload_invalid', { details: error instanceof HttpError ? error.details : error });
    throw error;
  }
  try {
    const result = await persistTranscriptionCallback(env, payload);
    const lookup = await findRecordingJobWithSource(env, {
      recordingId: payload.recordingId?.trim(),
      dropboxFileId: payload.dropboxFileId?.trim(),
      dropboxPathLower: normalizeDropboxPath(payload.dropboxPathLower),
    });
    if (!lookup.job) throw new HttpError('Recording job not found after callback persistence.', 404, { phase: 'lookup_after_persist' });
    if (!env.FINALIZE_QUEUE) throw new HttpError('FINALIZE_QUEUE binding is required.', 500, { phase: 'enqueue_finalize' });
    const message: FinalizeQueueMessage = {
      recordingId: lookup.job.recordingId,
      force: false,
      source: 'callback',
      enqueuedAt: new Date().toISOString(),
    };
    logEvent('info', 'finalize_queue_enqueue_started', {
      recordingId: payload.recordingId ?? null,
      dropboxFileId: payload.dropboxFileId ?? null,
      dropboxPathLower: payload.dropboxPathLower ?? null,
      bindingName: 'FINALIZE_QUEUE',
      queueName: 'meeting-memo-finalize',
      enqueueSource: 'callback',
    });
    try {
      await env.FINALIZE_QUEUE.send(message);
      await updateRecordingJobStatus(env, { recordingId: message.recordingId }, 'callback_received', {
        finalizeQueuedAt: message.enqueuedAt,
        finalizeSource: 'callback',
      });
      logEvent('info', 'finalize_queue_enqueue_succeeded', {
        recordingId: payload.recordingId ?? null,
        dropboxFileId: payload.dropboxFileId ?? null,
        dropboxPathLower: payload.dropboxPathLower ?? null,
        bindingName: 'FINALIZE_QUEUE',
        queueName: 'meeting-memo-finalize',
        finalizeQueued: true,
        enqueueSource: 'callback',
      });
    } catch (error) {
      await updateRecordingJobStatus(env, { recordingId: message.recordingId }, 'failed', {
        finalizeStatus: 'failed',
        finalizeFailedAt: new Date().toISOString(),
        lastError: `finalize queue enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      logEvent('error', 'finalize_queue_enqueue_failed', {
        recordingId: payload.recordingId ?? null,
        dropboxFileId: payload.dropboxFileId ?? null,
        dropboxPathLower: payload.dropboxPathLower ?? null,
        bindingName: 'FINALIZE_QUEUE',
        queueName: 'meeting-memo-finalize',
        finalizeQueued: false,
        enqueueSource: 'callback',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    logEvent('info', 'callback_ack_returned', { recordingId: payload.recordingId ?? null, status: 202 });
    return jsonResponse({ ok: result.action !== 'error', action: result.action, reason: 'Callback accepted, persisted, and finalize job enqueued.', finalizeQueued: true }, { status: 202 });
  } catch (error) {
    logEvent('error', 'transcription callback failed', {
      phase: error instanceof HttpError ? ((error.details as { phase?: string } | undefined)?.phase ?? 'unknown') : 'unknown',
      recordingId: payload.recordingId ?? null,
      dropboxFileId: payload.dropboxFileId ?? null,
      dropboxPathLower: payload.dropboxPathLower ?? null,
      details: error instanceof HttpError ? error.details : error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

async function handleFinalize(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const body = await parseJson<{ recordingId: string; force?: boolean }>(request);
  await updateRecordingJobStatus(env, { recordingId: body.recordingId }, 'callback_received', { finalizeSource: 'manual' });
  const result = await finalizeInterviewJob(env, body.recordingId, { force: body.force === true });
  return jsonResponse({ ok: result.ok, status: result.status, recordingId: body.recordingId });
}

async function handleFinalizeEnqueue(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const body = await parseJson<{ recordingId: string; force?: boolean }>(request);
  if (!env.FINALIZE_QUEUE) throw new HttpError('FINALIZE_QUEUE binding is required.', 500, { phase: 'manual_enqueue_finalize' });
  const message: FinalizeQueueMessage = {
    recordingId: body.recordingId,
    force: body.force === true,
    source: 'manual',
    enqueuedAt: new Date().toISOString(),
  };
  await env.FINALIZE_QUEUE.send(message);
  await updateRecordingJobStatus(env, { recordingId: body.recordingId }, 'callback_received', {
    finalizeQueuedAt: message.enqueuedAt,
    finalizeSource: 'manual',
    finalizeStatus: 'pending',
  });
  return jsonResponse({ ok: true, recordingId: body.recordingId, finalizeQueued: true, source: 'manual' }, { status: 202 });
}

async function handleResendEmail(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const body = await parseJson<{ recordingId: string; force?: boolean }>(request);
  const result = await resendInterviewEmail(env, body.recordingId, body.force !== false);
  return jsonResponse({ ok: result.ok, status: result.status, recordingId: body.recordingId });
}

async function handleJobStatus(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const url = new URL(request.url);
  const recordingId = url.searchParams.get('recordingId');
  if (!recordingId) throw new HttpError('recordingId query parameter is required.', 400);
  const status = await getInterviewJobStatus(env, recordingId);
  return jsonResponse({ ok: true, ...status });
}

async function handleDebugDropbox(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  try {
    const response = await debugDropboxAppFolderRoot(env);
    return jsonResponse({ ok: true, path: '', ...response });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse({ ok: false, message: error.message, status: error.status, details: error.details }, { status: error.status });
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') return jsonResponse({ ok: true, service: 'meeting-memo' });
      if (request.method === 'POST' && url.pathname === '/api/interviews/intake') return await handleIntake(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/scan') return await handleScan(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/upload') return await handleUpload(request, env, ctx);
      if (request.method === 'POST' && url.pathname === '/api/interviews/transcription-callback') return await handleTranscriptionCallback(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/finalize') return await handleFinalize(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/finalize/enqueue') return await handleFinalizeEnqueue(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/resend-email') return await handleResendEmail(request, env);
      if (request.method === 'GET' && url.pathname === '/api/interviews/job-status') return await handleJobStatus(request, env);
      if (request.method === 'GET' && url.pathname === '/api/interviews/debug-dropbox') return await handleDebugDropbox(request, env);
      if (request.method === 'GET' && url.pathname === '/health') return jsonResponse({ ok: true, env: env.APP_ENV ?? 'unknown' });
      return jsonResponse({ ok: false, message: 'Not Found' }, { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) {
        logEvent('error', 'worker.http_error', { message: error.message, stack: error.stack, status: error.status, details: error.details });
        return Response.json({ ok: false, message: error.message, details: error.details }, { status: error.status });
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      logEvent('error', 'worker.unhandled_error', { message, stack: error instanceof Error ? error.stack : undefined });
      return Response.json({ ok: false, message }, { status: 500 });
    }
  },
  async queue(batch: QueueBatchLike<FinalizeQueueMessage>, env: Env): Promise<void> {
    const batchStartedAt = Date.now();
    logEvent('info', 'finalize_queue_consumer_started', { messageCount: batch.messages.length });
    for (const message of batch.messages) {
      const startedAt = Date.now();
      const recordingId = message.body?.recordingId;
      const force = message.body?.force === true;
      const source = message.body?.source ?? 'retry';
      if (!recordingId || typeof recordingId !== 'string') {
        logEvent('error', 'finalize_queue_message_failed', {
          recordingId: recordingId ?? null,
          source,
          force,
          attempt: message.attempts ?? null,
          errorMessage: 'recordingId is required in finalize queue message',
        });
        message.ack?.();
        continue;
      }
      logEvent('info', 'finalize_queue_message_started', {
        recordingId,
        source,
        force,
        attempt: message.attempts ?? null,
      });
      try {
        await updateRecordingJobStatus(env, { recordingId }, 'callback_received', {
          finalizeSource: source,
          finalizeStatus: 'pending',
        });
        const result = await finalizeInterviewJob(env, recordingId, { force });
        logEvent('info', 'finalize_queue_message_completed', {
          recordingId,
          source,
          force,
          attempt: message.attempts ?? null,
          finalizeStatus: result.status,
          elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
        });
        message.ack?.();
      } catch (error) {
        logEvent('error', 'finalize_queue_message_failed', {
          recordingId,
          source,
          force,
          attempt: message.attempts ?? null,
          elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (message.retry) {
          message.retry();
          continue;
        }
        throw error;
      }
    }
    logEvent('info', 'finalize_queue_batch_completed', {
      messageCount: batch.messages.length,
      elapsedSeconds: Number(((Date.now() - batchStartedAt) / 1000).toFixed(3)),
    });
  },
};
