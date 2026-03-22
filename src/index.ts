import { buildIntakeRequestFromMetadata } from './lib/dedup';
import {
  debugDropboxAppFolderRoot,
  fetchDropboxMetadata,
  getDropboxCredentialStatus,
  isAudioDropboxFile,
  listAllDropboxEntries,
} from './lib/dropbox';
import { HttpError, jsonResponse, parseJson } from './lib/http';
import { processInterviewFromMetadata } from './lib/interviews';
import { requireWebhookSecret } from './lib/security';
import type { Env, IntakeRequest, ScanRequest } from './types';

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

function parseLimit(value: number | undefined, envValue: string | undefined): number {
  if (value !== undefined) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new HttpError('limit must be a positive integer.', 400);
    }
    return value;
  }

  if (!envValue) return 20;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError('INTERVIEW_SCAN_MAX_FILES must be a positive integer.', 500);
  }
  return parsed;
}

function sortEntriesByServerModifiedDesc<T extends { server_modified?: string; path_lower?: string; name: string }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => {
    const leftTime = left.server_modified ? new Date(left.server_modified).valueOf() : 0;
    const rightTime = right.server_modified ? new Date(right.server_modified).valueOf() : 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return (left.path_lower ?? left.name).localeCompare(right.path_lower ?? right.name);
  });
}

async function handleIntake(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const intake = await parseJson<IntakeRequest>(request);
  const metadata = await fetchDropboxMetadata(env, intake);
  const result = await processInterviewFromMetadata(env, intake, metadata);

  return jsonResponse({
    ok: result.action === 'processed',
    status: result.record?.processingStatus ?? (result.action === 'skipped' ? 'skipped' : 'error'),
    created: result.created,
    pageId: result.pageId,
    dedupCandidates: result.dedupCandidates,
    errorMessage: result.record?.errorMessage,
    reason: result.reason,
  });
}

async function parseOptionalScanRequest(request: Request): Promise<{ bodyText: string; scan: ScanRequest }> {
  const bodyText = await request.text();
  if (!bodyText.trim()) {
    return { bodyText, scan: {} };
  }

  try {
    return {
      bodyText,
      scan: JSON.parse(bodyText) as ScanRequest,
    };
  } catch (error) {
    throw new HttpError('Request body must be valid JSON.', 400, error);
  }
}

async function handleScan(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { bodyText, scan } = await parseOptionalScanRequest(request);
  const dropboxCredentialStatus = getDropboxCredentialStatus(env);

  console.log('interviews.scan.request', {
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
  if (!folderPath) {
    throw new HttpError('folderPath is required when DROPBOX_INTERVIEW_SCAN_FOLDER is not configured.', 400);
  }

  const recursive = scan.recursive ?? parseBooleanEnv(env.DROPBOX_INTERVIEW_SCAN_RECURSIVE, false);
  const dryRun = scan.dryRun ?? false;
  const limit = parseLimit(scan.limit, env.INTERVIEW_SCAN_MAX_FILES);

  const scannedEntries = await listAllDropboxEntries(env, folderPath, recursive);
  const audioEntries = sortEntriesByServerModifiedDesc(scannedEntries.filter(isAudioDropboxFile));
  const selectedEntries = audioEntries.slice(0, limit);

  const results = [] as Array<{
    pathLower?: string;
    dropboxFileId?: string;
    action: 'processed' | 'skipped' | 'error';
    reason: string;
    details?: unknown;
  }>;

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const metadata of selectedEntries) {
    try {
      const intake = buildIntakeRequestFromMetadata(metadata);
      const result = await processInterviewFromMetadata(env, intake, metadata, { dryRun, skipIfExisting: true });
      results.push({
        pathLower: metadata.path_lower,
        dropboxFileId: metadata.id,
        action: result.action,
        reason: result.reason,
      });

      if (result.action === 'processed') processedCount += 1;
      if (result.action === 'skipped') skippedCount += 1;
      if (result.action === 'error') errorCount += 1;
    } catch (error) {
      console.error('interviews.scan.entry_error', {
        message: error instanceof Error ? error.message : 'Unknown scan error',
        stack: error instanceof Error ? error.stack : undefined,
        pathLower: metadata.path_lower,
        dropboxFileId: metadata.id,
        details: error instanceof HttpError ? error.details : undefined,
      });
      errorCount += 1;
      results.push({
        pathLower: metadata.path_lower,
        dropboxFileId: metadata.id,
        action: 'error',
        reason: error instanceof Error ? error.message : 'Unknown scan error',
        details: error instanceof HttpError ? error.details : undefined,
      });
    }
  }

  return jsonResponse({
    ok: true,
    folderPath,
    scannedCount: scannedEntries.length,
    audioCandidateCount: audioEntries.length,
    processedCount,
    skippedCount,
    errorCount,
    dryRun,
    results,
  });
}

async function handleDebugDropbox(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);

  try {
    const response = await debugDropboxAppFolderRoot(env);
    return jsonResponse({ ok: true, path: '', ...response });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(
        {
          ok: false,
          message: error.message,
          status: error.status,
          details: error.details,
        },
        { status: error.status },
      );
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') {
        return jsonResponse({ ok: true, service: 'meeting-memo' });
      }
      if (request.method === 'POST' && url.pathname === '/api/interviews/intake') {
        return await handleIntake(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/interviews/scan') {
        return await handleScan(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/interviews/debug-dropbox') {
        return await handleDebugDropbox(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({ ok: true, env: env.APP_ENV ?? 'unknown' });
      }
      return jsonResponse({ ok: false, message: 'Not Found' }, { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) {
        console.error('worker.http_error', {
          message: error.message,
          stack: error.stack,
          status: error.status,
          details: error.details,
        });
        return Response.json({ ok: false, message: error.message, details: error.details }, { status: error.status });
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('worker.unhandled_error', {
        message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return Response.json({ ok: false, message }, { status: 500 });
    }
  },
};
