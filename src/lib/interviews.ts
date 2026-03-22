import type { DropboxFileMetadata, Env, IntakeRequest, InterviewRecord, ProcessInterviewResult } from '../types';
import { buildDedupCandidates, primaryDedupKey } from './dedup';
import { downloadDropboxFile } from './dropbox';
import { findExistingInterview, upsertInterviewPage } from './notion';
import { summarizeInterview, transcribeWithDiarization } from './openai';

function buildTitle(request: IntakeRequest, metadataName: string): string {
  const date = request.recordedAt ? new Date(request.recordedAt) : new Date();
  const safeDate = Number.isNaN(date.valueOf()) ? 'Interview Memo' : `Interview Memo ${date.toISOString().slice(0, 10)}`;
  return request.fileName ? `${safeDate} - ${request.fileName}` : `${safeDate} - ${metadataName}`;
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

  try {
    const audio = await downloadDropboxFile(env, metadata);
    record.transcript = await transcribeWithDiarization(env, audio, request.fileName ?? metadata.name, request.languageHint);
    record.insights = await summarizeInterview(env, record.transcript);
    record.processingStatus = 'completed';
  } catch (error) {
    record.processingStatus = 'error';
    record.errorMessage = error instanceof Error ? error.message : 'Unknown processing error';
  }

  const result = await upsertInterviewPage(env, record, existing);
  return {
    action: record.processingStatus === 'completed' ? 'processed' : 'error',
    reason: record.processingStatus === 'completed' ? 'Processed and upserted into Notion.' : record.errorMessage ?? 'Unknown processing error',
    pageId: result.pageId,
    created: result.created,
    dedupCandidates,
    record,
  };
}
