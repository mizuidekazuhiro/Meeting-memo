# Meeting-memo

iPhoneショートカットから Cloudflare Workers へ音声ファイルを **direct upload** し、Dropbox App Folder に保存したうえで文字起こし・要約・Notion 登録まで一気通貫で進めるためのリポジトリです。

従来の `POST /api/interviews/intake` と `POST /api/interviews/scan` は残していますが、今後の推奨導線は **`POST /api/interviews/upload`** です。Dropbox の見えているフォルダを後から scan する方式ではなく、ショートカットが Workers に直接 `multipart/form-data` を送るため、保存先の不一致に影響されにくくなります。

---

## 推奨導線

1. iPhoneショートカットで録音ファイルを取得する。
2. ショートカットから `POST /api/interviews/upload` に `multipart/form-data` で音声を直接送る。
3. Worker が受信した音声を **Dropbox App Folder 内の Worker 可視領域** に保存する。
4. Worker が保存済みファイルを Dropbox から取得し、必要に応じて **25MB 未満に収まるよう分割** しながら順番に transcription する。
5. 結合した transcript を既存の要約・Notion 登録フローへ渡す。

> direct upload 方式を推奨する理由は、Dropbox scan 方式だと「ショートカットが保存した場所」と「Workers が App Folder として見えている場所」がズレると処理できないためです。direct upload なら、Worker 自身が見える Dropbox 領域へ確実に保存してから処理できます。

---

## エンドポイント一覧

### `GET /`
ヘルスチェックです。`200 OK` と `{ "ok": true, "service": "meeting-memo" }` を返します。

### `GET /health`
既存どおりのヘルスチェックです。

### `POST /api/interviews/upload`  ← 推奨
iPhoneショートカットからの direct upload 用 endpoint です。`X-Webhook-Secret` が必須です。

- Content-Type: `multipart/form-data`
- 必須フィールド:
  - `file` または `audio`: `audio/*` のファイル本体
- 推奨フィールド:
  - `recordedAt`
  - `languageHint`
  - `participants` (JSON 配列文字列)
  - `notes`
  - `idempotencyKey`
  - `metadata` (JSON オブジェクト文字列)
- 認証ヘッダ:
  - `X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>`

アップロード後の流れ:
- Worker が Dropbox App Folder 内の `DROPBOX_UPLOAD_FOLDER` へ保存します。
- OpenAI transcription の 25MB 制限を超える場合は、サーバー側で 25MB 未満のチャンクに分割して順次文字起こしします。
- 結合した transcript を要約し、Notion Inbox DB へ upsert します。

### `POST /api/interviews/intake`
既存の 1 件指定取り込み endpoint です。`X-Webhook-Secret` が必須です。

### `POST /api/interviews/scan`
既存の Dropbox フォルダ探索取り込み endpoint です。`X-Webhook-Secret` が必須です。

### `GET /api/interviews/debug-dropbox`
Dropbox App Folder の root を `path: ""` で列挙する切り分け用 endpoint です。`X-Webhook-Secret` が必須です。

---

## 新しい upload endpoint の仕様

### リクエスト

```http
POST /api/interviews/upload
X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>
Content-Type: multipart/form-data
```

### multipart フィールド

| フィールド | 必須 | 内容 |
| --- | --- | --- |
| `file` or `audio` | 必須 | `audio/*` の音声ファイル。m4a 主対象だが audio/* を広く受け付けます。 |
| `fileName` | 任意 | Dropbox 保存名の上書き。未指定時は元ファイル名、なければ安全な日時ベース名。 |
| `recordedAt` | 任意 | ISO 8601 推奨。 |
| `languageHint` | 任意 | 例: `ja` |
| `participants` | 任意 | `["me","customer"]` のような JSON 配列文字列 |
| `notes` | 任意 | 任意メモ |
| `idempotencyKey` | 任意 | クライアント側の再送制御キー |
| `metadata` | 任意 | 上記補助項目をまとめた JSON 文字列 |

### レスポンス例

```json
{
  "ok": true,
  "action": "processed",
  "reason": "Processed and upserted into Notion.",
  "pageId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "created": true,
  "dropboxFileId": "id:abc123",
  "dropboxPathLower": "/apps/meetingmemo/inbox/interview-001.m4a",
  "storedFileName": "interview-001.m4a",
  "fileSizeBytes": 18374652,
  "dedupCandidates": [
    "dropbox:id:id:abc123",
    "dropbox:path:/apps/meetingmemo/inbox/interview-001.m4a"
  ]
}
```

### エラー時の見え方

レスポンスとログで、少なくとも次を区別できるようにしています。

- upload 失敗
- Dropbox 保存失敗
- 分割失敗
- OpenAI transcription 失敗
- Notion 登録失敗

---

## 分割処理の設計概要

OpenAI transcription は 25MB 未満前提のため、この Worker では **24MB を安全上限** として扱います。

### 基本方針

- 24MB 以下の音声はそのまま transcription します。
- 24MB 超の音声はサーバー側で複数チャンクへ分割します。
- 各チャンクは **24MB 以下** に収まるようにします。
- チャンクごとに順番に transcription し、最後に transcript を結合します。

### チャンク戦略

- `.m4a` / `.mp4`
  - MP4 top-level box を読み、`ftyp` + `moov` を保持したまま `mdat` payload を 24MB 未満で分割します。
  - 完全な時間境界編集ではありませんが、**サイズ上限を厳守する** ことを優先します。
- その他の `audio/*`
  - `Blob.slice()` で 24MB 未満へ分割します。

### transcript 結合

- 各チャンクの `fullText` を順番通りに連結します。
- diarization segment が返る場合はそれらも順番に結合します。

> 現在の分割は **25MB 未満厳守を最優先** にした実装です。時間境界での自然な切れ目最適化は今後の改善余地ですが、少なくとも大きいファイルをそのまま失敗させずに段階処理できるようにしています。

---

## iPhoneショートカット設定例

### 1. 音声ファイルを取得
- 「ファイルを取得」または録音結果を受け取るアクションを使う
- 出力が `.m4a` になる構成を推奨

### 2. URL を指定
- 例: `https://<your-worker-domain>/api/interviews/upload`

### 3. `URL の内容を取得`
- 方法: `POST`
- 本文: `フォーム`
- ヘッダ:
  - `X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>`

### 4. フォーム項目
- `file`: 音声ファイル本体
- `recordedAt`: 例 `2026-03-22T09:30:00+09:00`
- `languageHint`: `ja`
- `participants`: `["me","customer"]`
- `notes`: 任意
- `idempotencyKey`: 例 `shortcut-{{現在日時}}-{{ファイルサイズ}}`

### 5. 成功時の扱い
- レスポンスの `ok`, `action`, `pageId`, `dropboxPathLower` を確認する
- `action=skipped` なら dedup により既処理扱いです

curl 相当例:

```bash
curl -X POST "https://<your-worker-domain>/api/interviews/upload" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>" \
  -F "file=@./interview-001.m4a;type=audio/mp4" \
  -F "recordedAt=2026-03-22T09:30:00+09:00" \
  -F "languageHint=ja" \
  -F 'participants=["me","customer"]' \
  -F "notes=Weekly follow-up"
```

---

## scan 方式との違い

| 項目 | direct upload (`/api/interviews/upload`) | scan (`/api/interviews/scan`) |
| --- | --- | --- |
| 起点 | iPhoneショートカットが Worker に直接送信 | Worker が Dropbox を後から探索 |
| Dropbox 可視性問題 | 起こりにくい | 保存先と App Folder 可視範囲がズレると失敗しやすい |
| メタデータ伝達 | multipart フィールドで一緒に送れる | Dropbox metadata 依存 |
| 大容量音声 | 保存後にサーバー側で分割 transcription | scan 対象でも同じ分割ロジックを利用 |
| 推奨度 | **推奨** | 互換用途・再処理用途 |

---

## 必要な環境変数

### Secrets
- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`
- `DROPBOX_ACCESS_TOKEN`

refresh token 方式では以下を使います。
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Dropbox 認証は access token 方式 / refresh token 方式の両方に対応しています。`DROPBOX_ACCESS_TOKEN` があればそれを優先し、なければ refresh token 方式へフォールバックします。

### vars (`wrangler.toml`)
- `DROPBOX_INTERVIEW_SCAN_FOLDER`
- `DROPBOX_INTERVIEW_SCAN_RECURSIVE`
- `INTERVIEW_SCAN_MAX_FILES`
- `DROPBOX_UPLOAD_FOLDER`
  - 例: `/Apps/MeetingMemo/inbox`

> GitHub Actions / Cloudflare 自動デプロイ前提は維持しています。Cloudflare Dashboard で secret を手動登録する前提の説明は不要です。

---

## 補足

- `/api/interviews/scan` は残しています。
- `/api/interviews/intake` も互換維持のため残しています。
- direct upload でも、保存先は Worker から確実に見える Dropbox App Folder 内です。
- 大きい音声はサーバー側で分割して transcription します。
