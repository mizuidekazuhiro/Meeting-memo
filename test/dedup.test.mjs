import test from 'node:test';
import assert from 'node:assert/strict';

function stableDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function buildDedupCandidates(request, metadata) {
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
  return candidates.filter(Boolean);
}

test('buildDedupCandidates respects priority order', () => {
  const candidates = buildDedupCandidates(
    {
      recordedAt: '2026-03-22T10:00:00Z',
      fileSizeBytes: 1234,
      idempotencyKey: 'abc',
    },
    {
      id: 'id:123',
      path_lower: '/memo.m4a',
      content_hash: 'hash123',
      name: 'memo.m4a',
    },
  );

  assert.deepEqual(candidates, [
    'dropbox:id:id:123',
    'dropbox:path:/memo.m4a',
    'dropbox:hash:hash123',
    'dropbox:recorded:2026-03-22T10:00:00.000Z:size:1234',
    'client:idempotency:abc',
  ]);
});
