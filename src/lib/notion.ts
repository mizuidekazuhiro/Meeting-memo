import type { Env, InterviewRecord, NotionPageMatch } from '../types';
import { HttpError } from './http';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

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

function titleText(content: string) {
  return [{ type: 'text', text: { content } }];
}

function richText(content: string) {
  return [{ type: 'text', text: { content: content.slice(0, 1900) } }];
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '不明';
}

function buildProperties(record: InterviewRecord) {
  const recordedAt = record.request.recordedAt ?? record.metadata.client_modified ?? record.metadata.server_modified;
  return {
    Name: {
      title: titleText(record.title),
    },
    Source: {
      select: { name: record.request.source ?? 'Interview' },
    },
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
    Transcript: record.transcript ? { rich_text: richText(record.transcript.fullText) } : undefined,
    'Dropbox File Id': record.metadata.id ? { rich_text: richText(record.metadata.id) } : undefined,
    'Dropbox Link': record.metadata.shared_link ?? record.request.dropboxSharedLink ? { url: record.metadata.shared_link ?? record.request.dropboxSharedLink ?? null } : undefined,
    'Processing Status': { select: { name: record.processingStatus } },
    'Speaker Separation': { checkbox: Boolean(record.transcript?.segments.length) },
    'Error Message': record.errorMessage ? { rich_text: richText(record.errorMessage) } : undefined,
    'Raw JSON': { rich_text: richText(JSON.stringify({ transcript: record.transcript?.raw, insights: record.insights?.raw })) },
    'Imported At': { date: { start: new Date().toISOString() } },
    'Dedup Key': { rich_text: richText(record.dedupKey) },
  };
}

function cleanProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

export async function upsertInterviewPage(env: Env, record: InterviewRecord, existing: NotionPageMatch | null): Promise<{ pageId: string; created: boolean }> {
  const properties = cleanProperties(buildProperties(record));
  if (existing) {
    await notionFetch(env, `/pages/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    return { pageId: existing.id, created: false };
  }

  const response = await notionFetch<{ id: string }>(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.INBOX_DB_ID },
      properties,
    }),
  });
  return { pageId: response.id, created: true };
}
