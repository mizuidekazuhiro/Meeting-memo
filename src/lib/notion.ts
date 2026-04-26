import type { Env, InterviewRecord, InterviewReviewResult, NotionPageMatch, TranscriptSegment } from '../types';
import { HttpError } from './http';
import { logEvent } from './logger';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_TEXT_LIMIT = 1900;
const TRANSCRIPT_BLOCK_TEXT_LIMIT = 1700;
const TRANSCRIPT_HEADING = 'Transcript';
const FINAL_MEMO_HEADING = '面談メモ（完成版）';

type NotionRichText = Array<{
  type: 'text';
  text: { content: string };
  annotations?: { bold?: boolean };
}>;

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
      type: 'heading_1';
      heading_1: {
        rich_text: NotionRichText;
      };
    }
  | {
      object: 'block';
      type: 'heading_2';
      heading_2: {
        rich_text: NotionRichText;
      };
    }
  | {
      object: 'block';
      type: 'heading_3';
      heading_3: {
        rich_text: NotionRichText;
      };
    }
  | {
      object: 'block';
      type: 'paragraph';
      paragraph: {
        rich_text: NotionRichText;
      };
    }
  | {
      object: 'block';
      type: 'bulleted_list_item';
      bulleted_list_item: {
        rich_text: NotionRichText;
      };
    }
  | {
      object: 'block';
      type: 'table';
      table: {
        table_width: number;
        has_column_header: boolean;
        has_row_header: boolean;
        children: Array<{
          object: 'block';
          type: 'table_row';
          table_row: {
            cells: NotionRichText[];
          };
        }>;
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

async function findPageByDedupKey(env: Env, dedupKey: string): Promise<NotionPageMatch | null> {
  const response = await notionFetch<{ results: Array<{ id: string; properties: Record<string, unknown> }> }>(env, `/databases/${env.INBOX_DB_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: {
        property: 'Dedup Key',
        rich_text: { equals: dedupKey },
      },
      page_size: 1,
    }),
  });
  return response.results[0] ?? null;
}

export async function findExistingInterview(env: Env, dedupCandidates: string[]): Promise<NotionPageMatch | null> {
  for (const candidate of dedupCandidates) {
    const found = await findPageByDedupKey(env, candidate);
    if (found) return found;
  }
  return null;
}

function titleText(content: string): NotionRichText {
  return [{ type: 'text', text: { content } }];
}

function richText(content: string): NotionRichText {
  return [{ type: 'text', text: { content: content.slice(0, NOTION_TEXT_LIMIT) } }];
}

interface InlineSegment {
  text: string;
  bold: boolean;
}

function parseInlineMarkdown(content: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  if (!content) return segments;
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    if (match.index > cursor) {
      segments.push({ text: content.slice(cursor, match.index), bold: false });
    }
    if (match[1]) {
      segments.push({ text: match[1], bold: true });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ text: content.slice(cursor), bold: false });
  }
  return segments;
}

function splitInlineSegmentsByLimit(segments: InlineSegment[], maxLength: number): InlineSegment[][] {
  const groups: InlineSegment[][] = [];
  let current: InlineSegment[] = [];
  let currentLength = 0;

  const flushCurrent = (): void => {
    if (!current.length) return;
    groups.push(current);
    current = [];
    currentLength = 0;
  };

  for (const segment of segments) {
    let remaining = segment.text;
    while (remaining.length > 0) {
      const capacity = maxLength - currentLength;
      if (capacity === 0) {
        flushCurrent();
        continue;
      }
      const slice = remaining.slice(0, capacity);
      current.push({ text: slice, bold: segment.bold });
      currentLength += slice.length;
      remaining = remaining.slice(slice.length);
      if (currentLength >= maxLength) {
        flushCurrent();
      }
    }
  }

  flushCurrent();
  return groups;
}

function richTextFromInlineSegments(segments: InlineSegment[]): NotionRichText {
  const richTexts: NotionRichText = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    richTexts.push({
      type: 'text',
      text: { content: segment.text.slice(0, NOTION_TEXT_LIMIT) },
      ...(segment.bold ? { annotations: { bold: true } } : {}),
    });
  }
  return richTexts.length ? richTexts : richText('');
}

function markdownInlineToRichTextGroups(content: string, maxLength: number): NotionRichText[] {
  const parsed = parseInlineMarkdown(content);
  const safeParsed = parsed.length ? parsed : [{ text: content, bold: false }];
  return splitInlineSegmentsByLimit(safeParsed, maxLength).map((group) => richTextFromInlineSegments(group));
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

function richTextChunks(content: string, maxLength = NOTION_TEXT_LIMIT): NotionRichText {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return richText('');
  const chunks: NotionRichText = [];
  for (let index = 0; index < normalized.length; index += maxLength) {
    chunks.push({ type: 'text', text: { content: normalized.slice(index, index + maxLength) } });
  }
  return chunks;
}

function buildProperties(record: InterviewRecord) {
  const recordedAt = record.request.recordedAt ?? record.metadata.client_modified ?? record.metadata.server_modified;
  const rawJson = {
    transcript: record.transcript?.raw,
    insights: record.insights?.raw,
    summaryRaw: record.summaryRaw,
    summaryErrorMessage: record.summaryErrorMessage,
    summaryErrorDetails: record.summaryErrorDetails,
  };
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
    Summary: record.insights ? { rich_text: richTextChunks(record.insights.summary) } : undefined,
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
    'Raw JSON': { rich_text: richText(JSON.stringify(rawJson)) },
    'Imported At': { date: { start: new Date().toISOString() } },
    'Dedup Key': { rich_text: richText(record.dedupKey) },
  };
}

function cleanProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

export function buildTranscriptBlocks(record: InterviewRecord, options: { excerptChars?: number; transcriptFileUrl?: string } = {}): NotionBlockInput[] {
  const transcript = record.transcript;
  if (!transcript) return [];

  const transcriptLink = options.transcriptFileUrl?.trim();
  const paragraphs = [transcriptLink ? `Transcript全文リンク: ${transcriptLink}` : 'Transcript全文リンク: 未取得']
    .flatMap((line) => splitIntoChunks(line, TRANSCRIPT_BLOCK_TEXT_LIMIT));

  return [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: titleText(TRANSCRIPT_HEADING) } },
    ...paragraphs.map((content) => ({
      object: 'block' as const,
      type: 'paragraph' as const,
      paragraph: { rich_text: richText(content) },
    })),
  ];
}

export async function upsertInterviewFromTranscript(
  env: Env,
  request: InterviewRecord['request'],
  metadata: InterviewRecord['metadata'],
  transcript: InterviewRecord['transcript'],
  insights?: InterviewRecord['insights'],
  options: { errorMessage?: string; summaryRaw?: unknown; summaryErrorMessage?: string; summaryErrorDetails?: unknown } = {},
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
    summaryRaw: options.summaryRaw,
    summaryErrorMessage: options.summaryErrorMessage,
    summaryErrorDetails: options.summaryErrorDetails,
    processingStatus: 'transcribed',
    errorMessage: options.errorMessage,
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

function headingText(block: NotionBlock): string {
  return block.heading_2?.rich_text?.map((item) => item.plain_text ?? '').join('').trim() ?? '';
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const raw = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return raw.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tryParseMarkdownTable(lines: string[], startIndex: number): { block: NotionBlockInput; consumed: number } | null {
  const header = lines[startIndex]?.trim() ?? '';
  const separator = lines[startIndex + 1]?.trim() ?? '';
  if (!header.includes('|') || !separator.includes('|')) return null;
  if (!isMarkdownTableSeparatorRow(separator)) return null;

  const headerCells = splitMarkdownTableRow(header);
  if (!headerCells.length) return null;

  const rows = [headerCells];
  let cursor = startIndex + 2;
  while (cursor < lines.length) {
    const line = lines[cursor].trim();
    if (!line || !line.includes('|')) break;
    rows.push(splitMarkdownTableRow(line));
    cursor += 1;
  }

  const tableWidth = Math.max(...rows.map((row) => row.length));
  const tableRows = rows.map((row) => ({
    object: 'block' as const,
    type: 'table_row' as const,
    table_row: {
      cells: Array.from({ length: tableWidth }, (_, index) => {
        const cell = row[index] ?? '';
        const groups = markdownInlineToRichTextGroups(cell, NOTION_TEXT_LIMIT);
        return groups[0] ?? richText('');
      }),
    },
  }));

  return {
    block: {
      object: 'block',
      type: 'table',
      table: {
        table_width: tableWidth,
        has_column_header: true,
        has_row_header: false,
        children: tableRows,
      },
    },
    consumed: cursor - startIndex,
  };
}

function markdownParagraphBlocks(content: string): NotionBlockInput[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: NotionBlockInput[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const table = tryParseMarkdownTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index += table.consumed - 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const hashes = headingMatch[1].length;
      const headingTextValue = headingMatch[2].trim();
      const groups = markdownInlineToRichTextGroups(headingTextValue, TRANSCRIPT_BLOCK_TEXT_LIMIT);
      for (const richGroup of groups) {
        if (hashes === 1) {
          blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: richGroup } });
        } else if (hashes === 2) {
          blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: richGroup } });
        } else {
          blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: richGroup } });
        }
      }
      continue;
    }

    const bulletMatch = line.match(/^- (.+)$/);
    if (bulletMatch) {
      const groups = markdownInlineToRichTextGroups(bulletMatch[1].trim(), TRANSCRIPT_BLOCK_TEXT_LIMIT);
      for (const richGroup of groups) {
        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: richGroup },
        });
      }
      continue;
    }

    const groups = markdownInlineToRichTextGroups(line, TRANSCRIPT_BLOCK_TEXT_LIMIT);
    for (const richGroup of groups) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richGroup },
      });
    }
  }

  if (!blocks.length) {
    return [{
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText('なし') },
    }];
  }
  return blocks;
}

function buildFinalMemoBlocks(finalMemo: string, sourceUrls: string[]): NotionBlockInput[] {
  const blocks: NotionBlockInput[] = [
    {
      object: 'block',
      type: 'heading_1',
      heading_1: { rich_text: titleText(FINAL_MEMO_HEADING) },
    },
    ...markdownParagraphBlocks(finalMemo),
  ];
  if (sourceUrls.length) {
    blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: titleText('参考リンク') } });
    for (const url of sourceUrls) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: richText(url) },
      });
    }
  }
  return blocks;
}

export async function appendTranscriptBlocks(env: Env, pageId: string, record: InterviewRecord, transcriptFileUrl?: string): Promise<void> {
  const blocks = buildTranscriptBlocks(record, { transcriptFileUrl });
  if (!blocks.length) {
    return;
  }
  await appendBlockChildren(env, pageId, blocks);
}

export async function replaceTranscriptBlocks(env: Env, pageId: string, record: InterviewRecord, transcriptFileUrl?: string): Promise<void> {
  const children = await listBlockChildren(env, pageId);
  const managedBlockIds = collectManagedTranscriptBlockIds(children);
  for (const blockId of managedBlockIds) {
    await deleteBlock(env, blockId);
  }
  await appendTranscriptBlocks(env, pageId, record, transcriptFileUrl);
}

function collectManagedReviewBlockIds(children: NotionBlock[]): string[] {
  const ids: string[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const block = children[index];
    if (block.type !== 'heading_1' && block.type !== 'heading_2') continue;
    const text = block.type === 'heading_2'
      ? headingText(block)
      : ((block as unknown as { heading_1?: { rich_text?: Array<{ plain_text?: string }> } }).heading_1?.rich_text?.map((item) => item.plain_text ?? '').join('').trim() ?? '');
    if (text !== FINAL_MEMO_HEADING && text !== '参考リンク') continue;
    ids.push(block.id);
    for (let cursor = index + 1; cursor < children.length; cursor += 1) {
      const next = children[cursor];
      if (next.type === 'heading_1' || next.type === 'heading_2') break;
      ids.push(next.id);
    }
  }
  return ids;
}

export async function appendReviewedMemoToNotionPage(env: Env, pageId: string, reviewResult: InterviewReviewResult): Promise<void> {
  const children = await listBlockChildren(env, pageId);
  const managedIds = collectManagedReviewBlockIds(children);
  for (const blockId of managedIds) {
    await deleteBlock(env, blockId);
  }
  const blocks = [...buildFinalMemoBlocks(reviewResult.finalMemoMarkdown, reviewResult.sourceUrls)];
  if (blocks.length) {
    await appendBlockChildren(env, pageId, blocks);
  }
}

export async function writeFinalMemoToNotionPage(env: Env, pageId: string, finalMemo: string, sourceUrls: string[]): Promise<void> {
  const children = await listBlockChildren(env, pageId);
  const managedIds = collectManagedReviewBlockIds(children);
  for (const blockId of managedIds) {
    await deleteBlock(env, blockId);
  }
  const blocks = buildFinalMemoBlocks(finalMemo, sourceUrls);
  if (blocks.length) await appendBlockChildren(env, pageId, blocks);
}

export async function appendInterviewReviewFailureToNotionPage(
  env: Env,
  pageId: string,
  input: { message: string; error?: unknown },
): Promise<void> {
  const children = await listBlockChildren(env, pageId);
  const managedIds = collectManagedReviewBlockIds(children);
  for (const blockId of managedIds) {
    await deleteBlock(env, blockId);
  }

  const details = input.error instanceof Error ? input.error.message : input.error ? String(input.error) : '';
  const body = details ? `${input.message}\n${details}` : input.message;
  const blocks: NotionBlockInput[] = [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: titleText('レビュー情報') } },
    ...markdownParagraphBlocks(`二次レビュー失敗。一次要約とTranscriptのみ保存。\n${body}`),
  ];
  await appendBlockChildren(env, pageId, blocks);
}

export async function upsertInterviewPage(env: Env, record: InterviewRecord, existing: NotionPageMatch | null): Promise<{ pageId: string; created: boolean }> {
  const properties = cleanProperties(buildProperties(record));
  if (existing) {
    await notionFetch(env, `/pages/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    await replaceTranscriptBlocks(env, existing.id, record, record.request.dropboxSharedLink);
    return { pageId: existing.id, created: false };
  }

  const response = await notionFetch<{ id: string }>(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.INBOX_DB_ID },
      properties,
    }),
  });
  await appendTranscriptBlocks(env, response.id, record, record.request.dropboxSharedLink);
  return { pageId: response.id, created: true };
}


export async function saveTranscriptLinkToNotion(env: Env, pageId: string, transcriptUrl: string): Promise<{ usedProperty: boolean; fallbackToBody: boolean }> {
  const page = await notionFetch<{ properties?: Record<string, { type?: string }> }>(env, `/pages/${pageId}`, { method: 'GET' });
  const transcriptProp = page.properties?.['Transcript Link'];
  if (transcriptProp && transcriptProp.type === 'url') {
    await notionFetch(env, `/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { 'Transcript Link': { url: transcriptUrl } } }),
    });
    return { usedProperty: true, fallbackToBody: false };
  }

  await appendBlockChildren(env, pageId, [{
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: richText(`Transcript全文リンク: ${transcriptUrl}`),
    },
  }]);
  return { usedProperty: false, fallbackToBody: true };
}

export async function updateInterviewRecordProperties(env: Env, pageId: string, record: InterviewRecord): Promise<void> {
  const properties = cleanProperties(buildProperties(record));
  await notionFetch(env, `/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
}

function splitTaskCandidatesFromText(value: string): string[] {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*・]|\d+[.)]?)+\s*/, '').trim())
    .filter(Boolean);
}

function normalizeTaskText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function dedupeTaskTextsInRecording(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const normalized = normalizeTaskText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeMyTasksInput(myTasks: unknown): string[] {
  if (Array.isArray(myTasks)) {
    const expanded = myTasks.flatMap((item) => (typeof item === 'string' ? splitTaskCandidatesFromText(item) : []));
    return dedupeTaskTextsInRecording(expanded).filter((task) => !['なし', '不明', '未定', '特になし'].includes(task));
  }
  if (typeof myTasks === 'string') {
    return dedupeTaskTextsInRecording(splitTaskCandidatesFromText(myTasks)).filter((task) => !['なし', '不明', '未定', '特になし'].includes(task));
  }
  return [];
}

function findActionSectionBody(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const actionHeading = /^(?:■\s*)?(?:#{1,3}\s*)?(次アクション|次に取るべき行動|Action Items|Next Actions)\s*$/i;
  const nextHeading = /^(■\s+|#{1,3}\s+|【.+】)/;
  const start = lines.findIndex((line) => actionHeading.test(line.trim()));
  if (start < 0) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (nextHeading.test(line.trim())) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

export function extractTasksFromNextActionsMarkdown(markdown: string): string[] {
  return normalizeMyTasksInput(markdown);
}

export function extractTasksFromFinalMemoMarkdown(markdown: string): string[] {
  const section = findActionSectionBody(markdown);
  if (!section) return [];
  return normalizeMyTasksInput(section);
}

async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

export interface ImportMyTasksInput {
  recordingId: string;
  sourceInterviewPageId: string;
  myTasks: unknown;
}

async function signInboxPageId(pageId: string, secret: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(secret);
  const data = new TextEncoder().encode(pageId);
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(signature))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function buildInboxTriageChooseUrl(baseUrl: string | undefined, inboxPageId: string, signature: string): string | undefined {
  const normalizedBaseUrl = baseUrl?.trim().replace(/\/$/, '');
  if (!normalizedBaseUrl) return undefined;
  const query = new URLSearchParams({
    inbox_page_id: inboxPageId,
    sig: signature,
  });
  return `${normalizedBaseUrl}/move/choose?${query.toString()}`;
}

async function getInboxDatabasePropertyNames(env: Env): Promise<Set<string>> {
  const response = await notionFetch<{ properties?: Record<string, unknown> }>(env, `/databases/${env.INBOX_DB_ID}`, {
    method: 'GET',
  });
  return new Set(Object.keys(response.properties ?? {}));
}

export async function importMyTasksToInbox(
  env: Env,
  input: ImportMyTasksInput,
): Promise<{
  importedCount: number;
  skippedDuplicates: number;
  skippedBecauseMissingProperties: number;
  missingProperties: string[];
  normalizedTasks: string[];
  sourceInterviewUrl: string;
  importedTaskItems: Array<{
    taskText: string;
    inboxPageId: string;
    chooseUrl?: string;
    skippedDuplicate?: boolean;
  }>;
}> {
  const normalizedTasks = normalizeMyTasksInput(input.myTasks);
  const sourceInterviewUrl = notionPageUrl(input.sourceInterviewPageId);
  const inboxPropertyNames = await getInboxDatabasePropertyNames(env);
  const optionalPropertyPayload = cleanProperties({
    'Source Recording ID': inboxPropertyNames.has('Source Recording ID') ? { rich_text: richText(input.recordingId) } : undefined,
    'Source Interview Page ID': inboxPropertyNames.has('Source Interview Page ID') ? { rich_text: richText(input.sourceInterviewPageId) } : undefined,
    'Source Interview URL': inboxPropertyNames.has('Source Interview URL') ? { url: sourceInterviewUrl } : undefined,
  });
  const missingProperties = ['Source Recording ID', 'Source Interview Page ID', 'Source Interview URL'].filter(
    (property) => !inboxPropertyNames.has(property),
  );
  let importedCount = 0;
  let skippedDuplicates = 0;
  let skippedBecauseMissingProperties = 0;
  const importedTaskItems: Array<{
    taskText: string;
    inboxPageId: string;
    chooseUrl?: string;
    skippedDuplicate?: boolean;
  }> = [];
  const actionSecret = env.INBOX_TRIAGE_ACTION_SECRET?.trim();
  const triageBaseUrl = env.INBOX_TRIAGE_BASE_URL?.trim();

  const buildChooseUrl = async (inboxPageId: string | undefined, taskText: string): Promise<string | undefined> => {
    if (!inboxPageId) {
      logEvent('info', 'task_choose_url_skipped_missing_inbox_page_id', { recordingId: input.recordingId, taskText });
      return undefined;
    }
    if (!triageBaseUrl) {
      logEvent('info', 'task_choose_url_skipped_missing_base_url', { recordingId: input.recordingId, inboxPageId, taskText });
      return undefined;
    }
    if (!actionSecret) {
      logEvent('info', 'task_choose_url_skipped_missing_secret', { recordingId: input.recordingId, inboxPageId, taskText });
      return undefined;
    }
    const signature = await signInboxPageId(inboxPageId, actionSecret);
    const chooseUrl = buildInboxTriageChooseUrl(triageBaseUrl, inboxPageId, signature);
    logEvent('info', 'task_choose_url_created', { recordingId: input.recordingId, inboxPageId, taskText });
    return chooseUrl;
  };

  for (const taskText of normalizedTasks) {
    const taskHash = await sha256Hex(taskText);
    const dedupKey = `meeting-task:${input.recordingId}:${taskHash}`;
    const existing = await findPageByDedupKey(env, dedupKey);
    if (existing) {
      skippedDuplicates += 1;
      const chooseUrl = await buildChooseUrl(existing.id, taskText);
      importedTaskItems.push({
        taskText,
        inboxPageId: existing.id,
        chooseUrl,
        skippedDuplicate: true,
      });
      continue;
    }

    const created = await notionFetch<{ id: string }>(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: env.INBOX_DB_ID },
        properties: cleanProperties({
          Name: { title: titleText(taskText) },
          Source: { rich_text: richText('meeting_memo') },
          'Record Type': { select: { name: 'Task' } },
          ...optionalPropertyPayload,
          'Imported At': { date: { start: new Date().toISOString() } },
          'Dedup Key': { rich_text: richText(dedupKey) },
        }),
      }),
    });
    importedCount += 1;
    skippedBecauseMissingProperties += missingProperties.length;
    const chooseUrl = await buildChooseUrl(created.id, taskText);
    importedTaskItems.push({
      taskText,
      inboxPageId: created.id,
      chooseUrl,
      skippedDuplicate: false,
    });
  }

  return { importedCount, skippedDuplicates, skippedBecauseMissingProperties, missingProperties, normalizedTasks, sourceInterviewUrl, importedTaskItems };
}
