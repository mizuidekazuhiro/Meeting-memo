# Meeting-memo

Apple Watch で録音した面談音声を、Dropbox 経由で Cloudflare Workers に取り込み、話者分離付き文字起こし・要約・タスク抽出を行ったうえで、既存の Notion Inbox DB に 1 レコードとして登録するための専用 ingestion repo です。

## 1. 現状整理
- この repo は新規の独立した ingestion システムです。既存の `notion-inbox-triage` repo を置き換えるものではありません。
- 保存先の Notion DB は既存の Inbox DB を再利用します。
- Task DB は使いません。面談 1 件につき Inbox DB に 1 レコードだけを作成または更新します。
- 話者分離は必須要件のため、本 repo では文字起こし時に diarization 対応モデル / API を使う前提です。
- 不明点:
  - 既存 Inbox DB の厳密なプロパティ定義はこの repo 単体からは不明です。
  - `Processed` / `Processed At` を既存 triage 側がどのように解釈しているかは不明です。
  - 既存 triage 一覧で `Source` / `Record Type` をどのようにフィルタしているかは不明です。

## 2. 新 repo と既存 repo の責務分担

### この repo (`meeting-memo`)
- `POST /api/interviews/intake` で iPhone ショートカットから webhook を受ける。
- Dropbox 上の対象音声メタデータ取得とファイルダウンロードを行う。
- 話者分離付き文字起こしを実行する。
- 要約、`My Tasks`、`Other Tasks`、曖昧事項を抽出する。
- 既存 Inbox DB に面談録レコードを create / update する。
- Dropbox File Id などを使って重複登録を防ぐ。

### 既存 repo (`notion-inbox-triage`)
- 既存 Inbox DB の取得・表示。
- Inbox → Tasks 移動。
- Undo。
- Email Routing 由来の Inbox 追加。
- 面談録レコードの triage 対象化 / 除外の UI 判断。

## 3. 既存 Inbox DB との互換性で注意すべき点
- 既存 triage が参照する基本プロパティは壊さないことを最優先にします。
- `Name` は既存 DB のタイトル列を継続利用します。
- `Source` は既存値と衝突しないよう、まずは `Interview` を想定値として使いますが、既存の select 値制約は実 DB 側で確認が必要です。
- `Record Type` を追加できるなら `Interview Memo` を推奨します。既存 triage 側で除外条件にしやすくなります。
- `Processed` / `Processed At` は本実装では触れていません。既存 triage 側で自動処理済み扱いになる可能性があるため、運用ルールの確認が必要です。
- `Transcript` や `Raw JSON` は長文になりやすいため、Notion プロパティ上限に注意してください。必要に応じて本文 block 保存への変更を検討してください。

## 4. 修正方針
- Cloudflare Workers 単体で webhook を受ける自己完結構成にします。
- Dropbox は access token 直指定と refresh token フローの両方に対応します。
- dedup は以下の優先順位で候補を生成します。
  1. Dropbox File Id
  2. Dropbox `path_lower`
  3. Dropbox content hash
  4. 録音日時 + サイズ
  5. 補助的に client idempotency key
- Notion では `Dedup Key` を照合して既存ページがあれば update、なければ create します。
- 文字起こし失敗時も Notion に `Processing Status = error` と `Error Message` を残します。
- 主体不明のタスクは断定せず、`ambiguities` に残します。

## 5. 変更対象ファイル一覧
- `package.json`
- `tsconfig.json`
- `wrangler.toml`
- `src/index.ts`
- `src/types.ts`
- `src/lib/http.ts`
- `src/lib/security.ts`
- `src/lib/dedup.ts`
- `src/lib/dropbox.ts`
- `src/lib/openai.ts`
- `src/lib/notion.ts`
- `test/dedup.test.ts`
- `README.md`

## 6. 各ファイルの具体的な修正内容
- `src/index.ts`
  - `/api/interviews/intake` と `/health` を提供します。
  - intake → Dropbox metadata 取得 → dedup 判定 → ダウンロード → 話者分離文字起こし → 要約生成 → Notion upsert の順で処理します。
  - 失敗時も Notion に error 状態を書き込みます。
- `src/lib/dropbox.ts`
  - Dropbox metadata 取得、audio ダウンロード、refresh token による access token 再発行を実装します。
- `src/lib/openai.ts`
  - 音声文字起こし API と要約 / タスク抽出 API を呼びます。
  - diarization ラベルは `speaker_1` / `speaker_2` などを期待します。
- `src/lib/notion.ts`
  - `Dedup Key` による既存ページ検索。
  - Inbox DB への page create / patch update。
  - 既存互換を意識して `Name` と `Source` を維持しつつ、面談録向け追加プロパティへ格納します。
- `src/lib/dedup.ts`
  - dedup 候補生成ロジックを共通化します。
- `src/lib/security.ts`
  - 共有シークレット検証を実装します。
- `test/dedup.test.ts`
  - dedup 優先順位の最低限のユニットテストを追加します。

## 7. Notion 側で追加すべきプロパティ一覧

### 必須
- `Interview Date` (date)
- `Summary` (rich_text)
- `My Tasks` (rich_text)
- `Other Tasks` (rich_text)
- `Transcript` (rich_text もしくは block 本文。現実運用では block 本文のほうが安全)

### 追加推奨
- `Dropbox File Id` (rich_text)
- `Dropbox Link` (url)
- `Processing Status` (select: `pending`, `completed`, `error`)
- `Speaker Separation` (checkbox)
- `Error Message` (rich_text)
- `Record Type` (select: `Interview Memo`)
- `Raw JSON` (rich_text。長すぎる場合は block 退避を検討)
- `Imported At` (date)
- `Dedup Key` (rich_text)

### 既存互換のために継続利用する想定
- `Name` (title)
- `Source` (select)

## 8. 必要な環境変数 / Secrets 一覧
- `APP_ENV`
- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `DROPBOX_ACCESS_TOKEN` または下記 refresh token セット
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_MODEL_TRANSCRIBE`（省略時 `gpt-4o-transcribe`）
- `OPENAI_MODEL_SUMMARIZE`（省略時 `gpt-4.1-mini`）

### Cloudflare への設定例
```bash
wrangler secret put INTERVIEW_WEBHOOK_SECRET
wrangler secret put NOTION_TOKEN
wrangler secret put INBOX_DB_ID
wrangler secret put DROPBOX_REFRESH_TOKEN
wrangler secret put DROPBOX_APP_KEY
wrangler secret put DROPBOX_APP_SECRET
wrangler secret put OPENAI_API_KEY
```

## 9. iPhone ショートカットから送る想定 JSON
```json
{
  "dropboxFileId": "id:abc123def456",
  "dropboxPathLower": "/apps/meeting-recorder/2026-03-22/interview-001.m4a",
  "dropboxSharedLink": "https://www.dropbox.com/scl/fi/...",
  "fileName": "interview-001.m4a",
  "mimeType": "audio/mp4",
  "recordedAt": "2026-03-22T09:30:00+09:00",
  "fileSizeBytes": 18374652,
  "idempotencyKey": "shortcut-2026-03-22T09:30:00+09:00-18374652",
  "source": "Interview",
  "initiatedBy": "iPhone Shortcut",
  "participants": ["me", "customer"],
  "languageHint": "ja",
  "notes": "Weekly follow-up"
}
```

### webhook 仕様
- Method: `POST`
- URL: `/api/interviews/intake`
- Header:
  - `Content-Type: application/json`
  - `X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>`
- Response:
  - `ok`
  - `status` (`completed` / `error`)
  - `created`
  - `pageId`
  - `dedupCandidates`
  - `errorMessage`

## 10. 動作確認手順
1. `npm install`
2. `npm run check`
3. `npm test`
4. Cloudflare に secret を設定する。
5. 既存 Inbox DB に追加プロパティを作成する。
6. `wrangler dev` でローカル起動する。
7. サンプル JSON で `/api/interviews/intake` を呼ぶ。
8. Dropbox から対象音声が取得できることを確認する。
9. Notion Inbox DB に 1 件だけ作成または更新されることを確認する。
10. 同じ payload を再送し、同じ `Dedup Key` で update されることを確認する。
11. 故意に transcription API を失敗させ、`Processing Status = error` と `Error Message` が保存されることを確認する。

### 例: curl
```bash
curl -X POST http://127.0.0.1:8787/api/interviews/intake \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: local-secret' \
  -d @payload.json
```

## 11. README 追記内容
この README 自体に以下を反映済みです。
- 全体フロー
- webhook 仕様
- 必要な環境変数
- Dropbox 認証設定
- Notion Inbox DB の必要プロパティ
- 既存 `notion-inbox-triage` との責務分担
- 重複防止の考え方
- 動作確認手順
- 障害時の確認ポイント

### 障害時の確認ポイント
- webhook secret が一致しているか。
- Dropbox refresh token フローで access token が再発行できているか。
- Dropbox metadata 取得対象が file id か path か。
- OpenAI の transcription モデルが diarization を返しているか。
- Notion DB 側に追加プロパティが作成済みか。
- `Source` / `Record Type` の select 値が DB に存在するか。
- `Transcript` / `Raw JSON` が Notion の文字数制限に抵触していないか。
- 既存 triage 側が `Interview Memo` を一覧に出す / 出さない条件をどうしているか。

## 12. コミットメッセージ案
```text
feat: add interview memo ingestion worker
```
