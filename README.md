# Meeting-memo

Apple Watch で録音した面談音声を Dropbox 経由で Cloudflare Workers に送り、話者分離付き文字起こし・要約・タスク抽出を行い、Notion Inbox DB に 1 レコードとして保存するためのリポジトリです。

このリポジトリは、既存の `notion-inbox-triage` を置き換えるものではありません。保存先の Notion DB は既存の Inbox DB を利用します。

---

## 1. この仕組みでできること

- iPhone ショートカットから webhook を送る
- Dropbox 上の音声ファイルを取得する
- 話者分離付きで文字起こしする
- 要約を作る
- 自分のタスク / 相手のタスクを抽出する
- Notion Inbox DB に重複なく保存する

---

## 2. 先に必要なもの

- GitHub アカウント
- Cloudflare アカウント
- Notion API トークン
- Notion Inbox DB
- Dropbox App
- OpenAI API Key
- iPhone ショートカット

---

## 3. この repo の設定はターミナル不要です

この repo は、ターミナルを使わずに GitHub と Cloudflare の画面操作だけで設定する想定です。

やることは次の 3 つです。

1. GitHub に secret を登録する
2. GitHub Actions で Cloudflare Worker をデプロイする
3. iPhone ショートカットから webhook を送る

---

## 4. GitHub で設定する項目

GitHub のリポジトリを開き、  
**Settings → Secrets and variables → Actions** に進みます。

### Secrets に追加する値

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `DROPBOX_ACCESS_TOKEN`

Dropbox を refresh token 方式で使う場合は、代わりに以下を追加します。

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

さらに以下も追加します。

- `OPENAI_API_KEY`

### 補足

- 機密情報はすべて GitHub Secrets に入れてください
- API キーやトークンを `wrangler.toml` やソースコードに直接書かないでください

---

## 5. Cloudflare Worker への反映方法

この repo では、GitHub Actions の deploy 時に、GitHub Secrets の内容を Cloudflare Worker の secrets に毎回同期します。

そのため、Cloudflare Dashboard 上で手動登録した secret に依存しません。

これにより、再デプロイ時に secret がずれたり、環境ごとの差分で動かなくなる事故を減らせます。

---

## 6. なぜ「デプロイすると環境変数が消える」ように見えるのか

Cloudflare Worker の secret は environment ごとに別管理です。

たとえば production 環境にデプロイしているのに、default 側にしか secret が入っていないと、デプロイ後に読み取れない状態になります。

この repo では、GitHub Actions から production 環境へ毎回 secret を入れ直すことで、この問題を防ぎます。

---

## 7. Notion 側で必要なプロパティ

### 必須
- `Name` (title)
- `Source` (select)
- `Interview Date` (date)
- `Summary` (rich_text)
- `My Tasks` (rich_text)
- `Other Tasks` (rich_text)
- `Transcript` (rich_text または本文 block)

### 推奨
- `Dropbox File Id` (rich_text)
- `Dropbox Link` (url)
- `Processing Status` (select)
- `Speaker Separation` (checkbox)
- `Error Message` (rich_text)
- `Record Type` (select)
- `Imported At` (date)
- `Dedup Key` (rich_text)

---

## 8. iPhone ショートカットから送るデータ

Webhook URL:
- `https://<your-worker-domain>/api/interviews/intake`

Header:
- `Content-Type: application/json`
- `X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>`

Body 例:

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
