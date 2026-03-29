import { HttpError } from './http';
import type { Env, IntakeRequest, RecordingJob, RecordingJobCallbackPayload, RecordingJobKvStore, RecordingJobStatus } from '../types';

type LookupKey = { recordingId?: string; dropboxFileId?: string; dropboxPathLower?: string };
type LookupSource = 'recordingId' | 'dropboxFileId' | 'dropboxPathLower' | 'legacyDropboxFileId';

type GlobalFallbackStore = {
  jobsByRecordingId: Map<string, RecordingJob>;
  recordingIdByDropboxFileId: Map<string, string>;
  recordingIdByDropboxPathLower: Map<string, string>;
};

export type RecordingJobStorageType = 'cloudflare-kv' | 'in-memory-fallback';

export interface RecordingJobStorageDecision {
  storageType: RecordingJobStorageType;
  storageModeDecision: 'kv_binding_present' | 'explicit_test_fallback';
  allowInMemoryFallback: boolean;
  hasRecordingJobKvBinding: boolean;
  appEnv: string;
}

const globalState = globalThis as typeof globalThis & {
  __meetingMemoFallbackStore?: GlobalFallbackStore;
};

function nowIso(): string {
  return new Date().toISOString();
}

const NON_REPROCESSABLE_STATUSES: ReadonlySet<RecordingJobStatus> = new Set(['queued', 'transcoding', 'transcribing', 'transcribed', 'persisted']);
const TERMINAL_STATUSES: ReadonlySet<RecordingJobStatus> = new Set(['persisted', 'failed']);

export function isTerminalRecordingJobStatus(status: RecordingJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function shouldSkipProcessingForStatus(status: RecordingJobStatus): boolean {
  return NON_REPROCESSABLE_STATUSES.has(status);
}

export function shouldSkipProcessingForExistingJob(job: RecordingJob): { shouldSkip: boolean; reason?: string } {
  if (!shouldSkipProcessingForStatus(job.status)) return { shouldSkip: false };
  return {
    shouldSkip: true,
    reason: `existing job is already ${job.status}`,
  };
}

export function normalizeDropboxPath(path?: string): string | undefined {
  if (!path) return undefined;
  const normalized = path.trim().toLowerCase();
  return normalized || undefined;
}

function buildJobKeyByRecordingId(recordingId: string): string {
  return `recordingJob:recordingId:${recordingId}`;
}

function buildRecordingIdIndexByDropboxFileId(dropboxFileId: string): string {
  return `recordingJob:index:dropboxFileId:${dropboxFileId}`;
}

function buildRecordingIdIndexByDropboxPathLower(dropboxPathLower: string): string {
  return `recordingJob:index:dropboxPathLower:${dropboxPathLower}`;
}

function buildLegacyJobKeyByDropboxFileId(dropboxFileId: string): string {
  return `recordingJob:dropboxFileId:${dropboxFileId}`;
}

export function buildRecordingJobStorageDecision(env: Env): RecordingJobStorageDecision {
  const hasRecordingJobKvBinding = Boolean(env.RECORDING_JOB_KV);
  const allowInMemoryFallback = env.ALLOW_IN_MEMORY_RECORDING_JOB_STORE?.toLowerCase() === 'true';
  const appEnv = env.APP_ENV ?? 'unknown';

  if (hasRecordingJobKvBinding) {
    return {
      storageType: 'cloudflare-kv',
      storageModeDecision: 'kv_binding_present',
      allowInMemoryFallback,
      hasRecordingJobKvBinding,
      appEnv,
    };
  }

  if (allowInMemoryFallback) {
    return {
      storageType: 'in-memory-fallback',
      storageModeDecision: 'explicit_test_fallback',
      allowInMemoryFallback,
      hasRecordingJobKvBinding,
      appEnv,
    };
  }

  throw new HttpError('RECORDING_JOB_KV binding is required in deployed Workers runtime. In-memory store is disabled unless ALLOW_IN_MEMORY_RECORDING_JOB_STORE=true.', 500, {
    phase: 'recording_job_storage_init',
    storageModeDecision: 'kv_missing_and_fallback_disabled',
    storageType: 'none',
    hasRecordingJobKvBinding,
    allowInMemoryFallback,
    appEnv,
  });
}

export function getRecordingJobStorageMeta(env: Env): RecordingJobStorageDecision {
  return buildRecordingJobStorageDecision(env);
}

function getFallbackStore(): GlobalFallbackStore {
  if (!globalState.__meetingMemoFallbackStore) {
    globalState.__meetingMemoFallbackStore = {
      jobsByRecordingId: new Map(),
      recordingIdByDropboxFileId: new Map(),
      recordingIdByDropboxPathLower: new Map(),
    };
  }
  return globalState.__meetingMemoFallbackStore;
}

function getJobKv(env: Env): RecordingJobKvStore {
  const decision = buildRecordingJobStorageDecision(env);
  if (decision.storageType === 'cloudflare-kv') return env.RECORDING_JOB_KV as RecordingJobKvStore;

  return {
    async get(key: string, options?: any): Promise<any> {
      const store = getFallbackStore();
      const value =
        store.jobsByRecordingId.get(key.replace('recordingJob:recordingId:', '')) ??
        store.recordingIdByDropboxFileId.get(key.replace('recordingJob:index:dropboxFileId:', '')) ??
        store.recordingIdByDropboxPathLower.get(key.replace('recordingJob:index:dropboxPathLower:', ''));
      if (options?.type === 'json' || options === 'json') return value ?? null;
      return value ? JSON.stringify(value) : null;
    },
    async put(key: string, value: string): Promise<void> {
      const store = getFallbackStore();
      if (key.startsWith('recordingJob:recordingId:')) {
        const parsed = JSON.parse(value) as RecordingJob;
        store.jobsByRecordingId.set(parsed.recordingId, parsed);
        return;
      }
      if (key.startsWith('recordingJob:index:dropboxFileId:')) {
        store.recordingIdByDropboxFileId.set(key.replace('recordingJob:index:dropboxFileId:', ''), value);
        return;
      }
      if (key.startsWith('recordingJob:index:dropboxPathLower:')) {
        store.recordingIdByDropboxPathLower.set(key.replace('recordingJob:index:dropboxPathLower:', ''), value);
        return;
      }
    },
  } as RecordingJobKvStore;
}

async function writeJobAndIndexes(env: Env, job: RecordingJob): Promise<void> {
  const kv = getJobKv(env);
  const normalizedDropboxPathLower = normalizeDropboxPath(job.dropboxPathLower);
  await Promise.all([
    kv.put(buildJobKeyByRecordingId(job.recordingId), JSON.stringify({ ...job, dropboxPathLower: normalizedDropboxPathLower })),
    kv.put(buildRecordingIdIndexByDropboxFileId(job.dropboxFileId), job.recordingId),
    normalizedDropboxPathLower ? kv.put(buildRecordingIdIndexByDropboxPathLower(normalizedDropboxPathLower), job.recordingId) : Promise.resolve(),
  ]);
}

async function getJobByRecordingId(env: Env, recordingId: string): Promise<RecordingJob | null> {
  const kv = getJobKv(env);
  return (await kv.get(buildJobKeyByRecordingId(recordingId), 'json')) as RecordingJob | null;
}

async function getJobByDropboxFileId(env: Env, dropboxFileId: string): Promise<RecordingJob | null> {
  const kv = getJobKv(env);
  const recordingId = await kv.get(buildRecordingIdIndexByDropboxFileId(dropboxFileId));
  if (typeof recordingId === 'string' && recordingId) return getJobByRecordingId(env, recordingId);

  const legacy = (await kv.get(buildLegacyJobKeyByDropboxFileId(dropboxFileId), 'json')) as RecordingJob | null;
  if (!legacy) return null;
  await writeJobAndIndexes(env, { ...legacy, updatedAt: nowIso(), dropboxPathLower: normalizeDropboxPath(legacy.dropboxPathLower) });
  return legacy;
}

async function getJobByDropboxPathLower(env: Env, dropboxPathLower: string): Promise<RecordingJob | null> {
  const kv = getJobKv(env);
  const normalized = normalizeDropboxPath(dropboxPathLower);
  if (!normalized) return null;
  const recordingId = await kv.get(buildRecordingIdIndexByDropboxPathLower(normalized));
  if (typeof recordingId !== 'string' || !recordingId) return null;
  return getJobByRecordingId(env, recordingId);
}

export async function findRecordingJobWithSource(env: Env, lookup: LookupKey): Promise<{ job: RecordingJob | null; source?: LookupSource }> {
  if (lookup.recordingId) {
    const byRecordingId = await getJobByRecordingId(env, lookup.recordingId);
    if (byRecordingId) return { job: byRecordingId, source: 'recordingId' };
  }
  if (lookup.dropboxFileId) {
    const byDropboxId = await getJobByDropboxFileId(env, lookup.dropboxFileId);
    if (byDropboxId) return { job: byDropboxId, source: 'dropboxFileId' };
  }
  if (lookup.dropboxPathLower) {
    const byPath = await getJobByDropboxPathLower(env, lookup.dropboxPathLower);
    if (byPath) return { job: byPath, source: 'dropboxPathLower' };
  }
  return { job: null };
}

export function buildRecordingId(dropboxFileId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || 'audio';
  return `${dropboxFileId.replace(/[^a-zA-Z0-9:_-]+/g, '-')}:${safeName}`;
}

export function createRecordingJob(input: {
  request: IntakeRequest;
  dropboxFileId: string;
  dropboxPathLower?: string;
  fileName: string;
  sourceBytes?: number;
  clientModified?: string;
  serverModified?: string;
  sourceDurationSec?: number;
}): RecordingJob {
  const recordingId = buildRecordingId(input.dropboxFileId, input.fileName);
  const timestamp = nowIso();
  return {
    recordingId,
    fileName: input.fileName,
    dropboxFileId: input.dropboxFileId,
    dropboxPathLower: normalizeDropboxPath(input.dropboxPathLower),
    sourceBytes: input.sourceBytes,
    sourceDurationSec: input.sourceDurationSec,
    uploadSource: 'shortcut',
    status: 'uploaded',
    callbackStatus: 'pending',
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    clientModified: input.clientModified,
    serverModified: input.serverModified,
    request: input.request,
    transcriptionRequestMetadata: {
      requestFileName: input.request.fileName,
      requestDropboxFileId: input.request.dropboxFileId,
      requestDropboxPathLower: input.request.dropboxPathLower,
    },
  };
}

export async function upsertRecordingJob(env: Env, job: RecordingJob): Promise<{ job: RecordingJob; created: boolean }> {
  const normalizedDropboxPathLower = normalizeDropboxPath(job.dropboxPathLower);
  const lookup = await findRecordingJobWithSource(env, {
    recordingId: job.recordingId,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: normalizedDropboxPathLower,
  });

  if (lookup.job) {
    const existing = lookup.job;
    const merged: RecordingJob = {
      ...existing,
      ...job,
      recordingId: existing.recordingId,
      dropboxFileId: existing.dropboxFileId,
      dropboxPathLower: existing.dropboxPathLower ?? normalizedDropboxPathLower,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
      callbackStatus: existing.callbackStatus ?? job.callbackStatus,
    };
    await writeJobAndIndexes(env, merged);
    return { job: merged, created: false };
  }

  const stored: RecordingJob = {
    ...job,
    dropboxPathLower: normalizedDropboxPathLower,
    updatedAt: nowIso(),
  };
  await writeJobAndIndexes(env, stored);
  return { job: stored, created: true };
}

export async function getRecordingJob(env: Env, lookup: LookupKey): Promise<RecordingJob | null> {
  const found = await findRecordingJobWithSource(env, lookup);
  return found.job;
}

export async function updateRecordingJobStatus(env: Env, lookup: LookupKey, status: RecordingJobStatus, patch: Partial<RecordingJob> = {}): Promise<RecordingJob | null> {
  const existing = await getRecordingJob(env, lookup);
  if (!existing) return null;
  const updated: RecordingJob = {
    ...existing,
    ...patch,
    dropboxPathLower: normalizeDropboxPath(patch.dropboxPathLower) ?? existing.dropboxPathLower,
    status,
    updatedAt: nowIso(),
  };
  await writeJobAndIndexes(env, updated);
  return updated;
}

export async function markJobFailed(env: Env, lookup: LookupKey, errorMessage: string, patch: Partial<RecordingJob> = {}): Promise<RecordingJob | null> {
  const existing = await getRecordingJob(env, lookup);
  if (!existing) return null;
  return updateRecordingJobStatus(env, lookup, 'failed', {
    ...patch,
    callbackStatus: 'failed',
    errorMessage,
    retryCount: existing.retryCount + 1,
  });
}

export function buildCallbackPayload(job: RecordingJob, payload: RecordingJobCallbackPayload): RecordingJobCallbackPayload {
  return {
    ...payload,
    recordingId: job.recordingId,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: job.dropboxPathLower,
    fileName: job.fileName,
  };
}
