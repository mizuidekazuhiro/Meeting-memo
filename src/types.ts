export interface Env {
  APP_ENV?: string;
  INTERVIEW_WEBHOOK_SECRET: string;
  NOTION_TOKEN: string;
  INBOX_DB_ID: string;
  DROPBOX_ACCESS_TOKEN?: string;
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
  DROPBOX_REFRESH_TOKEN?: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL_TRANSCRIBE?: string;
  OPENAI_MODEL_SUMMARIZE?: string;
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

export interface DropboxFileMetadata {
  id?: string;
  name: string;
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
  request: IntakeRequest;
  processingStatus: 'pending' | 'completed' | 'error';
  errorMessage?: string;
}
