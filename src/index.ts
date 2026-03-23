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
import { createRecordingJob, getRecordingJob, upsertRecordingJob } from './lib/jobs';
import { logEvent } from './lib/logger';
import { persistCloudRunCallback, processUploadedInterview } from './lib/processing';
import { requireWebhookSecret } from './lib/security';
import type { Env, IntakeRequest, RecordingJobCallbackPayload, ScanRequest, UploadRequestMetadata } from './types';

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

async function handleUpload(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) throw new HttpError('Upload endpoint requires multipart/form-data.', 415);

  const form = await request.formData();
  const audioField = form.get('file') ?? form.get('audio');
  if (!(audioField instanceof File)) throw new HttpError('Upload failed: multipart field "file" (or "audio") is required.', 400);
  if (!audioField.type.startsWith('audio/')) throw new HttpError('Upload failed: only audio/* files are accepted.', 400, { mimeType: audioField.type || null });

  const intake = buildUploadRequest(form, audioField);
  const dryRun = asString(form.get('dryRun')) === 'true' || parseJsonField<boolean>(form.get('dryRunJson'), 'dryRunJson') === true;
  logEvent('info', 'interviews.upload.received', { fileName: intake.fileName, mimeType: intake.mimeType, bytes: audioField.size, recordedAt: intake.recordedAt, initiatedBy: intake.initiatedBy, dryRun });

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
    const { job, created } = await upsertRecordingJob(env, seededJob);
    const result = await processUploadedInterview(env, requestWithDropbox, metadata, job, { dryRun });
    return jsonResponse({ ok: result.action === 'processed', action: result.action, reason: result.reason, pageId: result.pageId, created: result.created, dropboxFileId: metadata.id, dropboxPathLower: metadata.path_lower, storedFileName: metadata.name, fileSizeBytes: metadata.size, recordingId: job.recordingId, jobStatus: job.status, createdJob: created, dedupCandidates: result.dedupCandidates, errorMessage: result.record?.errorMessage });
  } catch (error) {
    logEvent('error', 'job creation failed', { fileName: metadata.name, dropboxFileId: metadata.id, dropboxPathLower: metadata.path_lower, details: error instanceof HttpError ? error.details : error });
    throw error;
  }
}

async function handleTranscriptionCallback(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const payload = await parseJson<RecordingJobCallbackPayload>(request);
  const result = await persistCloudRunCallback(env, payload);
  return jsonResponse({ ok: result.action === 'processed', action: result.action, reason: result.reason, pageId: result.pageId, created: result.created });
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
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') return jsonResponse({ ok: true, service: 'meeting-memo' });
      if (request.method === 'POST' && url.pathname === '/api/interviews/intake') return await handleIntake(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/scan') return await handleScan(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/upload') return await handleUpload(request, env);
      if (request.method === 'POST' && url.pathname === '/api/interviews/transcription-callback') return await handleTranscriptionCallback(request, env);
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
};
