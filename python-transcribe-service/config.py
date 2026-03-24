from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    api_token: str = os.getenv('API_TOKEN', '')
    openai_api_key: str = os.getenv('OPENAI_API_KEY', '')
    dropbox_access_token: str = os.getenv('DROPBOX_ACCESS_TOKEN', '')
    dropbox_refresh_token: str = os.getenv('DROPBOX_REFRESH_TOKEN', '')
    dropbox_app_key: str = os.getenv('DROPBOX_APP_KEY', '')
    dropbox_app_secret: str = os.getenv('DROPBOX_APP_SECRET', '')
    workers_callback_url: str = os.getenv('WORKERS_CALLBACK_URL', '')
    workers_callback_token: str = os.getenv('WORKERS_CALLBACK_TOKEN', '')
    target_chunk_duration_sec: int = int(os.getenv('TARGET_CHUNK_DURATION_SEC', '720'))
    max_transcribe_duration_sec: int = int(os.getenv('MAX_TRANSCRIBE_DURATION_SEC', '1400'))
    primary_audio_format: str = os.getenv('PRIMARY_AUDIO_FORMAT', 'm4a').lower()
    fallback_audio_format: str = os.getenv('FALLBACK_AUDIO_FORMAT', 'wav').lower()
    enable_audio_fallback: bool = os.getenv('ENABLE_AUDIO_FALLBACK', 'true').lower() == 'true'
    ffmpeg_path: str = os.getenv('FFMPEG_PATH', 'ffmpeg')
    ffprobe_path: str = os.getenv('FFPROBE_PATH', 'ffprobe')
    tmp_dir: str = os.getenv('TMP_DIR', '/tmp')


SETTINGS = Settings()
