# Meeting-memo

Meeting-memo は、**iPhone ショートカットで選んだ音声ファイルを Cloudflare Workers に送り、Dropbox に保存し、その後に文字起こしと Notion 保存を行う**ためのリポジトリです。

今回の修正では、**ユーザー操作フローは変えていません**。変えたのは、Dropbox 保存後の後段処理だけです。

## 変わらないユーザー操作フロー

1. iPhone ショートカットで音声ファイルを選ぶ
2. ショートカットが Workers の既存アップロード API `POST /api/interviews/upload` を呼ぶ
3. Workers が Dropbox に元ファイルを保存する

この **Shortcut -> Workers -> Dropbox** の流れはそのままです。

## 今回の変更点の要約

長時間の `.m4a` を Workers ランタイム内で安全に分割・再エンコードすることは難しいため、後段を次の形に変更しました。

1. Workers が Dropbox 保存成功レスポンスから **確定済み metadata** をその場で取得する
2. Workers が `recordingId` を持つ処理ジョブを作る
3. 短時間ファイルだけ Workers で直接 OpenAI に送る
4. 長時間ファイル、または Workers 側で安全判定できないファイルは Cloud Run に委譲する
5. Cloud Run が ffprobe / ffmpeg で安全に分割・再エンコードし、`gpt-4o-transcribe-diarize` に順次送信する
6. Cloud Run が chunk を時系列順に統合して Workers に callback する
7. Workers が Notion に保存し、ジョブ状態を更新する

## 自動処理フロー

現在の主処理は次の順です。

1. **Shortcut -> Workers -> Dropbox**
2. Workers records Dropbox file metadata
3. Workers dispatches long audio to Cloud Run
4. Cloud Run performs split / transcode / transcribe
5. Cloud Run returns merged transcript to Workers
6. Workers persists the result to Notion

## Dropbox 探索の扱い

Dropbox の `list_folder` / `list_folder_continue` / scan 系は、**主処理では使いません**。

主処理の起点は、Dropbox upload 成功時に取得できる次の metadata です。

- `dropboxFileId`
- `dropboxPathLower`
- `fileName`
- `size`
- `client_modified`
- `server_modified`

scan は次の補助用途だけに限定しています。

- webhook 取りこぼし時の再同期
- 障害復旧
- 手動再処理
- 整合性確認

つまり、**Dropbox 探索なしでも処理対象を確定できる**構成です。

## ジョブ状態管理

Workers は Dropbox 保存直後にジョブを作成します。最低限の状態は以下です。

- `uploaded`
- `queued`
- `transcoding`
- `transcribing`
- `transcribed`
- `persisted`
- `failed`

ジョブには次のような情報を持たせています。

- `recordingId`
- `fileName`
- `dropboxFileId`
- `dropboxPathLower`
- `sourceBytes`
- `sourceDurationSec`
- `uploadSource=shortcut`
- `retryCount`
- `createdAt`
- `updatedAt`

重複防止の優先順位は次のとおりです。

1. `dropboxFileId`
2. `recordingId`
3. `dropboxPathLower` は補助のみ

**`path_lower` 単独では一意判定しません。**

## 長時間音声の扱い

### Workers 側でやらないこと

長時間 `.m4a` に対して、Workers 側では次を禁止しています。

- `mp4-rewrapped`
- byte range split
- container rewrap
- unsafe chunking
- runtime 非対応のまま再エンコード継続

### Cloud Run 側でやること

Cloud Run サービスは次の責務を持ちます。

- Dropbox から対象ファイルを直接取得
- `ffprobe` で duration / codec / sample rate / channels を確認
- 600〜720 秒程度ごとに `decode -> trim -> re-encode`
- 各 part を単体再生可能なファイルとして生成
- `gpt-4o-transcribe-diarize` に順次送信
- chunk ごとの transcript を `chunkIndex` 順に統合
- Workers callback endpoint に結果を返す

## chunk 設計

主要な設定値は次のとおりです。

- `MAX_TRANSCRIBE_DURATION_SEC=1400`
- `TARGET_CHUNK_DURATION_SEC=720`
- `PRIMARY_AUDIO_FORMAT=m4a`
- `FALLBACK_AUDIO_FORMAT=wav`
- `ENABLE_AUDIO_FALLBACK=true`

chunk には最低限次の情報を持たせます。

- `chunkIndex`
- `chunkCount`
- `startOffsetMs`
- `endOffsetMs`
- `estimatedDurationSec`
- `fileName`
- `extension`
- `mimeType`
- `bytes`
- `codec`
- `container`
- `sampleRate`
- `channels`
- `strategy`
- `validationPassed`

使う `strategy` 名は実態がわかるものだけです。

- `single-original`
- `reencoded-aac-m4a`
- `fallback-pcm-wav`

**`mp4-rewrapped` は禁止です。**

## validation

OpenAI に送る前に、chunk を必ず検証します。

- `bytes > 0`
- `duration > 0`
- 拡張子と MIME type の整合
- codec / container 情報の存在
- 単体ファイルとして成立していること
- 空 chunk の拒否

validation 失敗時は OpenAI に送らず、ログに残して止めます。

## OpenAI 送信方針

文字起こしモデルは **必ず `gpt-4o-transcribe-diarize`** を使います。

長時間音声で `.m4a` chunk が OpenAI 側から壊れている・未対応と判断された場合だけ、**同じ時間範囲を `.wav` で 1 回だけ再送**します。

## 障害切り分け

長時間音声で問題が出たときは、次の順で確認してください。

1. **Dropbox upload failed**
2. **Cloud Run dispatch failed**
3. **ffprobe failed**
4. **ffmpeg chunk failed**
5. **OpenAI failed**
6. **callback failed**
7. **Notion persistence failed**

Workers / Cloud Run ともに structured logging を前提にしており、最低限次をログに含める設計です。

- `level`
- `message`
- `recordingId`
- `fileName`
- `dropboxFileId`
- `dropboxPathLower`
- `details`

## エンドポイント

### `POST /api/interviews/upload`
ユーザー導線はそのままのアップロード endpoint です。

### `POST /api/interviews/transcription-callback`
Cloud Run が統合 transcript を返す callback endpoint です。

### `POST /api/interviews/intake`
既存の直接 intake 用です。

### `POST /api/interviews/scan`
補助用途専用です。主処理の起点ではありません。

### `GET /api/interviews/debug-dropbox`
Dropbox 切り分け用です。

## 設定値一覧

### Workers 側

- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`
- `OPENAI_MODEL_TRANSCRIBE`
- `OPENAI_MODEL_SUMMARIZE`
- `DROPBOX_ACCESS_TOKEN`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `DROPBOX_UPLOAD_FOLDER`
- `DROPBOX_INTERVIEW_SCAN_FOLDER`
- `DROPBOX_INTERVIEW_SCAN_RECURSIVE`
- `INTERVIEW_SCAN_MAX_FILES`
- `CLOUD_RUN_TRANSCRIBE_ENDPOINT`
- `CLOUD_RUN_SHARED_SECRET`
- `WORKERS_CALLBACK_BASE_URL`

### Cloud Run 側

- Dropbox credentials
- OpenAI credentials
- callback 用 shared secret
- ffmpeg / ffprobe 実行環境
- chunk duration settings
- retry settings

## テストで確認していること

- upload 後に Dropbox metadata から job が作られること
- Dropbox 探索なしでも処理対象を確定できること
- duration 上限以下のファイルは direct path を選べること
- 長時間ファイルは Cloud Run 委譲判定になること
- `mp4-rewrapped` を使わないこと
- chunk plan が正しく生成されること
- invalid chunk が validation で弾かれること
- `.m4a` 失敗時に `.wav` fallback が 1 回だけ動くこと
- transcript が `chunkIndex` 順に結合されること
- `dropboxFileId` ベースで重複防止できること
- scan 系が補助用途であること

## 補足

Cloud Run 実装はリポジトリ内の `cloud-run/service.ts` に配置しています。ここで ffprobe / ffmpeg を使った安全な chunking と callback 連携を担います。
