import type { DropboxFileMetadata, Env, IntakeRequest, InterviewInsights, ProcessInterviewResult, RecordingJob, RecordingJobCallbackPayload, TranscriptResult } from '../types';
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
  const lookup = await findRecordingJobWithSource(env, {
    recordingId: payload.recordingId?.trim(),
    dropboxFileId: payload.dropboxFileId?.trim(),
    dropboxPathLower: normalizeDropboxPath(payload.dropboxPathLower),
  });
  const job = lookup.job;
  if (!job) {
    logEvent('error', 'callback_payload_invalid', {
      recordingId: payload.recordingId ?? null,
      dropboxFileId: payload.dropboxFileId ?? null,
      dropboxPathLower: payload.dropboxPathLower ?? null,
    });
    throw new HttpError('Recording job not found for callback.', 404, { phase: 'lookup_job' });
  }

  const now = new Date().toISOString();
  await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'callback_received', {
    callbackStatus: 'received',
    callbackReceivedAt: now,
    transcript: payload.transcript,
    sourceDurationSec: payload.sourceDurationSec,
    finalizeStatus: 'pending',
    lastError: undefined,
  });

  logEvent('info', 'callback_state_saved', {
    recordingId: job.recordingId,
    fileName: job.fileName,
    dropboxFileId: job.dropboxFileId,
    dropboxPathLower: job.dropboxPathLower,
    callbackReceivedAt: now,
  });

  return {
    action: 'processed',
    reason: 'Callback accepted and persisted. Finalization is deferred.',
    dedupCandidates: buildDedupCandidates(job.request, { id: job.dropboxFileId, path_lower: job.dropboxPathLower, name: job.fileName }),
  };
}

function ensureInterviewRecord(job: RecordingJob, transcript: TranscriptResult, insights?: InterviewInsights) {
  return {
    title: job.fileName ? `Interview Memo ${new Date().toISOString().slice(0, 10)} - ${job.fileName}` : 'Interview Memo',
    dedupKey: job.dropboxFileId ? `dropbox:id:${job.dropboxFileId}` : `fallback:${job.fileName}`,
    metadata: {
      id: job.dropboxFileId,
      path_lower: job.dropboxPathLower,
      name: job.fileName,
      size: job.sourceBytes,
      client_modified: job.clientModified,
      server_modified: job.serverModified,
    },
    request: job.request,
    transcript,
    insights,
    processingStatus: 'persisted' as const,
    errorMessage: job.errorMessage,
  };
}

export async function finalizeInterviewJob(env: Env, recordingId: string, options: { force?: boolean; forceEmail?: boolean } = {}): Promise<{ ok: boolean; status: string }> {
  const force = options.force === true;
  const forceEmail = options.forceEmail === true;
  const job = await getRecordingJob(env, { recordingId });
  if (!job) throw new HttpError('Recording job not found.', 404, { recordingId });

  if (job.finalizeStatus === 'completed' && !force && !forceEmail) {
    logEvent('info', 'finalize_skipped_already_completed', { recordingId });
    return { ok: true, status: 'already_completed' };
  }

  if (job.transcriptWrittenAt || job.summaryWrittenAt || job.reviewCompletedAt || job.emailSentAt) {
    logEvent('info', 'finalize_resume_detected', {
      recordingId,
      transcriptWrittenAt: job.transcriptWrittenAt ?? null,
      summaryWrittenAt: job.summaryWrittenAt ?? null,
      reviewCompletedAt: job.reviewCompletedAt ?? null,
      emailSentAt: job.emailSentAt ?? null,
    });
  }

  logEvent('info', 'finalize_started', { recordingId, force, forceEmail });
  await updateRecordingJobStatus(env, { recordingId }, 'finalizing', { finalizeStatus: 'running', lastError: undefined });

  const current = (await getRecordingJob(env, { recordingId }))!;
  if (!current.transcript) {
    await updateRecordingJobStatus(env, { recordingId }, 'failed', { finalizeStatus: 'failed', lastError: 'Transcript missing' });
    throw new HttpError('Transcript missing.', 400, { recordingId });
  }

  let mutable = current;
  let pageId = mutable.notionPageId;

  if (!mutable.transcriptWrittenAt || force) {
    logEvent('info', 'notion_transcript_append_started', { recordingId, fileName: mutable.fileName });
    const persisted = await upsertInterviewFromTranscript(env, mutable.request, {
      id: mutable.dropboxFileId,
      path_lower: mutable.dropboxPathLower,
      name: mutable.fileName,
      size: mutable.sourceBytes,
      client_modified: mutable.clientModified,
      server_modified: mutable.serverModified,
    }, mutable.transcript);
    pageId = persisted.pageId;
    const now = new Date().toISOString();
    await updateRecordingJobStatus(env, { recordingId }, 'transcribed', {
      transcriptWrittenAt: now,
      notionPageId: pageId,
      notionPageUrl: pageId ? buildNotionPageUrl(pageId) : undefined,
    });
    logEvent('info', 'notion_transcript_append_completed', { recordingId, notionPageId: pageId ?? null, notionPageUrl: pageId ? buildNotionPageUrl(pageId) : null });
    mutable = (await getRecordingJob(env, { recordingId }))!;
  } else {
    logEvent('info', 'notion_transcript_append_skipped_already_written', { recordingId, transcriptWrittenAt: mutable.transcriptWrittenAt });
  }

  let insights = mutable.transcript ? await summarizeInterview(env, mutable.transcript) : undefined;
  if (!mutable.summaryWrittenAt || force) {
    try {
      logEvent('info', 'summary_generation_started', { recordingId });
      insights = await summarizeInterview(env, mutable.transcript!);
      if (pageId) {
        const record = ensureInterviewRecord(mutable, mutable.transcript!, insights);
        await updateInterviewRecordProperties(env, pageId, record);
      }
      await updateRecordingJobStatus(env, { recordingId }, 'transcribed', { summaryWrittenAt: new Date().toISOString() });
      logEvent('info', 'summary_generation_completed', { recordingId });
      mutable = (await getRecordingJob(env, { recordingId }))!;
    } catch (error) {
      logEvent('error', 'summary_generation_failed', { recordingId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  if (shouldRunInterviewReview(env) && (!mutable.reviewCompletedAt || force)) {
    try {
      logEvent('info', 'review_started', { recordingId });
      const review = await reviewInterviewWithWebSearch(env, { transcript: mutable.transcript!, insights, title: mutable.fileName, fileName: mutable.fileName, notionPageUrl: pageId ? buildNotionPageUrl(pageId) : undefined });
      if (pageId) {
        await appendReviewedMemoToNotionPage(env, pageId, review, ensureInterviewRecord(mutable, mutable.transcript!, insights));
      }
      await updateRecordingJobStatus(env, { recordingId }, 'transcribed', { reviewCompletedAt: new Date().toISOString() });
      mutable = (await getRecordingJob(env, { recordingId }))!;
      logEvent('info', 'review_completed', { recordingId });
    } catch (error) {
      logEvent('error', 'review_failed', { recordingId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } else if (!shouldRunInterviewReview(env)) {
    logEvent('info', 'review_skipped_not_configured', { recordingId });
  }

  const canSendEmail = shouldSendCompletionEmail(env);
  if (!canSendEmail) {
    logEvent('warn', 'email_skipped_missing_config', { recordingId });
  } else if (!mutable.emailSentAt || force || forceEmail) {
    try {
      logEvent('info', 'email_send_started', { recordingId, fileName: mutable.fileName, notionPageUrl: mutable.notionPageUrl ?? null });
      await sendCompletionEmail(env, {
        subject: env.MAIL_SUBJECT_PREFIX ?? 'Interview Memo 完了通知',
        notionPageUrl: mutable.notionPageUrl ?? (pageId ? buildNotionPageUrl(pageId) : ''),
        summary: insights?.summary ?? '',
        transcript: mutable.transcript?.fullText ?? '',
        myTasks: [],
      });
      await updateRecordingJobStatus(env, { recordingId }, 'transcribed', { emailSentAt: new Date().toISOString() });
      logEvent('info', 'email_send_completed', { recordingId });
      mutable = (await getRecordingJob(env, { recordingId }))!;
    } catch (error) {
      logEvent('error', 'email_send_failed', { recordingId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } else {
    logEvent('info', 'email_skipped_already_sent', { recordingId, emailSentAt: mutable.emailSentAt });
  }

  await updateRecordingJobStatus(env, { recordingId }, 'completed', { finalizeStatus: 'completed', callbackStatus: 'succeeded', lastError: undefined });
  logEvent('info', 'finalize_completed', { recordingId });
  return { ok: true, status: 'completed' };
}

export async function getInterviewJobStatus(env: Env, recordingId: string): Promise<Record<string, unknown>> {
  const job = await getRecordingJob(env, { recordingId });
  if (!job) throw new HttpError('Recording job not found.', 404, { recordingId });
  return {
    recordingId: job.recordingId,
    fileName: job.fileName,
    status: job.status,
    callbackReceivedAt: job.callbackReceivedAt,
    transcriptWrittenAt: job.transcriptWrittenAt,
    summaryWrittenAt: job.summaryWrittenAt,
    reviewCompletedAt: job.reviewCompletedAt,
    emailSentAt: job.emailSentAt,
    finalizeStatus: job.finalizeStatus,
    lastError: job.lastError,
    notionPageId: job.notionPageId,
    notionPageUrl: job.notionPageUrl,
  };
}

export async function resendInterviewEmail(env: Env, recordingId: string, force = true): Promise<{ ok: boolean; status: string }> {
  return finalizeInterviewJob(env, recordingId, { force: false, forceEmail: force });
}
