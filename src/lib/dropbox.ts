import type { DropboxFileMetadata, Env, IntakeRequest } from '../types';
import { HttpError } from './http';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2';
const AUDIO_FILE_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.mp4', '.mpeg', '.mpga', '.webm']);
const DEFAULT_UPLOAD_FOLDER = '/interviews';
const DROPBOX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export function getDropboxCredentialStatus(env: Env): {
  hasDropboxAccessToken: boolean;
  hasDropboxAppKey: boolean;
  hasDropboxAppSecret: boolean;
  hasDropboxRefreshToken: boolean;
} {
  return {
    hasDropboxAccessToken: Boolean(env.DROPBOX_ACCESS_TOKEN),
    hasDropboxAppKey: Boolean(env.DROPBOX_APP_KEY),
    hasDropboxAppSecret: Boolean(env.DROPBOX_APP_SECRET),
    hasDropboxRefreshToken: Boolean(env.DROPBOX_REFRESH_TOKEN),
  };
}

export type DropboxAuthMode = 'access_token' | 'refresh_token';

export type DropboxAuthResolution = {
  accessToken: string;
  authMode: DropboxAuthMode;
};

function getMissingDropboxCredentialKeys(env: Env): string[] {
  const missing: string[] = [];
  if (!env.DROPBOX_APP_KEY) missing.push('DROPBOX_APP_KEY');
  if (!env.DROPBOX_APP_SECRET) missing.push('DROPBOX_APP_SECRET');
  if (!env.DROPBOX_REFRESH_TOKEN) missing.push('DROPBOX_REFRESH_TOKEN');
  return missing;
}

export function getDropboxAuthMode(env: Env): DropboxAuthMode | null {
  if (env.DROPBOX_ACCESS_TOKEN) return 'access_token';
  if (env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET && env.DROPBOX_REFRESH_TOKEN) return 'refresh_token';
  return null;
}

export async function resolveDropboxAuth(env: Env): Promise<DropboxAuthResolution> {
  const authMode = getDropboxAuthMode(env);
  if (authMode === 'access_token') {
    return { accessToken: env.DROPBOX_ACCESS_TOKEN!, authMode };
  }

  const missingRefreshKeys = getMissingDropboxCredentialKeys(env);
  if (authMode !== 'refresh_token') {
    throw new HttpError(
      `Dropbox credentials are not fully configured. Missing: ${missingRefreshKeys.join(', ')}. Expected either DROPBOX_ACCESS_TOKEN or the refresh-token set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN.`,
      500,
      {
        attemptedAuthMode: 'refresh_token',
        missingCredentials: missingRefreshKeys,
        availableAuthMode: getDropboxAuthMode(env),
      },
    );
  }

  const response = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.DROPBOX_REFRESH_TOKEN!,
    }),
  });

  if (!response.ok) {
    throw new HttpError('Failed to refresh Dropbox access token.', 502, {
      attemptedAuthMode: authMode,
      responseBody: await response.text(),
    });
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new HttpError('Dropbox token response did not include an access token.', 502, {
      attemptedAuthMode: authMode,
      tokenResponse: payload,
    });
  }
  return { accessToken: payload.access_token, authMode };
}

async function resolveAccessToken(env: Env): Promise<string> {
  const { accessToken } = await resolveDropboxAuth(env);
  return accessToken;
}

async function dropboxRpc<T>(env: Env, path: string, body: unknown, auth?: DropboxAuthResolution): Promise<T> {
  const resolvedAuth = auth ?? (await resolveDropboxAuth(env));
  const response = await fetch(`${DROPBOX_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resolvedAuth.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new HttpError(`Dropbox API call failed for ${path}.`, response.status, {
      attemptedAuthMode: resolvedAuth.authMode,
      responseBody: await response.text(),
    });
  }
  return (await response.json()) as T;
}

async function dropboxContentUpload<T>(
  env: Env,
  path: string,
  args: unknown,
  body: Blob,
  auth?: DropboxAuthResolution,
): Promise<T> {
  const resolvedAuth = auth ?? (await resolveDropboxAuth(env));
  const response = await fetch(`${DROPBOX_CONTENT_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resolvedAuth.accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify(args),
    },
    body,
  });

  if (!response.ok) {
    throw new HttpError(`Dropbox content API call failed for ${path}.`, response.status, {
      attemptedAuthMode: resolvedAuth.authMode,
      responseBody: await response.text(),
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function normalizeDropboxFolderPath(folderPath?: string): string {
  const raw = (folderPath ?? '').trim();
  if (!raw) return DEFAULT_UPLOAD_FOLDER;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, '') || DEFAULT_UPLOAD_FOLDER;
}

export function resolveDropboxUploadFolder(env: Env): string {
  return normalizeDropboxFolderPath(env.DROPBOX_UPLOAD_FOLDER ?? env.DROPBOX_INTERVIEW_SCAN_FOLDER);
}

export async function fetchDropboxMetadata(env: Env, intake: IntakeRequest): Promise<DropboxFileMetadata> {
  if (intake.dropboxFileId) {
    return dropboxRpc<DropboxFileMetadata>(env, '/files/get_metadata', {
      path: intake.dropboxFileId,
      include_media_info: true,
    });
  }
  if (intake.dropboxPathLower) {
    return dropboxRpc<DropboxFileMetadata>(env, '/files/get_metadata', {
      path: intake.dropboxPathLower,
      include_media_info: true,
    });
  }
  throw new HttpError('Either dropboxFileId or dropboxPathLower is required.', 400);
}

export async function listDropboxFolder(env: Env, folderPath: string, recursive: boolean, limit?: number): Promise<{
  entries: DropboxFileMetadata[];
  cursor?: string;
  has_more: boolean;
}> {
  return dropboxRpc(env, '/files/list_folder', {
    path: folderPath,
    recursive,
    limit,
    include_deleted: false,
    include_has_explicit_shared_members: false,
    include_mounted_folders: true,
  });
}

export async function listAllDropboxEntries(env: Env, folderPath: string, recursive: boolean): Promise<DropboxFileMetadata[]> {
  const allEntries: DropboxFileMetadata[] = [];
  let response = await listDropboxFolder(env, folderPath, recursive);
  allEntries.push(...response.entries.filter((entry) => entry['.tag'] === 'file'));

  while (response.has_more && response.cursor) {
    response = await dropboxRpc(env, '/files/list_folder/continue', { cursor: response.cursor });
    allEntries.push(...response.entries.filter((entry) => entry['.tag'] === 'file'));
  }

  return allEntries;
}

export async function debugDropboxAppFolderRoot(env: Env): Promise<{
  authMode: DropboxAuthMode;
  entries: DropboxFileMetadata[];
  cursor?: string;
  has_more: boolean;
}> {
  const auth = await resolveDropboxAuth(env);
  const response = await dropboxRpc<{ entries: DropboxFileMetadata[]; cursor?: string; has_more: boolean }>(
    env,
    '/files/list_folder',
    {
      path: '',
      recursive: false,
      limit: 20,
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: true,
    },
    auth,
  );
  return { authMode: auth.authMode, ...response };
}

export function isAudioDropboxFile(metadata: DropboxFileMetadata): boolean {
  const extension = metadata.name.includes('.') ? `.${metadata.name.split('.').pop()?.toLowerCase()}` : '';
  return AUDIO_FILE_EXTENSIONS.has(extension);
}

export async function downloadDropboxFile(env: Env, metadata: DropboxFileMetadata): Promise<Blob> {
  const token = await resolveAccessToken(env);
  const path = metadata.id ?? metadata.path_lower;
  if (!path) {
    throw new HttpError('Dropbox metadata is missing both id and path_lower.', 500, metadata);
  }

  const response = await fetch(`${DROPBOX_CONTENT_API}/files/download`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });

  if (!response.ok) {
    throw new HttpError('Failed to download Dropbox audio file.', 502, await response.text());
  }
  return await response.blob();
}

export async function uploadAudioToDropbox(env: Env, file: Blob, fileName: string): Promise<DropboxFileMetadata> {
  const auth = await resolveDropboxAuth(env);
  const folder = resolveDropboxUploadFolder(env);
  const path = `${folder}/${fileName}`;

  try {
    if (file.size <= DROPBOX_UPLOAD_CHUNK_BYTES) {
      return await dropboxContentUpload<DropboxFileMetadata>(
        env,
        '/files/upload',
        {
          path,
          mode: 'add',
          autorename: true,
          mute: false,
          strict_conflict: false,
        },
        file,
        auth,
      );
    }

    const firstChunk = file.slice(0, DROPBOX_UPLOAD_CHUNK_BYTES);
    const start = await dropboxContentUpload<{ session_id: string }>(
      env,
      '/files/upload_session/start',
      { close: false },
      firstChunk,
      auth,
    );

    let offset = firstChunk.size;
    while (offset + DROPBOX_UPLOAD_CHUNK_BYTES < file.size) {
      const chunk = file.slice(offset, offset + DROPBOX_UPLOAD_CHUNK_BYTES);
      await dropboxContentUpload<void>(
        env,
        '/files/upload_session/append_v2',
        {
          cursor: { session_id: start.session_id, offset },
          close: false,
        },
        chunk,
        auth,
      );
      offset += chunk.size;
    }

    const finalChunk = file.slice(offset, file.size);
    return await dropboxContentUpload<DropboxFileMetadata>(
      env,
      '/files/upload_session/finish',
      {
        cursor: { session_id: start.session_id, offset },
        commit: {
          path,
          mode: 'add',
          autorename: true,
          mute: false,
          strict_conflict: false,
        },
      },
      finalChunk,
      auth,
    );
  } catch (error) {
    throw new HttpError('Failed to persist uploaded audio into Dropbox.', 502, {
      fileName,
      folder,
      cause: error instanceof HttpError ? error.details : error instanceof Error ? error.message : error,
    });
  }
}
