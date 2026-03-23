import type { DropboxFileMetadata, Env, IntakeRequest, InterviewRecord, ProcessInterviewResult } from '../types';
import { buildDedupCandidates, primaryDedupKey } from './dedup';
import { downloadDropboxFile } from './dropbox';
import { HttpError } from './http';
import { findExistingInterview, upsertInterviewPage } from './notion';
import { summarizeInterview, transcribeWithDiarization } from './openai';

function buildTitle(request: IntakeRequest, metadataName: string): string {
  const date = request.recordedAt ? new Date(request.recordedAt) : new Date();
  const safeDate = Number.isNaN(date.valueOf()) ? 'Interview Memo' : `Interview Memo ${date.toISOString().slice(0, 10)}`;
  return request.fileName ? `${safeDate} - ${request.fileName}` : `${safeDate} - ${metadataName}`;
}

async function processInterviewRecord(
  env: Env,
  request: IntakeRequest,
  metadata: DropboxFileMetadata,
  record: InterviewRecord,
  existing: Awaited<ReturnType<typeof findExistingInterview>>,
): Promise<ProcessInterviewResult> {
  try {
    const audio = await downloadDropboxFile(env, metadata);
    record.transcript = await transcribeWithDiarization(env, audio, request.fileName ?? metadata.name, request.languageHint);
    record.insights = await summarizeInterview(env, record.transcript);
    record.processingStatus = 'completed';
  } catch (error) {
    record.processingStatus = 'error';
    const stage = error instanceof HttpError && typeof error.details === 'object' && error.details && 'responseStatus' in (error.details as Record<string, unknown>)
      ? 'openai'
      : 'processing';
    const baseMessage = error instanceof Error ? error.message : 'Unknown processing error';
    record.errorMessage = `[${stage}] ${baseMessage}`;
    console.error('interviews.process.processing_failed', {
      fileName: request.fileName ?? metadata.name,
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      message: record.errorMessage,
      details: error instanceof HttpError ? error.details : undefined,
    });
  }

  try {
    const result = await upsertInterviewPage(env, record, existing);
    return {
      action: record.processingStatus === 'completed' ? 'processed' : 'error',
      reason: record.processingStatus === 'completed' ? 'Processed and upserted into Notion.' : record.errorMessage ?? 'Unknown processing error',
      pageId: result.pageId,
      created: result.created,
      dedupCandidates: buildDedupCandidates(request, metadata),
      record,
    };
  } catch (error) {
    console.error('interviews.process.notion_failed', {
      fileName: request.fileName ?? metadata.name,
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      message: error instanceof Error ? error.message : 'Unknown Notion error',
      details: error instanceof HttpError ? error.details : undefined,
    });
    throw new HttpError('Notion registration failed.', 502, {
      fileName: request.fileName ?? metadata.name,
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      cause: error instanceof HttpError ? error.details : error instanceof Error ? error.message : error,
    });
  }
}

export async function processInterviewFromMetadata(
  env: Env,
  request: IntakeRequest,
  metadata: DropboxFileMetadata,
  options: { dryRun?: boolean; skipIfExisting?: boolean } = {},
): Promise<ProcessInterviewResult> {
  const dedupCandidates = buildDedupCandidates(request, metadata);
  const existing = await findExistingInterview(env, dedupCandidates);

  if (existing && options.skipIfExisting) {
    return {
      action: 'skipped',
      reason: 'Existing Notion page matched by dedup key.',
      pageId: existing.id,
      dedupCandidates,
    };
  }

  const record: InterviewRecord = {
    title: buildTitle(request, metadata.name),
    dedupKey: primaryDedupKey(request, metadata),
    metadata: { ...metadata, shared_link: request.dropboxSharedLink },
    request,
    processingStatus: 'pending',
  };

  if (options.dryRun) {
    return {
      action: 'processed',
      reason: 'Dry run: file would be downloaded, transcribed, summarized, and inserted into Notion.',
      dedupCandidates,
      record,
    };
  }

  return processInterviewRecord(env, request, metadata, record, existing);
}
