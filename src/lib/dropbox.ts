import type { DropboxFileMetadata, Env, IntakeRequest } from '../types';
import { HttpError } from './http';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2';
const AUDIO_FILE_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.mp4', '.mpeg', '.mpga', '.webm']);

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
  if (env.DROPBOX_ACCESS_TOKEN) {
    return 'access_token';
  }

  if (env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET && env.DROPBOX_REFRESH_TOKEN) {
    return 'refresh_token';
  }

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

async function dropboxRpc<T>(
  env: Env,
  path: string,
  body: unknown,
  auth?: DropboxAuthResolution,
): Promise<T> {
  const resolvedAuth = auth ?? (await resolveDropboxAuth(env));
  const token = resolvedAuth.accessToken;
  const response = await fetch(`${DROPBOX_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
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

export async function fetchDropboxMetadata(env: Env, intake: IntakeRequest): Promise<DropboxFileMetadata> {
  if (intake.dropboxFileId) {
    const metadata = await dropboxRpc<DropboxFileMetadata>(env, '/files/get_metadata', {
      path: intake.dropboxFileId,
      include_media_info: true,
    });
    return metadata;
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
  const response = await dropboxRpc<{
    entries: DropboxFileMetadata[];
    cursor?: string;
    has_more: boolean;
  }>(env, '/files/list_folder', {
    path: '',
    recursive: false,
    limit: 20,
    include_deleted: false,
    include_has_explicit_shared_members: false,
    include_mounted_folders: true,
  }, auth);
  return {
    authMode: auth.authMode,
    ...response,
  };
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
