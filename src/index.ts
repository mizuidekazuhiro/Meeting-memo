import { buildDedupCandidates, primaryDedupKey } from './lib/dedup';
import { downloadDropboxFile, fetchDropboxMetadata } from './lib/dropbox';
import { HttpError, jsonResponse, parseJson } from './lib/http';
import { findExistingInterview, upsertInterviewPage } from './lib/notion';
import { summarizeInterview, transcribeWithDiarization } from './lib/openai';
import { requireWebhookSecret } from './lib/security';
import type { Env, IntakeRequest, InterviewRecord } from './types';

function buildTitle(request: IntakeRequest, metadataName: string): string {
  const date = request.recordedAt ? new Date(request.recordedAt) : new Date();
  const safeDate = Number.isNaN(date.valueOf()) ? 'Interview Memo' : `Interview Memo ${date.toISOString().slice(0, 10)}`;
  return request.fileName ? `${safeDate} - ${request.fileName}` : `${safeDate} - ${metadataName}`;
}

async function handleIntake(request: Request, env: Env): Promise<Response> {
  requireWebhookSecret(request, env.INTERVIEW_WEBHOOK_SECRET);
  const intake = await parseJson<IntakeRequest>(request);
  const metadata = await fetchDropboxMetadata(env, intake);
  const dedupCandidates = buildDedupCandidates(intake, metadata);
  const existing = await findExistingInterview(env, dedupCandidates);

  const record: InterviewRecord = {
    title: buildTitle(intake, metadata.name),
    dedupKey: primaryDedupKey(intake, metadata),
    metadata: { ...metadata, shared_link: intake.dropboxSharedLink },
    request: intake,
    processingStatus: 'pending',
  };

  try {
    const audio = await downloadDropboxFile(env, metadata);
    record.transcript = await transcribeWithDiarization(env, audio, intake.fileName ?? metadata.name, intake.languageHint);
    record.insights = await summarizeInterview(env, record.transcript);
    record.processingStatus = 'completed';
  } catch (error) {
    record.processingStatus = 'error';
    record.errorMessage = error instanceof Error ? error.message : 'Unknown processing error';
  }

  const result = await upsertInterviewPage(env, record, existing);
  return jsonResponse({
    ok: record.processingStatus === 'completed',
    status: record.processingStatus,
    created: result.created,
    pageId: result.pageId,
    dedupCandidates,
    errorMessage: record.errorMessage,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/api/interviews/intake') {
        return await handleIntake(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({ ok: true, env: env.APP_ENV ?? 'unknown' });
      }
      return jsonResponse({ ok: false, message: 'Not Found' }, { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ ok: false, message: error.message, details: error.details }, { status: error.status });
      }
      return jsonResponse({ ok: false, message: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }
  },
};
