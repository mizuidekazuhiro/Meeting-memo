export interface RecordingJobKvStore {
  get(key: string, type?: 'text' | 'json'): Promise<string | null | unknown>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  APP_ENV?: string;
  INTERVIEW_WEBHOOK_SECRET: string;
  NOTION_TOKEN: string;
  INBOX_DB_ID: string;
  DROPBOX_ACCESS_TOKEN?: string;
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
  DROPBOX_REFRESH_TOKEN?: string;
  DROPBOX_INTERVIEW_SCAN_FOLDER?: string;
  DROPBOX_INTERVIEW_SCAN_RECURSIVE?: string;
  INTERVIEW_SCAN_MAX_FILES?: string;
  DROPBOX_UPLOAD_FOLDER?: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL_TRANSCRIBE?: string;
  OPENAI_MODEL_SUMMARIZE?: string;
  PYTHON_TRANSCRIBE_API_URL?: string;
  PYTHON_TRANSCRIBE_API_TOKEN?: string;
  WORKERS_CALLBACK_BASE_URL?: string;
  RECORDING_JOB_KV?: RecordingJobKvStore;
  ALLOW_IN_MEMORY_RECORDING_JOB_STORE?: string;
  CALLBACK_JOB_LOOKUP_MAX_ATTEMPTS?: string;
  CALLBACK_JOB_LOOKUP_BASE_DELAY_MS?: string;
  CALLBACK_JOB_LOOKUP_MAX_DELAY_MS?: string;
  GMAIL_NOTIFY_ENABLED?: string;
  MAIL_FROM?: string;
  MAIL_PASSWORD?: string;
  MAIL_TO?: string;
  MAIL_CC?: string;
  MAIL_BCC?: string;
  MAIL_SUBJECT_PREFIX?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  GMAIL_TO?: string;
  GMAIL_FROM?: string;
  GMAIL_OAUTH_CLIENT_ID?: string;
  GMAIL_OAUTH_CLIENT_SECRET?: string;
  GMAIL_OAUTH_REFRESH_TOKEN?: string;
  INBOX_TRIAGE_BASE_URL?: string;
  INBOX_TRIAGE_ACTION_SECRET?: string;
}

export interface IntakeRequest {
  dropboxFileId?: string;
  dropboxPathLower?: string;
  dropboxSharedLink?: string;
  fileName?: string;
  mimeType?: string;
  recordedAt?: string;
  fileSizeBytes?: number;
  idempotencyKey?: string;
  source?: string;
  initiatedBy?: string;
  participants?: string[];
  languageHint?: string;
  notes?: string;
}

export interface UploadRequestMetadata {
  recordedAt?: string;
  idempotencyKey?: string;
  source?: string;
  initiatedBy?: string;
  participants?: string[];
  languageHint?: string;
  notes?: string;
  dryRun?: boolean;
}

export interface ScanRequest {
  folderPath?: string;
  limit?: number;
  recursive?: boolean;
  dryRun?: boolean;
}

export interface DropboxFileMetadata {
  '.tag'?: string;
  id?: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  content_hash?: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
  shared_link?: string;
}

export interface TranscriptSegment {
  speaker: string;
  startMs?: number;
  endMs?: number;
  text: string;
}

export interface TranscriptResult {
  fullText: string;
  segments: TranscriptSegment[];
  raw: unknown;
}

export interface InterviewInsights {
  summary: string;
  myTasks: string[];
  otherTasks: string[];
  ambiguities: string[];
  raw: unknown;
}

export interface NotionPageMatch {
  id: string;
  properties: Record<string, unknown>;
}

export interface InterviewRecord {
  title: string;
  dedupKey: string;
  metadata: DropboxFileMetadata;
  transcript?: TranscriptResult;
  insights?: InterviewInsights;
  summaryRaw?: unknown;
  summaryErrorMessage?: string;
  summaryErrorDetails?: unknown;
  request: IntakeRequest;
  processingStatus: 'pending' | 'transcribing' | 'transcribed' | 'completed' | 'persisted' | 'error';
  errorMessage?: string;
}

export interface ProcessInterviewResult {
  action: 'processed' | 'skipped' | 'error';
  reason: string;
  pageId?: string;
  created?: boolean;
  dedupCandidates: string[];
  record?: InterviewRecord;
}

export type RecordingJobStatus =
  | 'uploaded'
  | 'queued'
  | 'transcoding'
  | 'transcribing'
  | 'transcribed'
  | 'persisted'
  | 'failed';

export interface RecordingJob {
  recordingId: string;
  fileName: string;
  dropboxFileId: string;
  dropboxPathLower?: string;
  sourceBytes?: number;
  sourceDurationSec?: number;
  uploadSource: 'shortcut';
  status: RecordingJobStatus;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  clientModified?: string;
  serverModified?: string;
  request: IntakeRequest;
  callbackStatus?: 'pending' | 'received' | 'persisted' | 'failed';
  transcriptionRequestMetadata?: Record<string, unknown>;
  transcript?: TranscriptResult;
  errorMessage?: string;
  notificationSentAt?: string;
}

export interface RecordingJobCallbackPayload {
  recordingId?: string;
  dropboxFileId?: string;
  dropboxPathLower?: string;
  fileName?: string;
  sourceDurationSec?: number;
  requestId?: string;
  transcript: TranscriptResult;
}
