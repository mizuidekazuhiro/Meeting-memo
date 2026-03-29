import type { Env, InterviewRecord, NotionPageMatch, TranscriptSegment } from '../types';
import { HttpError } from './http';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_TEXT_LIMIT = 1900;
const TRANSCRIPT_BLOCK_TEXT_LIMIT = 1700;
const TRANSCRIPT_HEADING = 'Transcript';

type NotionRichText = Array<{ type: 'text'; text: { content: string } }>;

type NotionBlock = {
  object: 'block';
  id: string;
  type: string;
  has_children?: boolean;
  archived?: boolean;
  heading_2?: {
    rich_text?: Array<{ plain_text?: string }>;
  };
};

type NotionBlockInput =
  | {
      object: 'block';
      type: 'heading_2';
      heading_2: {
        rich_text: NotionRichText;
      };
    }
  | {
      object: 'block';
      type: 'paragraph';
      paragraph: {
        rich_text: NotionRichText;
      };
    };

async function notionFetch<T>(env: Env, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.NOTION_TOKEN}`,
      'content-type': 'application/json',
      'notion-version': NOTION_VERSION,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new HttpError(`Notion API call failed for ${path}.`, 502, await response.text());
  }
  return (await response.json()) as T;
}

export async function findExistingInterview(env: Env, dedupCandidates: string[]): Promise<NotionPageMatch | null> {
  for (const candidate of dedupCandidates) {
    const response = await notionFetch<{ results: Array<{ id: string; properties: Record<string, unknown> }> }>(env, `/databases/${env.INBOX_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          property: 'Dedup Key',
          rich_text: { equals: candidate },
        },
        page_size: 1,
      }),
    });
    if (response.results[0]) {
      return response.results[0];
    }
  }
  return null;
}

function titleText(content: string): NotionRichText {
  return [{ type: 'text', text: { content } }];
}

function richText(content: string): NotionRichText {
  return [{ type: 'text', text: { content: content.slice(0, NOTION_TEXT_LIMIT) } }];
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '不明';
}

function splitIntoChunks(content: string, maxLength: number): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  for (const paragraph of normalized.split('\n')) {
    const line = paragraph.trim();
    if (!line) {
      continue;
    }

    if (line.length <= maxLength) {
      chunks.push(line);
      continue;
    }

    let remaining = line;
    while (remaining.length > maxLength) {
      const slice = remaining.slice(0, maxLength);
      const breakIndex = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('　'));
      const splitIndex = breakIndex > Math.floor(maxLength * 0.6) ? breakIndex : maxLength;
      chunks.push(remaining.slice(0, splitIndex).trim());
      remaining = remaining.slice(splitIndex).trim();
    }
    if (remaining) {
      chunks.push(remaining);
    }
  }

  return chunks;
}

function transcriptLineFromSegment(segment: TranscriptSegment): string {
  const speaker = segment.speaker?.trim() || 'speaker_unknown';
  const text = segment.text?.trim() || '';
  return `[${speaker}] ${text}`.trim();
}

function buildTranscriptParagraphs(record: InterviewRecord): string[] {
  const transcript = record.transcript;
  if (!transcript) {
    return [];
  }

  if (transcript.segments.length) {
    return transcript.segments.flatMap((segment) => splitIntoChunks(transcriptLineFromSegment(segment), TRANSCRIPT_BLOCK_TEXT_LIMIT));
  }

  return splitIntoChunks(transcript.fullText, TRANSCRIPT_BLOCK_TEXT_LIMIT);
}

function buildProperties(record: InterviewRecord) {
  const recordedAt = record.request.recordedAt ?? record.metadata.client_modified ?? record.metadata.server_modified;
  return {
    Name: {
      title: titleText(record.title),
    },
    Source: { rich_text: richText(record.request.source ?? 'Interview') },
    'Record Type': {
      select: { name: 'Interview Memo' },
    },
    'Interview Date': recordedAt
      ? {
          date: { start: new Date(recordedAt).toISOString() },
        }
      : undefined,
    Summary: record.insights ? { rich_text: richText(record.insights.summary) } : undefined,
    'My Tasks': record.insights ? { rich_text: richText(bulletList(record.insights.myTasks)) } : undefined,
    'Other Tasks': record.insights ? { rich_text: richText(bulletList(record.insights.otherTasks)) } : undefined,
    'Dropbox File Id': record.metadata.id ? { rich_text: richText(record.metadata.id) } : undefined,
    'Dropbox Link': record.metadata.shared_link ?? record.request.dropboxSharedLink ? { url: record.metadata.shared_link ?? record.request.dropboxSharedLink ?? null } : undefined,
    'Processing Status': { select: { name: record.processingStatus } },
    'Speaker Separation': {
      select: {
        name: record.transcript?.segments.length ? 'Yes' : 'No',
      },
    },
    'Error Message': record.errorMessage ? { rich_text: richText(record.errorMessage) } : undefined,
    'Raw JSON': { rich_text: richText(JSON.stringify({ transcript: record.transcript?.raw, insights: record.insights?.raw })) },
    'Imported At': { date: { start: new Date().toISOString() } },
    'Dedup Key': { rich_text: richText(record.dedupKey) },
  };
}

function cleanProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

export function buildTranscriptBlocks(record: InterviewRecord): NotionBlockInput[] {
  const paragraphs = buildTranscriptParagraphs(record);
  if (!paragraphs.length) {
    return [];
  }

  return [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: titleText(TRANSCRIPT_HEADING),
      },
    },
    ...paragraphs.map((content) => ({
      object: 'block' as const,
      type: 'paragraph' as const,
      paragraph: {
        rich_text: richText(content),
      },
    })),
  ];
}

export async function upsertInterviewFromTranscript(
  env: Env,
  request: InterviewRecord['request'],
  metadata: InterviewRecord['metadata'],
  transcript: InterviewRecord['transcript'],
  insights?: InterviewRecord['insights'],
): Promise<{ pageId?: string; created?: boolean; record: InterviewRecord }> {
  const recordedAt = request.recordedAt ?? metadata.server_modified ?? metadata.client_modified ?? new Date().toISOString();
  const date = new Date(recordedAt);
  const safeDate = Number.isNaN(date.valueOf()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
  const record: InterviewRecord = {
    title: request.fileName ? `Interview Memo ${safeDate} - ${request.fileName}` : `Interview Memo ${safeDate} - ${metadata.name}`,
    dedupKey: metadata.id ? `dropbox:id:${metadata.id}` : `fallback:${metadata.name}`,
    metadata: { ...metadata, shared_link: request.dropboxSharedLink },
    request,
    transcript,
    insights,
    processingStatus: 'transcribed',
  };
  const existing = await findExistingInterview(env, [record.dedupKey]);
  const result = await upsertInterviewPage(env, record, existing);
  record.processingStatus = 'persisted';
  return { ...result, record };
}

async function appendBlockChildren(env: Env, blockId: string, children: NotionBlockInput[]): Promise<void> {
  for (let index = 0; index < children.length; index += 100) {
    await notionFetch(env, `/blocks/${blockId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: children.slice(index, index + 100) }),
    });
  }
}

async function listBlockChildren(env: Env, blockId: string): Promise<NotionBlock[]> {
  const results: NotionBlock[] = [];
  let cursor: string | undefined;

  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) {
      query.set('start_cursor', cursor);
    }
    const response = await notionFetch<{ results: NotionBlock[]; next_cursor: string | null; has_more: boolean }>(env, `/blocks/${blockId}/children?${query.toString()}`, {
      method: 'GET',
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return results;
}

async function deleteBlock(env: Env, blockId: string): Promise<void> {
  await notionFetch(env, `/blocks/${blockId}`, {
    method: 'DELETE',
  });
}

function isTranscriptHeadingBlock(block: NotionBlock): boolean {
  if (block.type !== 'heading_2') {
    return false;
  }

  const text = block.heading_2?.rich_text?.map((item) => item.plain_text ?? '').join('').trim();
  return text === TRANSCRIPT_HEADING;
}

function collectManagedTranscriptBlockIds(children: NotionBlock[]): string[] {
  const headingIndex = children.findIndex(isTranscriptHeadingBlock);
  if (headingIndex === -1) {
    return [];
  }

  const blockIds = [children[headingIndex].id];
  for (let index = headingIndex + 1; index < children.length; index += 1) {
    const block = children[index];
    if (block.type !== 'paragraph') {
      break;
    }
    blockIds.push(block.id);
  }
  return blockIds;
}

export async function appendTranscriptBlocks(env: Env, pageId: string, record: InterviewRecord): Promise<void> {
  const blocks = buildTranscriptBlocks(record);
  if (!blocks.length) {
    return;
  }
  await appendBlockChildren(env, pageId, blocks);
}

export async function replaceTranscriptBlocks(env: Env, pageId: string, record: InterviewRecord): Promise<void> {
  const children = await listBlockChildren(env, pageId);
  const managedBlockIds = collectManagedTranscriptBlockIds(children);
  for (const blockId of managedBlockIds) {
    await deleteBlock(env, blockId);
  }
  await appendTranscriptBlocks(env, pageId, record);
}

export async function upsertInterviewPage(env: Env, record: InterviewRecord, existing: NotionPageMatch | null): Promise<{ pageId: string; created: boolean }> {
  const properties = cleanProperties(buildProperties(record));
  if (existing) {
    await notionFetch(env, `/pages/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    await replaceTranscriptBlocks(env, existing.id, record);
    return { pageId: existing.id, created: false };
  }

  const response = await notionFetch<{ id: string }>(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.INBOX_DB_ID },
      properties,
    }),
  });
  await appendTranscriptBlocks(env, response.id, record);
  return { pageId: response.id, created: true };
}
