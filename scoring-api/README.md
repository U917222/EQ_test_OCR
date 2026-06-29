# scoring-api

CHEQ採点支援のCloud Run用FastAPI APIです。Cloudflare Functionsから送られるGAS互換envelopeを受け、署名検証、ロール解決、nonce/idempotency、Sheets更新、OCR、採点/PDF生成の結線を行います。

`registerCandidate` に `file.base64` が含まれる場合は、Cloud Run上でPDF/画像を直接OCRし、未解決セルが0件なら自動で採点確定まで進めます。Cloudflare Pages側は `SCORING_API_URL` をこのAPIのURLに向けると、GASを経由せずにアップロードから結果グラフ表示まで進みます。

## ローカル実行

```bash
cd scoring-api
uv sync
ALLOW_INSECURE_DEV_AUTH=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

`GET /readyz` は認証なしで `{"ok":true}` を返します。API本体は `POST /` または `POST /api` で、`{"claims": {...}, "payload": {...}}` を受け取ります。

## 環境変数

- `FUNCTIONS_GAS_SECRET`: Cloudflare Functionsと共有するHMAC秘密鍵
- `SCORING_SPREADSHEET_ID`: 保存先スプレッドシートID
- `SCORING_UPLOAD_DRIVE_FOLDER_ID`: 直接アップロードされた採点用紙原本を保存するGoogle Drive folder ID
- `ALLOW_INSECURE_DEV_AUTH=1`: ローカル開発用。署名/timestamp/nonce検証だけをスキップ

Cloudflare Pages側:

- `SCORING_API_URL`: このCloud Run APIのURL。例: `https://cheq-scoring-xxxxx-an.a.run.app/api`
- `FUNCTIONS_GAS_SECRET`: Cloud Run側と同じ値

Google Sheets/Drive APIはADCを使います。Cloud Run実行サービスアカウントへ対象スプレッドシートと、アップロード保存先Drive folderを共有してください。

## テスト

```bash
cd scoring-api
uv sync
uv run pytest -q
```

## デプロイ

PMが実施します。Codex作業では `gcloud` / `clasp` / `wrangler` は実行しません。
