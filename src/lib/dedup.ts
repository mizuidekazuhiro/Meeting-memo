import type { DropboxFileMetadata, IntakeRequest } from '../types';

function stableDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function buildDedupCandidates(request: IntakeRequest, metadata: DropboxFileMetadata): string[] {
  const candidates = [
    metadata.id ? `dropbox:id:${metadata.id}` : undefined,
    metadata.path_lower ? `dropbox:path:${metadata.path_lower}` : undefined,
    metadata.content_hash ? `dropbox:hash:${metadata.content_hash}` : undefined,
  ];

  const recordedAt = stableDate(request.recordedAt ?? metadata.client_modified ?? metadata.server_modified);
  const fileSize = request.fileSizeBytes ?? metadata.size;
  if (recordedAt && fileSize !== undefined) {
    candidates.push(`dropbox:recorded:${recordedAt}:size:${fileSize}`);
  }
  if (request.idempotencyKey) {
    candidates.push(`client:idempotency:${request.idempotencyKey}`);
  }
  return candidates.filter((value): value is string => Boolean(value));
}

export function buildIntakeRequestFromMetadata(metadata: DropboxFileMetadata): IntakeRequest {
  return {
    dropboxFileId: metadata.id,
    dropboxPathLower: metadata.path_lower,
    fileName: metadata.name,
    recordedAt: metadata.server_modified ?? metadata.client_modified,
    fileSizeBytes: metadata.size,
  };
}

export function primaryDedupKey(request: IntakeRequest, metadata: DropboxFileMetadata): string {
  const [first] = buildDedupCandidates(request, metadata);
  return first ?? `fallback:${metadata.name}`;
}
