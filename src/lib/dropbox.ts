import type { DropboxFileMetadata, Env, IntakeRequest } from '../types';
import { HttpError } from './http';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2';
const AUDIO_FILE_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.mp4', '.mpeg', '.mpga', '.webm']);

async function resolveAccessToken(env: Env): Promise<string> {
  if (env.DROPBOX_ACCESS_TOKEN) {
    return env.DROPBOX_ACCESS_TOKEN;
  }
  if (!env.DROPBOX_REFRESH_TOKEN || !env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) {
    throw new HttpError('Dropbox credentials are not fully configured.', 500);
  }

  const response = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new HttpError('Failed to refresh Dropbox access token.', 502, await response.text());
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new HttpError('Dropbox token response did not include an access token.', 502, payload);
  }
  return payload.access_token;
}

async function dropboxRpc<T>(env: Env, path: string, body: unknown): Promise<T> {
  const token = await resolveAccessToken(env);
  const response = await fetch(`${DROPBOX_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new HttpError(`Dropbox API call failed for ${path}.`, 502, await response.text());
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

export async function listDropboxFolder(env: Env, folderPath: string, recursive: boolean): Promise<{
  entries: DropboxFileMetadata[];
  cursor?: string;
  has_more: boolean;
}> {
  return dropboxRpc(env, '/files/list_folder', {
    path: folderPath,
    recursive,
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
