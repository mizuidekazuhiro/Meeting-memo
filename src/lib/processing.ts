import type { DropboxFileMetadata, Env, IntakeRequest, ProcessInterviewResult, RecordingJob, RecordingJobCallbackPayload } from '../types';
import { buildDedupCandidates } from './dedup';
import { downloadDropboxFile } from './dropbox';
import { getCompletionEmailConfig, sendCompletionEmail, shouldSendCompletionEmail } from './gmail';
import { HttpError } from './http';
import { findRecordingJobWithSource, getRecordingJob, getRecordingJobStorageMeta, markJobFailed, normalizeDropboxPath, shouldSkipProcessingForExistingJob, updateRecordingJobStatus } from './jobs';
import { logEvent } from './logger';
import { appendInterviewReviewFailureToNotionPage, appendReviewedMemoToNotionPage, importMyTasksToInbox, updateInterviewRecordProperties, upsertInterviewFromTranscript } from './notion';
import { inspectAudioSource, MAX_TRANSCRIBE_DURATION_SEC, reviewInterviewWithWebSearch, summarizeInterview, transcribeWithDiarization } from './openai';
import type { InterviewReviewResult } from '../types';


function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildCallbackLookupRetryConfig(env: Env): { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } {
  const maxAttempts = Math.min(parsePositiveInt(env.CALLBACK_JOB_LOOKUP_MAX_ATTEMPTS, 6), 12);
  const baseDelayMs = Math.min(parsePositiveInt(env.CALLBACK_JOB_LOOKUP_BASE_DELAY_MS, 200), 2_000);
  const maxDelayMs = Math.min(parsePositiveInt(env.CALLBACK_JOB_LOOKUP_MAX_DELAY_MS, 1_600), 5_000);
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function getRetryDelayMs(attempt: number, config: { baseDelayMs: number; maxDelayMs: number }): number {
  if (attempt <= 1) return 0;
  const exponential = config.baseDelayMs * 2 ** (attempt - 2);
  return Math.min(exponential, config.maxDelayMs);
}

async function waitMs(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildNotionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

function normalizeEmailTasks(myTasks: string[] | undefined): Array<{ taskText: string; chooseUrl?: string }> {
  if (!Array.isArray(myTasks)) return [];
  return myTasks
    .map((task) => task.trim())
    .filter((task) => task.length > 0)
    .map((taskText) => ({ taskText }));
}

async function runPostPersistTasksAndEmail(
  env: Env,
  params: {
    job: RecordingJob;
    persisted: Awaited<ReturnType<typeof upsertInterviewFromTranscript>>;
    transcriptFullText?: string;
    summary?: string;
    review?: InterviewReviewResult;
    reviewError?: string;
  },
): Promise<void> {
  if (!params.persisted.pageId) return;
  const fallbackTasks = normalizeEmailTasks(params.persisted.record.insights?.myTasks);

  let imported = {
    importedCount: 0,
    skippedDuplicates: 0,
    skippedBecauseMissingProperties: 0,
    missingProperties: [] as string[],
    normalizedTasks: fallbackTasks.map((task) => task.taskText),
    sourceInterviewUrl: buildNotionPageUrl(params.persisted.pageId),
    importedTaskItems: fallbackTasks,
  };

  logEvent('info', 'my task import started', {
    recordingId: params.job.recordingId,
    pageId: params.persisted.pageId,
  });
  try {
    imported = await importMyTasksToInbox(env, {
      recordingId: params.job.recordingId,
      sourceInterviewPageId: params.persisted.pageId,
      myTasks: params.persisted.record.insights?.myTasks,
    });
    logEvent('info', 'my task import finished', {
      recordingId: params.job.recordingId,
      sourceInterviewPageId: params.persisted.pageId,
      importedCount: imported.importedCount,
      skippedDuplicates: imported.skippedDuplicates,
      skippedBecauseMissingProperties: imported.skippedBecauseMissingProperties,
      missingProperties: imported.missingProperties,
    });
  } catch (error) {
    logEvent('warn', 'my task import failed', {
      recordingId: params.job.recordingId,
      sourceInterviewPageId: params.persisted.pageId,
      importedCount: imported.importedCount,
      skippedDuplicates: imported.skippedDuplicates,
      skippedBecauseMissingProperties: imported.skippedBecauseMissingProperties,
      missingProperties: imported.missingProperties,
      details: error instanceof HttpError ? error.details : error instanceof Error ? error.message : String(error),
    });
  }

  if (!shouldSendCompletionEmail(env)) {
    return;
  }

  const latestJob = await getRecordingJob(env, { recordingId: params.job.recordingId });
  if (latestJob?.notificationSentAt) {
    logEvent('info', 'completion email skipped already sent', {
      recordingId: params.job.recordingId,
      notificationSentAt: latestJob.notificationSentAt,
    });
    return;
  }

  const emailTasks = imported.importedTaskItems.length ? imported.importedTaskItems : fallbackTasks;
  const completedAt = new Date().toISOString();
  const completionMailConfig = getCompletionEmailConfig(env);

  logEvent('info', 'completion email send started', {
    recordingId: params.job.recordingId,
    fileName: params.job.fileName,
    pageId: params.persisted.pageId,
    smtpHost: completionMailConfig.smtpHost,
    smtpPort: completionMailConfig.smtpPort,
    toCount: completionMailConfig.to.length,
    ccCount: completionMailConfig.cc.length,
    bccCount: completionMailConfig.bcc.length,
  });
  try {
    await sendCompletionEmail(env, {
      subject: env.MAIL_SUBJECT_PREFIX ?? 'Interview Memo 完了通知',
      notionPageUrl: buildNotionPageUrl(params.persisted.pageId),
      summary: params.summary ?? '',
      transcript: params.transcriptFullText ?? '',
      myTasks: emailTasks,
      review: params.review ? {
        summaryForEmail: params.review.summaryForEmail,
        correctedTermsMarkdown: params.review.correctedTermsMarkdown,
        uncertainItemsMarkdown: params.review.uncertainItemsMarkdown,
        nextActionsMarkdown: params.review.nextActionsMarkdown,
        humanCheckRequired: params.review.humanCheckRequired,
        humanCheckReason: params.review.humanCheckReason,
        sourceUrls: params.review.sourceUrls,
      } : undefined,
      reviewError: params.reviewError,
    });
    await updateRecordingJobStatus(env, { recordingId: params.job.recordingId }, 'persisted', {
      notificationSentAt: completedAt,
    });
    logEvent('info', 'completion email sent', {
      recordingId: params.job.recordingId,
      fileName: params.job.fileName,
      pageId: params.persisted.pageId,
      smtpHost: completionMailConfig.smtpHost,
      smtpPort: completionMailConfig.smtpPort,
      toCount: completionMailConfig.to.length,
      ccCount: completionMailConfig.cc.length,
      bccCount: completionMailConfig.bcc.length,
    });
  } catch (error) {
    logEvent('warn', 'completion email failed', {
      recordingId: params.job.recordingId,
      fileName: params.job.fileName,
      pageId: params.persisted.pageId,
      smtpHost: completionMailConfig.smtpHost,
      smtpPort: completionMailConfig.smtpPort,
      toCount: completionMailConfig.to.length,
      ccCount: completionMailConfig.cc.length,
      bccCount: completionMailConfig.bcc.length,
      details: error instanceof HttpError ? error.details : error instanceof Error ? error.message : String(error),
    });
  }
}

function shouldRunInterviewReview(env: Env): boolean {
  return env.INTERVIEW_REVIEW_ENABLED?.toLowerCase() !== 'false';
}

export function shouldAttemptDirectWorkerTranscription(metadata: DropboxFileMetadata, durationSec: number | undefined): boolean {
  const extension = metadata.name.includes('.') ? metadata.name.split('.').pop()?.toLowerCase() : '';
  if (durationSec !== undefined && durationSec > MAX_TRANSCRIBE_DURATION_SEC) return false;
  if (extension === 'wav') return true;
  return durationSec !== undefined && durationSec <= MAX_TRANSCRIBE_DURATION_SEC;
}

function resolvePythonTranscribeDispatchUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    throw new HttpError(
      'Python transcribe API URL is not configured. Set PYTHON_TRANSCRIBE_API_URL to the base URL of the Python service, for example https://your-service.example.com',
      500,
    );
  }
  const normalized = baseUrl.trim().replace(/\/$/, '');
  if (!normalized) {
    throw new HttpError(
      'Python transcribe API URL is not configured. Set PYTHON_TRANSCRIBE_API_URL to the base URL of the Python service, for example https://your-service.example.com',
      500,
    );
  }
  return `${normalized}/jobs/transcribe`;
}

export async function dispatchLongAudioJob(env: Env, job: RecordingJob, metadata: DropboxFileMetadata): Promise<void> {
  const dispatchUrl = resolvePythonTranscribeDispatchUrl(env.PYTHON_TRANSCRIBE_API_URL);
  const callbackUrl = env.WORKERS_CALLBACK_BASE_URL ? `${env.WORKERS_CALLBACK_BASE_URL}/api/interviews/transcription-callback` : undefined;

  logEvent('info', 'transcription dispatched', {
    recordingId: job.recordingId,
    callbackUrl,
    details: {
      dispatchUrl,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
    },
  });

  const response = await fetch(dispatchUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.PYTHON_TRANSCRIBE_API_TOKEN ?? ''}`,
    },
    body: JSON.stringify({
      recordingId: job.recordingId,
      dropboxFileId: metadata.id,
      dropboxPathLower: metadata.path_lower,
      fileName: metadata.name,
      sourceBytes: metadata.size,
      sourceDurationSec: job.sourceDurationSec,
      client_modified: metadata.client_modified,
      server_modified: metadata.server_modified,
      request: job.request,
      callbackUrl,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    logEvent('error', 'python service dispatch failed', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: { responseStatus: response.status, responseText },
    });
    throw new HttpError('Python API dispatch failed.', 502, { responseStatus: response.status, responseText });
  }
}

export async function processUploadedInterview(
  env: Env,
  request: IntakeRequest,
  metadata: DropboxFileMetadata,
  job: RecordingJob,
  options: { dryRun?: boolean; forcePythonTranscription?: boolean } = {},
): Promise<ProcessInterviewResult> {
  const dedupCandidates = buildDedupCandidates(request, metadata);
  const duplicateGate = shouldSkipProcessingForExistingJob(job);
  if (duplicateGate.shouldSkip) {
    logEvent('info', 'upload processing skipped', {
      recordingId: job.recordingId,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      existingStatus: job.status,
      skipReason: duplicateGate.reason,
      dispatchExecuted: false,
    });
    return { action: 'skipped', reason: `Duplicate upload skipped: ${duplicateGate.reason}.`, dedupCandidates };
  }

  if (options.dryRun) {
    return { action: 'processed', reason: 'Dry run: job created from Dropbox upload metadata.', dedupCandidates, record: undefined };
  }

  let audio: Blob | undefined;
  let durationSec = job.sourceDurationSec;
  try {
    audio = await downloadDropboxFile(env, metadata);
    const inspected = await inspectAudioSource(audio, metadata.name);
    durationSec = inspected.durationSec;
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'queued', { sourceDurationSec: durationSec, sourceBytes: inspected.bytes });

    if (!options.forcePythonTranscription && shouldAttemptDirectWorkerTranscription(metadata, durationSec)) {
      await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribing');
      const transcript = await transcribeWithDiarization(env, audio, metadata.name, request.languageHint, {
        recordingId: job.recordingId,
        dropboxFileId: job.dropboxFileId,
        dropboxPathLower: job.dropboxPathLower,
      });
      await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribed', { transcript });
      let insights;
      let summaryError: string | undefined;
      let summaryErrorDetails: unknown;
      let summaryRaw: unknown;
      try {
        insights = await summarizeInterview(env, transcript);
      } catch (error) {
        summaryError = error instanceof Error ? error.message : 'summary generation failed';
        summaryErrorDetails = error instanceof HttpError ? error.details : error;
        summaryRaw = error instanceof HttpError && error.details && typeof error.details === 'object' && 'payload' in (error.details as Record<string, unknown>)
          ? (error.details as Record<string, unknown>).payload
          : undefined;
        logEvent('warn', 'summary generation recovered with transcript-only persistence', {
          recordingId: job.recordingId,
          fileName: job.fileName,
          dropboxFileId: job.dropboxFileId,
          dropboxPathLower: job.dropboxPathLower,
          details: summaryErrorDetails,
        });
      }
      let persisted;
      try {
        persisted = await upsertInterviewFromTranscript(env, request, metadata, transcript, insights, {
          errorMessage: summaryError,
          summaryRaw: insights?.raw ?? summaryRaw,
          summaryErrorMessage: summaryError,
          summaryErrorDetails,
        });
      } catch (error) {
        logEvent('error', 'notion persistence failed', {
          recordingId: job.recordingId,
          fileName: job.fileName,
          dropboxFileId: job.dropboxFileId,
          dropboxPathLower: job.dropboxPathLower,
          details: error instanceof HttpError ? error.details : error,
        });
        throw error;
      }
      let reviewResult: InterviewReviewResult | undefined;
      let reviewError: string | undefined;
      try {
        if (shouldRunInterviewReview(env)) {
          reviewResult = await reviewInterviewWithWebSearch(env, {
            transcript,
            insights,
            title: persisted.record.title,
            fileName: metadata.name,
            notionPageUrl: persisted.pageId ? buildNotionPageUrl(persisted.pageId) : undefined,
          });
          if (persisted.pageId) {
            await updateInterviewRecordProperties(env, persisted.pageId, persisted.record);
            await appendReviewedMemoToNotionPage(env, persisted.pageId, reviewResult, persisted.record);
          }
          persisted.record.insights = {
            summary: reviewResult.summaryForEmail || persisted.record.insights?.summary || '',
            myTasks: reviewResult.myTasks.length
              ? reviewResult.myTasks
              : persisted.record.insights?.myTasks ?? [],
            otherTasks: reviewResult.otherTasks.length
              ? reviewResult.otherTasks
              : persisted.record.insights?.otherTasks ?? [],
            ambiguities: persisted.record.insights?.ambiguities ?? [],
            raw: {
              ...(persisted.record.insights?.raw && typeof persisted.record.insights.raw === 'object' ? persisted.record.insights.raw as Record<string, unknown> : {}),
              review: reviewResult.raw ?? reviewResult,
            },
          };
        }
      } catch (error) {
        reviewError = '二次レビューは失敗しました。一次要約とTranscriptのみ保存されています。';
        const reviewFailureMessage = '二次レビュー失敗。一次要約とTranscriptのみ保存。';
        persisted.record.errorMessage = persisted.record.errorMessage
          ? `${persisted.record.errorMessage}\n${reviewFailureMessage}`
          : reviewFailureMessage;
        logEvent('warn', 'interview review failed; continuing with primary summary', {
          recordingId: job.recordingId,
          fileName: job.fileName,
          details: error instanceof HttpError ? error.details : error instanceof Error ? error.message : String(error),
        });
        try {
          if (persisted.pageId) {
            await updateInterviewRecordProperties(env, persisted.pageId, persisted.record);
            await appendInterviewReviewFailureToNotionPage(env, persisted.pageId, {
              message: '二次レビュー失敗。一次要約とTranscriptのみ保存。',
              error,
            });
          }
        } catch (notionError) {
          logEvent('warn', 'failed to append review failure note to Notion', {
            recordingId: job.recordingId,
            fileName: job.fileName,
            details: notionError instanceof Error ? notionError.message : String(notionError),
          });
        }
      }

      await runPostPersistTasksAndEmail(env, {
        job,
        persisted,
        transcriptFullText: transcript.fullText,
        summary: persisted.record.insights?.summary ?? insights?.summary,
        review: reviewResult,
        reviewError,
      });
      await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'persisted', { errorMessage: summaryError });
      return {
        action: 'processed',
        reason: summaryError ? 'Processed in Workers, transcript persisted to Notion, summary failed.' : 'Processed in Workers and persisted to Notion.',
        pageId: persisted.pageId,
        created: persisted.created,
        dedupCandidates,
        record: persisted.record,
      };
    }

    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcoding', { sourceDurationSec: durationSec });
    await dispatchLongAudioJob(env, job, metadata);
    return { action: 'processed', reason: 'Long audio delegated to Python transcription API service.', dedupCandidates };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown processing error';
    await markJobFailed(env, { recordingId: job.recordingId }, message);
    logEvent('error', 'processing pipeline failed', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: error instanceof HttpError ? error.details : message,
    });
    if (error instanceof HttpError) throw error;
    throw new HttpError(message, 500, error);
  }
}

export async function persistTranscriptionCallback(env: Env, payload: RecordingJobCallbackPayload): Promise<ProcessInterviewResult> {
  const recordingId = payload.recordingId?.trim();
  const dropboxFileId = payload.dropboxFileId?.trim();
  const rawDropboxPathLower = payload.dropboxPathLower;
  const dropboxPathLower = normalizeDropboxPath(payload.dropboxPathLower);
  const fileName = payload.fileName?.trim();
  const storageMeta = getRecordingJobStorageMeta(env);
  const retryConfig = buildCallbackLookupRetryConfig(env);

  logEvent('info', 'recording job lookup started', {
    event: 'recording job lookup started',
    recordingId: recordingId ?? null,
    dropboxFileId: dropboxFileId ?? null,
    dropboxPathLower: dropboxPathLower ?? null,
    fileName: fileName ?? null,
    requestId: payload.requestId ?? null,
    rawValues: {
      recordingId: payload.recordingId ?? null,
      dropboxFileId: payload.dropboxFileId ?? null,
      dropboxPathLower: rawDropboxPathLower ?? null,
      fileName: payload.fileName ?? null,
    },
    normalizedValues: {
      recordingId: recordingId ?? null,
      dropboxFileId: dropboxFileId ?? null,
      dropboxPathLower: dropboxPathLower ?? null,
      fileName: fileName ?? null,
    },
    retryConfig,
    storageType: storageMeta.storageType,
    storageModeDecision: storageMeta.storageModeDecision,
  });

  let lookup: Awaited<ReturnType<typeof findRecordingJobWithSource>> | null = null;
  let lastAttempt = 0;
  let totalWaitMs = 0;
  const lastTriedSources: string[] = [];

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    const waitedMs = getRetryDelayMs(attempt, retryConfig);
    if (waitedMs > 0) {
      await waitMs(waitedMs);
      totalWaitMs += waitedMs;
    }

    logEvent('info', 'recording job lookup attempt', {
      event: 'recording job lookup attempt',
      attempt,
      waitedMs,
      totalWaitMs,
      recordingId: recordingId ?? null,
      dropboxFileId: dropboxFileId ?? null,
      dropboxPathLower: dropboxPathLower ?? null,
      fileName: fileName ?? null,
      requestId: payload.requestId ?? null,
      storageType: storageMeta.storageType,
      storageModeDecision: storageMeta.storageModeDecision,
    });

    lookup = await findRecordingJobWithSource(env, { recordingId, dropboxFileId, dropboxPathLower });
    lastAttempt = attempt;
    lastTriedSources.push(lookup.source ?? 'none');
    if (lookup.job) break;
  }

  const job = lookup?.job;
  if (!job) {
    const transcriptPreview = payload.transcript?.fullText ? payload.transcript.fullText.slice(0, 512) : '';
    logEvent('error', 'recording job lookup not found', {
      event: 'recording job lookup not found',
      recordingId: recordingId ?? null,
      dropboxFileId: dropboxFileId ?? null,
      dropboxPathLower: dropboxPathLower ?? null,
      fileName: fileName ?? null,
      requestId: payload.requestId ?? null,
      transcriptPreview,
      transcriptPreviewLength: transcriptPreview.length,
      transcriptSegmentCount: payload.transcript?.segments?.length ?? 0,
      attempts: lastAttempt,
      totalWaitMs,
      lastTriedSources,
      storageType: storageMeta.storageType,
      storageModeDecision: storageMeta.storageModeDecision,
    });
    throw new HttpError('Recording job not found for callback.', 404, {
      phase: 'lookup_job',
      attempts: lastAttempt,
      totalWaitMs,
      recordingId: recordingId ?? null,
      dropboxFileId: dropboxFileId ?? null,
      dropboxPathLower: dropboxPathLower ?? null,
    });
  }

  logEvent('info', 'recording job lookup hit', {
    foundBy: lookup?.source,
    attempts: lastAttempt,
    totalWaitMs,
    recordingId: job.recordingId,
    fileName: job.fileName,
    requestId: payload.requestId ?? null,
    internalKey: `recordingJob:recordingId:${job.recordingId}`,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: job.dropboxPathLower,
    storageType: storageMeta.storageType,
    storageModeDecision: storageMeta.storageModeDecision,
  });

  if (job.status === 'persisted' && job.callbackStatus === 'persisted') {
    logEvent('info', 'callback duplicate ignored', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      requestId: payload.requestId ?? null,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      status: job.status,
      storageType: storageMeta.storageType,
      storageModeDecision: storageMeta.storageModeDecision,
      callbackPersistedOrSkipped: 'skipped',
    });
    return {
      action: 'processed',
      reason: 'Duplicate callback ignored because recording job is already persisted.',
      dedupCandidates: buildDedupCandidates(job.request, {
        id: job.dropboxFileId,
        path_lower: job.dropboxPathLower,
        name: job.fileName,
      }),
    };
  }

  const metadata: DropboxFileMetadata = {
    id: job.dropboxFileId,
    path_lower: job.dropboxPathLower ?? dropboxPathLower,
    name: job.fileName || fileName || 'unknown-audio',
    size: job.sourceBytes,
    client_modified: job.clientModified,
    server_modified: job.serverModified,
  };

  logEvent('info', 'callback phase started', {
    phase: 'persist_transcript',
    recordingId: job.recordingId,
    fileName: job.fileName,
    requestId: payload.requestId ?? null,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: job.dropboxPathLower,
    storageType: storageMeta.storageType,
    storageModeDecision: storageMeta.storageModeDecision,
  });
  try {
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribed', {
      transcript: payload.transcript,
      sourceDurationSec: payload.sourceDurationSec,
      callbackStatus: 'received',
    });
  } catch (error) {
    await markJobFailed(env, { recordingId: job.recordingId }, error instanceof Error ? error.message : 'callback failed', { callbackStatus: 'failed' });
    throw error;
  }

  let insights;
  let summaryError: string | undefined;
  let summaryErrorDetails: unknown;
  let summaryRaw: unknown;
  try {
    insights = await summarizeInterview(env, payload.transcript);
  } catch (error) {
    summaryError = error instanceof Error ? error.message : 'summary generation failed';
    summaryErrorDetails = error instanceof HttpError ? error.details : error;
    summaryRaw = error instanceof HttpError && error.details && typeof error.details === 'object' && 'payload' in (error.details as Record<string, unknown>)
      ? (error.details as Record<string, unknown>).payload
      : undefined;
    logEvent('warn', 'summary generation recovered with transcript-only persistence', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      requestId: payload.requestId ?? null,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: summaryErrorDetails,
    });
  }

  let persisted: Awaited<ReturnType<typeof upsertInterviewFromTranscript>>;
  try {
    persisted = await upsertInterviewFromTranscript(env, job.request, metadata, payload.transcript, insights, {
      errorMessage: summaryError,
      summaryRaw: insights?.raw ?? summaryRaw,
      summaryErrorMessage: summaryError,
      summaryErrorDetails,
    });
  } catch (error) {
    await markJobFailed(env, { recordingId: job.recordingId }, error instanceof Error ? error.message : 'callback failed', { callbackStatus: 'failed' });
    logEvent('error', 'notion persistence failed', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      requestId: payload.requestId ?? null,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: error instanceof HttpError ? error.details : error,
    });
    throw error;
  }

  let reviewResult: InterviewReviewResult | undefined;
  let reviewError: string | undefined;
  try {
    if (shouldRunInterviewReview(env)) {
      reviewResult = await reviewInterviewWithWebSearch(env, {
        transcript: payload.transcript,
        insights,
        title: persisted.record.title,
        fileName: metadata.name,
        notionPageUrl: persisted.pageId ? buildNotionPageUrl(persisted.pageId) : undefined,
      });
      if (persisted.pageId) {
        await updateInterviewRecordProperties(env, persisted.pageId, persisted.record);
        await appendReviewedMemoToNotionPage(env, persisted.pageId, reviewResult, persisted.record);
      }
      persisted.record.insights = {
        summary: reviewResult.summaryForEmail || persisted.record.insights?.summary || '',
        myTasks: reviewResult.myTasks.length
          ? reviewResult.myTasks
          : persisted.record.insights?.myTasks ?? [],
        otherTasks: reviewResult.otherTasks.length
          ? reviewResult.otherTasks
          : persisted.record.insights?.otherTasks ?? [],
        ambiguities: persisted.record.insights?.ambiguities ?? [],
        raw: {
          ...(persisted.record.insights?.raw && typeof persisted.record.insights.raw === 'object' ? persisted.record.insights.raw as Record<string, unknown> : {}),
          review: reviewResult.raw ?? reviewResult,
        },
      };
    }
  } catch (error) {
    reviewError = '二次レビューは失敗しました。一次要約とTranscriptのみ保存されています。';
    const reviewFailureMessage = '二次レビュー失敗。一次要約とTranscriptのみ保存。';
    persisted.record.errorMessage = persisted.record.errorMessage
      ? `${persisted.record.errorMessage}\n${reviewFailureMessage}`
      : reviewFailureMessage;
    logEvent('warn', 'interview review failed; continuing with primary summary', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      details: error instanceof HttpError ? error.details : error instanceof Error ? error.message : String(error),
    });
    try {
      if (persisted.pageId) {
        await updateInterviewRecordProperties(env, persisted.pageId, persisted.record);
        await appendInterviewReviewFailureToNotionPage(env, persisted.pageId, {
          message: '二次レビュー失敗。一次要約とTranscriptのみ保存。',
          error,
        });
      }
    } catch (notionError) {
      logEvent('warn', 'failed to append review failure note to Notion', {
        recordingId: job.recordingId,
        fileName: job.fileName,
        details: notionError instanceof Error ? notionError.message : String(notionError),
      });
    }
  }

  await runPostPersistTasksAndEmail(env, {
    job,
    persisted,
    transcriptFullText: payload.transcript.fullText,
    summary: persisted.record.insights?.summary ?? insights?.summary,
    review: reviewResult,
    reviewError,
  });

  logEvent('info', 'callback phase started', {
    phase: 'update_status',
    recordingId: job.recordingId,
    fileName: job.fileName,
    requestId: payload.requestId ?? null,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: job.dropboxPathLower,
    storageType: storageMeta.storageType,
    storageModeDecision: storageMeta.storageModeDecision,
  });
  try {
    await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'persisted', {
      transcript: payload.transcript,
      sourceDurationSec: payload.sourceDurationSec,
      callbackStatus: 'persisted',
      errorMessage: summaryError,
    });
    logEvent('info', 'recording job status updated', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      requestId: payload.requestId ?? null,
      status: 'persisted',
      callbackStatus: 'persisted',
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      storageType: storageMeta.storageType,
      storageModeDecision: storageMeta.storageModeDecision,
    });
  } catch (error) {
    logEvent('warn', 'status update failed after notion persisted', {
      recordingId: job.recordingId,
      fileName: job.fileName,
      requestId: payload.requestId ?? null,
      dropboxFileId: job.dropboxFileId,
      dropboxPathLower: job.dropboxPathLower,
      details: error instanceof HttpError ? error.details : error,
    });
    return {
      action: 'processed',
      reason: summaryError
        ? 'Python API callback persisted transcript to Notion (summary failed, status update failed after Notion persistence).'
        : 'Python API callback persisted to Notion; status update failed after Notion persistence.',
      pageId: persisted.pageId,
      created: persisted.created,
      dedupCandidates: buildDedupCandidates(job.request, metadata),
      record: persisted.record,
    };
  }

  return {
    action: 'processed',
    reason: summaryError ? 'Python API callback transcript persisted to Notion, summary failed.' : 'Python API callback persisted to Notion.',
    pageId: persisted.pageId,
    created: persisted.created,
    dedupCandidates: buildDedupCandidates(job.request, metadata),
    record: persisted.record,
  };
}
