import type { Env, IntakeRequest, RecordingJob, RecordingJobCallbackPayload, RecordingJobStatus } from '../types';

const globalState = globalThis as typeof globalThis & {
  __meetingMemoJobs?: Map<string, RecordingJob>;
  __meetingMemoJobsByRecordingId?: Map<string, string>;
};

function jobStore(): { byDropboxId: Map<string, RecordingJob>; byRecordingId: Map<string, string> } {
  if (!globalState.__meetingMemoJobs) globalState.__meetingMemoJobs = new Map();
  if (!globalState.__meetingMemoJobsByRecordingId) globalState.__meetingMemoJobsByRecordingId = new Map();
  return { byDropboxId: globalState.__meetingMemoJobs, byRecordingId: globalState.__meetingMemoJobsByRecordingId };
}

function nowIso(): string { return new Date().toISOString(); }

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
    dropboxPathLower: input.dropboxPathLower,
    sourceBytes: input.sourceBytes,
    sourceDurationSec: input.sourceDurationSec,
    uploadSource: 'shortcut',
    status: 'uploaded',
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    clientModified: input.clientModified,
    serverModified: input.serverModified,
    request: input.request,
  };
}

export async function upsertRecordingJob(_env: Env, job: RecordingJob): Promise<{ job: RecordingJob; created: boolean }> {
  const store = jobStore();
  const existing = store.byDropboxId.get(job.dropboxFileId) ?? (store.byRecordingId.get(job.recordingId) ? store.byDropboxId.get(store.byRecordingId.get(job.recordingId)!) : undefined);
  if (existing) {
    const merged = { ...existing, ...job, recordingId: existing.recordingId, dropboxFileId: existing.dropboxFileId, createdAt: existing.createdAt, updatedAt: nowIso() };
    store.byDropboxId.set(existing.dropboxFileId, merged);
    store.byRecordingId.set(existing.recordingId, existing.dropboxFileId);
    return { job: merged, created: false };
  }
  const stored = { ...job, updatedAt: nowIso() };
  store.byDropboxId.set(stored.dropboxFileId, stored);
  store.byRecordingId.set(stored.recordingId, stored.dropboxFileId);
  return { job: stored, created: true };
}

export async function getRecordingJob(env: Env, lookup: { recordingId?: string; dropboxFileId?: string }): Promise<RecordingJob | null> {
  void env;
  const store = jobStore();
  if (lookup.dropboxFileId) return store.byDropboxId.get(lookup.dropboxFileId) ?? null;
  if (lookup.recordingId) {
    const dropboxId = store.byRecordingId.get(lookup.recordingId);
    return dropboxId ? store.byDropboxId.get(dropboxId) ?? null : null;
  }
  return null;
}

export async function updateRecordingJobStatus(env: Env, lookup: { recordingId?: string; dropboxFileId?: string }, status: RecordingJobStatus, patch: Partial<RecordingJob> = {}): Promise<RecordingJob | null> {
  const existing = await getRecordingJob(env, lookup);
  if (!existing) return null;
  const updated: RecordingJob = { ...existing, ...patch, status, updatedAt: nowIso() };
  jobStore().byDropboxId.set(existing.dropboxFileId, updated);
  return updated;
}

export async function markJobFailed(env: Env, lookup: { recordingId?: string; dropboxFileId?: string }, errorMessage: string, patch: Partial<RecordingJob> = {}): Promise<RecordingJob | null> {
  const existing = await getRecordingJob(env, lookup);
  if (!existing) return null;
  return updateRecordingJobStatus(env, lookup, 'failed', { ...patch, errorMessage, retryCount: existing.retryCount + 1 });
}

export function buildCallbackPayload(job: RecordingJob, payload: RecordingJobCallbackPayload): RecordingJobCallbackPayload {
  return { ...payload, recordingId: job.recordingId, dropboxFileId: job.dropboxFileId, dropboxPathLower: job.dropboxPathLower, fileName: job.fileName };
}
