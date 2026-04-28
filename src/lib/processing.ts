import type { DropboxFileMetadata, Env, IntakeRequest, InterviewInsights, ProcessInterviewResult, RecordingJob, RecordingJobCallbackPayload, TranscriptResult } from '../types';
import { buildDedupCandidates } from './dedup';
import { downloadDropboxFile, getOrCreateDropboxSharedLink, sanitizeDropboxFileName, sha256Hex, uploadTextFileToDropbox } from './dropbox';
import { getCompletionEmailConfig, sendCompletionEmail, shouldSendCompletionEmail } from './gmail';
import { HttpError } from './http';
import { findRecordingJobWithSource, getRecordingJob, getRecordingJobStorageMeta, markJobFailed, normalizeDropboxPath, shouldSkipProcessingForExistingJob, updateRecordingJobStatus } from './jobs';
import { logEvent } from './logger';
import { appendInterviewReviewFailureToNotionPage, extractTasksFromFinalMemoMarkdown, extractTasksFromNextActionsMarkdown, importMyTasksToInbox, saveTranscriptLinkToNotion, updateInterviewRecordProperties, upsertInterviewFromTranscript, writeFinalMemoToNotionPage } from './notion';
import { inspectAudioSource, MAX_TRANSCRIBE_DURATION_SEC, resolveTranscriptionLanguage, reviewInterviewWithWebSearch, summarizeInterview, transcribeWithDiarization } from './openai';
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

export function renderTranscriptText(transcript: TranscriptResult): string {
  if (transcript.segments.length) {
    return transcript.segments.map((segment) => `[${segment.speaker || 'speaker_unknown'}] ${segment.text ?? ''}`.trim()).join('\n');
  }
  return transcript.fullText;
}

const SPEAKER_LABEL_PATTERN = /^\s*\[[^\]]+\]\s*/;
const ENGLISH_NOISE_PATTERNS = [
  /\bwell\b/gi,
  /\bi don't know\b/gi,
  /\boh okay\b/gi,
  /\bi can't breathe\b/gi,
];

function isDiarizationEnabled(env: Env): boolean {
  return env.TRANSCRIBE_DIARIZATION_ENABLED?.toLowerCase() === 'true';
}

function removeSpeakerLabel(text: string): string {
  return text.replace(SPEAKER_LABEL_PATTERN, '').trim();
}

function removeEnglishNoise(text: string): { cleanedText: string; removedCount: number } {
  let next = text;
  let removedCount = 0;
  for (const pattern of ENGLISH_NOISE_PATTERNS) {
    const matches = next.match(pattern);
    if (matches) removedCount += matches.length;
    next = next.replace(pattern, ' ');
  }
  return { cleanedText: next.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), removedCount };
}

export function sanitizeTranscriptForMemo(transcript: TranscriptResult, language: 'ja' | 'en' = 'ja'): { transcript: TranscriptResult; noiseRemovedCount: number } {
  const shouldRemoveEnglishNoise = language === 'ja';
  if (transcript.segments.length === 0) {
    const base = removeSpeakerLabel(transcript.fullText);
    const cleaned = shouldRemoveEnglishNoise ? removeEnglishNoise(base) : { cleanedText: base, removedCount: 0 };
    return { transcript: { ...transcript, fullText: cleaned.cleanedText }, noiseRemovedCount: cleaned.removedCount };
  }
  const cleanedSegments = transcript.segments
    .map((segment) => ({ ...segment, text: removeSpeakerLabel(segment.text || '') }))
    .map((segment) => {
      const cleaned = shouldRemoveEnglishNoise ? removeEnglishNoise(segment.text) : { cleanedText: segment.text, removedCount: 0 };
      return { ...segment, text: cleaned.cleanedText, _removed: cleaned.removedCount };
    })
    .filter((segment) => segment.text.length > 0);
  const noiseRemovedCount = cleanedSegments.reduce((sum, segment) => sum + ((segment as any)._removed ?? 0), 0);
  const segments = cleanedSegments.map(({ _removed: _ignored, ...segment }) => segment as typeof transcript.segments[number]);
  return { transcript: { ...transcript, segments, fullText: segments.map((segment) => segment.text).join('\n\n') }, noiseRemovedCount };
}

async function writeTranscriptTextToDropbox(
  env: Env,
  job: RecordingJob,
): Promise<{ transcriptFilePath: string; transcriptFileUrl: string; transcriptFileId?: string; transcriptFileLinkCreated: boolean; transcriptFullTextLength: number; transcriptSegmentCount: number }> {
  if (!job.transcript) throw new HttpError('Transcript missing for transcript storage.', 500);
  const safeBaseName = sanitizeDropboxFileName(job.fileName.replace(/\.[^.]+$/, '') || 'transcript');
  const hash = (await sha256Hex(job.recordingId)).slice(0, 16);
  const transcriptFilePath = `/Apps/MeetingMemo/transcripts/${safeBaseName}-${hash}.txt`;
  const transcriptBody = [
    `recordingId: ${job.recordingId}`,
    `fileName: ${job.fileName}`,
    `dropboxFileId: ${job.dropboxFileId}`,
    `dropboxPathLower: ${job.dropboxPathLower ?? ''}`,
    `generatedAt: ${new Date().toISOString()}`,
    '',
    'full transcript text:',
    isDiarizationEnabled(env) ? renderTranscriptText(job.transcript) : job.transcript.fullText,
  ].join('\n');
  const uploaded = await uploadTextFileToDropbox(env, transcriptFilePath, transcriptBody);
  const shared = await getOrCreateDropboxSharedLink(env, transcriptFilePath);
  return {
    transcriptFilePath,
    transcriptFileUrl: shared.url,
    transcriptFileId: uploaded.id,
    transcriptFileLinkCreated: shared.created,
    transcriptFullTextLength: job.transcript.fullText.length,
    transcriptSegmentCount: job.transcript.segments.length,
  };
}

function hasNonEmptyTaskText(tasks: string[] | undefined): boolean {
  return Array.isArray(tasks) && tasks.some((task) => typeof task === 'string' && task.trim().length > 0);
}

function normalizeEmailTasks(myTasks: string[] | undefined): Array<{ taskText: string; chooseUrl?: string }> {
  if (!Array.isArray(myTasks)) return [];
  return myTasks
    .map((task) => task.trim())
    .filter((task) => task.length > 0)
    .map((taskText) => ({ taskText }));
}

function hasNonEmptyMarkdown(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

export function buildFinalMemoStats(finalMemo: string): Record<string, number> {
  return {
    outputChars: finalMemo.length,
    extractedThemeCount: countMatches(finalMemo, /^##\s+\d+\./gm),
    extractedActionCount: countMatches(finalMemo, /^\|\s*\d+\s*\|/gm),
    numericCount: countMatches(finalMemo, /\d+(?:\.\d+)?(?:%|億|万|千|円|人|社|件|年|ヶ月|か月|日|t|トン)?/g),
    properNounCount: countMatches(finalMemo, /[A-Z]{2,}(?:\/[A-Z]{2,})*|[一-龥]{2,}(?:製鋼|製鉄|本部|部|社|案件|Steel)/g),
  };
}

const MEMO_COMPLETION_TASK_PATTERNS: RegExp[] = [
  /文字起こし/i,
  /transcript/i,
  /トランスクリプト/i,
  /誤変換/i,
  /固有名詞/i,
  /notion/i,
  /議事録/i,
  /面談メモ/i,
  /メモを完成/i,
  /参考リンク/i,
  /出典確認/i,
  /要約/i,
  /本文/i,
  /補足確認/i,
  /human\s*check/i,
  /人間確認/i,
];

const GENERIC_TASK_PATTERNS: RegExp[] = [
  /^(確認する|検討する|調整する|対応する|確認が必要)$/i,
];

const NON_USER_OWNER_PATTERNS: RegExp[] = [
  /^(先方|相手|相手方|顧客|お客様|クライアント|取引先|ベンダー|社外|先方担当)\s*(が|に)/,
];

function getMyTaskFilterReason(task: string): 'memo_completion_task' | 'generic_task_without_object' | 'non_user_owner_task' | undefined {
  const normalized = task.trim();
  if (!normalized) return undefined;
  if (MEMO_COMPLETION_TASK_PATTERNS.some((pattern) => pattern.test(normalized))) return 'memo_completion_task';
  if (GENERIC_TASK_PATTERNS.some((pattern) => pattern.test(normalized))) return 'generic_task_without_object';
  if (NON_USER_OWNER_PATTERNS.some((pattern) => pattern.test(normalized))) return 'non_user_owner_task';
  return undefined;
}

export function filterMyTasksForUserActions(
  myTasks: string[] | undefined,
  context: { recordingId?: string; taskSource?: string } = {},
): string[] {
  if (!Array.isArray(myTasks)) return [];
  const filtered: string[] = [];
  for (const rawTask of myTasks) {
    const task = typeof rawTask === 'string' ? rawTask.trim() : '';
    if (!task) continue;
    const reason = getMyTaskFilterReason(task);
    if (reason) {
      logEvent('info', 'my_task_filtered_out', {
        reason,
        originalTask: task,
        recordingId: context.recordingId,
        taskSource: context.taskSource,
      });
      continue;
    }
    filtered.push(task);
  }
  return filtered;
}

function selectFinalMemo(params: {
  review?: InterviewReviewResult;
  insights?: InterviewInsights;
}): { source: string; finalMemo: string } {
  if (hasNonEmptyMarkdown(params.review?.finalMemoMarkdown)) return { source: 'review.finalMemoMarkdown', finalMemo: params.review!.finalMemoMarkdown.trim() };
  if (hasNonEmptyMarkdown(params.review?.summaryForEmail)) return { source: 'review.summaryForEmail', finalMemo: params.review!.summaryForEmail.trim() };
  if (hasNonEmptyMarkdown(params.insights?.summary)) return { source: 'insights.summary', finalMemo: params.insights!.summary.trim() };
  return { source: 'empty', finalMemo: '' };
}

function selectFinalMyTaskInput(params: {
  review?: InterviewReviewResult;
  insights?: InterviewInsights;
  recordingId?: string;
}): { taskSource: string; myTasks: string[] } {
  if (params.review) {
    if (hasNonEmptyTaskText(params.review.myTasks)) {
      return {
        taskSource: 'review.myTasks',
        myTasks: filterMyTasksForUserActions(params.review.myTasks, { recordingId: params.recordingId, taskSource: 'review.myTasks' }),
      };
    }
    if (hasNonEmptyMarkdown(params.review.nextActionsMarkdown)) {
      return {
        taskSource: 'review.nextActionsMarkdown',
        myTasks: filterMyTasksForUserActions(extractTasksFromNextActionsMarkdown(params.review.nextActionsMarkdown), { recordingId: params.recordingId, taskSource: 'review.nextActionsMarkdown' }),
      };
    }
    if (hasNonEmptyMarkdown(params.review.finalMemoMarkdown)) {
      return {
        taskSource: 'review.finalMemoMarkdown.nextActions',
        myTasks: filterMyTasksForUserActions(extractTasksFromFinalMemoMarkdown(params.review.finalMemoMarkdown), { recordingId: params.recordingId, taskSource: 'review.finalMemoMarkdown.nextActions' }),
      };
    }
  }
  if (hasNonEmptyTaskText(params.insights?.myTasks)) {
    return {
      taskSource: 'insights.myTasks',
      myTasks: filterMyTasksForUserActions(params.insights?.myTasks ?? [], { recordingId: params.recordingId, taskSource: 'insights.myTasks' }),
    };
  }
  return { taskSource: 'none', myTasks: [] };
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
  const filteredPersistedMyTasks = filterMyTasksForUserActions(params.persisted.record.insights?.myTasks, {
    recordingId: params.job.recordingId,
    taskSource: 'persisted.insights.myTasks',
  });
  const fallbackTasks = normalizeEmailTasks(filteredPersistedMyTasks);
  const finalMemoSelection = selectFinalMemo({ review: params.review, insights: params.persisted.record.insights });

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
      myTasks: filteredPersistedMyTasks,
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
      transcriptFileUrl: params.job.transcriptFileUrl,
      finalMemo: finalMemoSelection.finalMemo,
      sourceUrls: params.review?.sourceUrls ?? [],
      myTasks: emailTasks,
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
      const resolved = resolveTranscriptionLanguage(request.languageHint, env.TRANSCRIBE_LANGUAGE);
      logEvent('info', 'transcription_completed', {
        recordingId: job.recordingId,
        model: env.OPENAI_MODEL_TRANSCRIBE ?? (isDiarizationEnabled(env) ? 'gpt-4o-transcribe-diarize' : 'gpt-4o-transcribe'),
        diarizationEnabled: isDiarizationEnabled(env),
        requestLanguageHint: request.languageHint,
        envLanguage: env.TRANSCRIBE_LANGUAGE,
        resolvedLanguage: resolved.language,
        promptEnabled: !isDiarizationEnabled(env),
        transcriptLength: transcript.fullText.length,
        segmentCount: transcript.segments.length,
        fallbackOccurred: false,
      });
      await updateRecordingJobStatus(env, { recordingId: job.recordingId }, 'transcribed', { transcript });
      const sanitizedTranscript = sanitizeTranscriptForMemo(transcript, resolved.language);
      logEvent('info', 'final_memo_input_transcript_sanitized', {
        recordingId: job.recordingId,
        inputTranscriptChars: transcript.fullText.length,
        sanitizedTranscriptChars: sanitizedTranscript.transcript.fullText.length,
        englishNoiseRemovedCount: sanitizedTranscript.noiseRemovedCount,
      });
      let insights;
      let summaryError: string | undefined;
      let summaryErrorDetails: unknown;
      let summaryRaw: unknown;
      try {
        insights = await summarizeInterview(env, sanitizedTranscript.transcript);
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
            transcript: sanitizedTranscript.transcript,
            insights,
            title: persisted.record.title,
            fileName: metadata.name,
            notionPageUrl: persisted.pageId ? buildNotionPageUrl(persisted.pageId) : undefined,
          });
          if (persisted.pageId) {
            await updateInterviewRecordProperties(env, persisted.pageId, persisted.record);
            const chosen = selectFinalMemo({ review: reviewResult, insights: persisted.record.insights });
            await writeFinalMemoToNotionPage(env, persisted.pageId, chosen.finalMemo, reviewResult.sourceUrls);
          }
          persisted.record.insights = {
            summary: reviewResult.summaryForEmail || persisted.record.insights?.summary || '',
            myTasks: filterMyTasksForUserActions(
              reviewResult.myTasks.length ? reviewResult.myTasks : persisted.record.insights?.myTasks ?? [],
              { recordingId: job.recordingId, taskSource: reviewResult.myTasks.length ? 'review.myTasks' : 'insights.myTasks' },
            ),
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
    finalizeQueuedAt: undefined,
    finalizeStartedAt: undefined,
    finalizeCompletedAt: undefined,
    finalizeFailedAt: undefined,
    finalizeAttemptCount: 0,
    finalizeSource: 'callback',
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
    reason: 'Callback accepted and persisted. Finalization is queued separately.',
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

  const finalizeStartedAt = new Date().toISOString();
  logEvent('info', 'finalize_started', { recordingId, force, forceEmail, finalizeStartedAt });
  await updateRecordingJobStatus(env, { recordingId }, 'finalizing', {
    finalizeStatus: 'running',
    finalizeStartedAt,
    finalizeSource: job.finalizeSource ?? 'manual',
    finalizeAttemptCount: (job.finalizeAttemptCount ?? 0) + 1,
    lastError: undefined,
  });

  try {
    const current = (await getRecordingJob(env, { recordingId }))!;
    if (!current.transcript) {
      await updateRecordingJobStatus(env, { recordingId }, 'failed', { finalizeStatus: 'failed', lastError: 'Transcript missing' });
      throw new HttpError('Transcript missing.', 400, { recordingId });
    }

    let mutable = current;
    let pageId = mutable.notionPageId;
    let transcriptFileUrl = mutable.transcriptFileUrl;

    if (!mutable.transcriptWrittenAt || force) {
      logEvent('info', 'notion_transcript_append_started', { recordingId, fileName: mutable.fileName });
      const transcriptStorage = await writeTranscriptTextToDropbox(env, mutable);
      transcriptFileUrl = transcriptStorage.transcriptFileUrl;
      logEvent('info', 'transcript_txt_saved', {
        recordingId,
        transcriptFilePath: transcriptStorage.transcriptFilePath,
        transcriptFileLinkCreated: transcriptStorage.transcriptFileLinkCreated,
        transcriptFullTextLength: transcriptStorage.transcriptFullTextLength,
        transcriptSegmentCount: transcriptStorage.transcriptSegmentCount,
      });
      const persisted = await upsertInterviewFromTranscript(env, { ...mutable.request, dropboxSharedLink: transcriptFileUrl }, {
        id: mutable.dropboxFileId,
        path_lower: mutable.dropboxPathLower,
        name: mutable.fileName,
        size: mutable.sourceBytes,
        client_modified: mutable.clientModified,
        server_modified: mutable.serverModified,
      }, mutable.transcript);
      pageId = persisted.pageId;
      if (pageId) {
        await saveTranscriptLinkToNotion(env, pageId, transcriptFileUrl);
      }
      const now = new Date().toISOString();
      await updateRecordingJobStatus(env, { recordingId }, 'transcribed', {
        transcriptWrittenAt: now,
        notionPageId: pageId,
        notionPageUrl: pageId ? buildNotionPageUrl(pageId) : undefined,
        transcriptFilePath: transcriptStorage.transcriptFilePath,
        transcriptFileUrl: transcriptStorage.transcriptFileUrl,
        transcriptFileId: transcriptStorage.transcriptFileId,
      });
      logEvent('info', 'notion_transcript_append_completed', { recordingId, notionPageId: pageId ?? null, notionPageUrl: pageId ? buildNotionPageUrl(pageId) : null });
      mutable = (await getRecordingJob(env, { recordingId }))!;
    } else {
      logEvent('info', 'notion_transcript_append_skipped_already_written', { recordingId, transcriptWrittenAt: mutable.transcriptWrittenAt });
      transcriptFileUrl = mutable.transcriptFileUrl;
    }

    let insights: InterviewInsights | undefined;
    let reviewResult: InterviewReviewResult | undefined;
    let sourceUrls: string[] = [];
    if (!mutable.summaryWrittenAt || force) {
      try {
        logEvent('info', 'summary_generation_started', { recordingId });
        const resolved = resolveTranscriptionLanguage(mutable.request.languageHint, env.TRANSCRIBE_LANGUAGE);
        const sanitizedTranscript = sanitizeTranscriptForMemo(mutable.transcript!, resolved.language);
        logEvent('info', 'final_memo_input_transcript_sanitized', {
          recordingId,
          inputTranscriptChars: mutable.transcript!.fullText.length,
          sanitizedTranscriptChars: sanitizedTranscript.transcript.fullText.length,
          englishNoiseRemovedCount: sanitizedTranscript.noiseRemovedCount,
        });
        insights = await summarizeInterview(env, sanitizedTranscript.transcript);
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
    } else {
      logEvent('info', 'summary_generation_completed', {
        recordingId,
        skipped: true,
        summaryWrittenAt: mutable.summaryWrittenAt ?? null,
      });
    }

    if (shouldRunInterviewReview(env) && (!mutable.reviewCompletedAt || force)) {
      logEvent('info', 'review_started', { recordingId });
      try {
        const resolved = resolveTranscriptionLanguage(mutable.request.languageHint, env.TRANSCRIBE_LANGUAGE);
        const sanitizedTranscript = sanitizeTranscriptForMemo(mutable.transcript!, resolved.language);
        logEvent('info', 'final_memo_input_transcript_sanitized', {
          recordingId,
          inputTranscriptChars: mutable.transcript!.fullText.length,
          sanitizedTranscriptChars: sanitizedTranscript.transcript.fullText.length,
          englishNoiseRemovedCount: sanitizedTranscript.noiseRemovedCount,
        });
        const review = await reviewInterviewWithWebSearch(env, { transcript: sanitizedTranscript.transcript, insights, title: mutable.fileName, fileName: mutable.fileName, notionPageUrl: pageId ? buildNotionPageUrl(pageId) : undefined });
        reviewResult = review;
        sourceUrls = review.sourceUrls;
        await updateRecordingJobStatus(env, { recordingId }, 'transcribed', { reviewCompletedAt: new Date().toISOString() });
        mutable = (await getRecordingJob(env, { recordingId }))!;
        logEvent('info', 'review_completed', { recordingId });
      } catch (error) {
        logEvent('warn', 'review_failed', {
          recordingId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (!shouldRunInterviewReview(env)) {
      logEvent('info', 'review_skipped_not_configured', { recordingId });
    }

    const finalMemoSelected = selectFinalMemo({ review: reviewResult, insights });
    const finalMemoStats = buildFinalMemoStats(finalMemoSelected.finalMemo);
    logEvent('info', 'final_memo_selected', {
      recordingId,
      source: finalMemoSelected.source,
      finalMemoLength: finalMemoSelected.finalMemo.length,
      finalMemoStartsWith: finalMemoSelected.finalMemo.slice(0, 32),
      ...finalMemoStats,
    });

    if (pageId) {
      logEvent('info', 'notion_final_memo_write_started', { recordingId, notionPageId: pageId, finalMemoLength: finalMemoSelected.finalMemo.length, sourceUrlCount: sourceUrls.length });
      await writeFinalMemoToNotionPage(env, pageId, finalMemoSelected.finalMemo, sourceUrls);
      logEvent('info', 'notion_final_memo_write_completed', { recordingId, notionPageId: pageId, finalMemoLength: finalMemoSelected.finalMemo.length, sourceUrlCount: sourceUrls.length });
      const recordForSummary = ensureInterviewRecord(mutable, mutable.transcript!, {
        summary: finalMemoSelected.finalMemo,
        myTasks: filterMyTasksForUserActions(insights?.myTasks ?? [], { recordingId, taskSource: 'insights.myTasks' }),
        otherTasks: insights?.otherTasks ?? [],
        ambiguities: insights?.ambiguities ?? [],
        raw: insights?.raw,
      });
      logEvent('info', 'summary_property_update_started', { recordingId, notionPageId: pageId, summaryPropertyLength: finalMemoSelected.finalMemo.length, summaryPropertyStartsWith: finalMemoSelected.finalMemo.slice(0, 32) });
      await updateInterviewRecordProperties(env, pageId, recordForSummary);
      logEvent('info', 'summary_property_update_completed', { recordingId, notionPageId: pageId, summaryPropertyLength: finalMemoSelected.finalMemo.length, summaryPropertyStartsWith: finalMemoSelected.finalMemo.slice(0, 32) });

      const selectedFinalTasks = selectFinalMyTaskInput({
        review: reviewResult,
        insights,
        recordingId,
      });
      logEvent('info', 'final_my_task_extract_started', {
        recordingId,
        notionPageId: pageId,
        hasReviewMyTasks: hasNonEmptyTaskText(reviewResult?.myTasks),
        hasReviewNextActionsMarkdown: hasNonEmptyMarkdown(reviewResult?.nextActionsMarkdown),
        hasReviewFinalMemoMarkdown: hasNonEmptyMarkdown(reviewResult?.finalMemoMarkdown),
        hasInsightsMyTasks: hasNonEmptyTaskText(insights?.myTasks),
      });
      logEvent('info', 'final_my_task_extract_finished', {
        recordingId,
        taskSource: selectedFinalTasks.taskSource,
        candidateTaskCount: selectedFinalTasks.myTasks.length,
        normalizedTasks: selectedFinalTasks.myTasks,
      });
      const emptyImportResult = {
        importedCount: 0,
        skippedDuplicates: 0,
        skippedBecauseMissingProperties: 0,
        missingProperties: [] as string[],
      };
      logEvent('info', 'final_my_task_import_started', {
        recordingId,
        notionPageId: pageId,
        taskSource: selectedFinalTasks.taskSource,
        candidateTaskCount: selectedFinalTasks.myTasks.length,
      });
      let imported = {
        importedCount: 0,
        skippedDuplicates: 0,
        skippedBecauseMissingProperties: 0,
        missingProperties: [] as string[],
        normalizedTasks: [] as string[],
        importedTaskItems: [] as Array<{ taskText: string; chooseUrl?: string }>,
      };
      if (selectedFinalTasks.myTasks.length === 0) {
        logEvent('info', 'final_my_task_import_skipped', {
          recordingId,
          reason: 'no_tasks',
        });
      } else {
        try {
          imported = await importMyTasksToInbox(env, {
            recordingId,
            sourceInterviewPageId: pageId,
            myTasks: selectedFinalTasks.myTasks,
          });
        } catch (error) {
          logEvent('warn', 'finalize_completed_with_task_import_warning', {
            recordingId,
            notionPageId: pageId,
            details: error instanceof HttpError ? error.details : error instanceof Error ? error.message : String(error),
          });
        }
      }
      logEvent('info', 'final_my_task_import_finished', {
        recordingId,
        taskSource: selectedFinalTasks.taskSource,
        importedCount: imported.importedCount,
        skippedDuplicates: imported.skippedDuplicates,
        skippedBecauseMissingProperties: imported.skippedBecauseMissingProperties,
        missingProperties: imported.missingProperties,
        normalizedTasks: imported.normalizedTasks,
      });

      if (shouldSendCompletionEmail(env) && (!mutable.emailSentAt || force || forceEmail)) {
        const emailTasks = imported.importedTaskItems;
        await sendCompletionEmail(env, {
          subject: env.MAIL_SUBJECT_PREFIX ?? 'Interview Memo 完了通知',
          notionPageUrl: mutable.notionPageUrl ?? buildNotionPageUrl(pageId),
          transcriptFileUrl,
          finalMemo: finalMemoSelected.finalMemo,
          sourceUrls,
          myTasks: emailTasks,
        });
        logEvent('info', 'completion_email_rendered', {
          recordingId,
          finalMemoIncluded: true,
          transcriptExcerptIncluded: false,
          transcriptBodyIncluded: false,
          duplicatedSummaryIncluded: false,
          sourceUrlCount: sourceUrls.length,
          myTaskCount: emailTasks.length,
        });
        await updateRecordingJobStatus(env, { recordingId }, 'transcribed', { emailSentAt: new Date().toISOString() });
      }

      const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(finalizeStartedAt).getTime()) / 1000));
      await updateRecordingJobStatus(env, { recordingId }, 'completed', {
        summaryWrittenAt: mutable.summaryWrittenAt ?? new Date().toISOString(),
        finalizeStatus: 'completed',
        finalizeCompletedAt: new Date().toISOString(),
        callbackStatus: 'succeeded',
        lastError: undefined,
      });
      logEvent('info', 'finalize_completed', {
        recordingId,
        notionPageId: pageId,
        transcriptFileUrlPresent: Boolean(transcriptFileUrl),
        finalMemoLength: finalMemoSelected.finalMemo.length,
        summaryPropertyLength: finalMemoSelected.finalMemo.length,
        sourceUrlCount: sourceUrls.length,
        myTaskImportedCount: imported.importedCount,
        myTaskSkippedDuplicates: imported.skippedDuplicates,
        elapsedSeconds,
      });
      return { ok: true, status: 'completed' };
    }
    throw new HttpError('Notion page was not created.', 500, { recordingId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent('error', 'finalize_failed', { recordingId, message });
    await updateRecordingJobStatus(env, { recordingId }, 'failed', {
      finalizeStatus: 'failed',
      finalizeFailedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
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
    finalizeQueuedAt: job.finalizeQueuedAt,
    finalizeStartedAt: job.finalizeStartedAt,
    finalizeCompletedAt: job.finalizeCompletedAt,
    finalizeFailedAt: job.finalizeFailedAt,
    finalizeAttemptCount: job.finalizeAttemptCount,
    finalizeSource: job.finalizeSource,
    lastError: job.lastError,
    notionPageId: job.notionPageId,
    notionPageUrl: job.notionPageUrl,
  };
}

export async function resendInterviewEmail(env: Env, recordingId: string, force = true): Promise<{ ok: boolean; status: string }> {
  return finalizeInterviewJob(env, recordingId, { force: false, forceEmail: force });
}
