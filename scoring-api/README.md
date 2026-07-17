# scoring-api

CHEQ採点支援のCloud Run用FastAPI APIです。Cloudflare Pages Functionsから署名付きenvelopeを受け、署名検証、ロール解決、nonce/idempotency、Sheets更新、OCR、採点/PDF生成の結線を行います。

`registerCandidate` に `file.base64` が含まれる場合は、Cloud Run上でPDF/画像を直接OCRし、未解決セルが0件なら自動で採点確定まで進めます。

## ローカル実行

```bash
cd scoring-api
uv sync
ALLOW_INSECURE_DEV_AUTH=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

`GET /readyz` は認証なしで `{"ok":true}` を返します。API本体は `POST /` または `POST /api` で、`{"claims": {...}, "payload": {...}}` を受け取ります。

D1 経路の結果PDF生成だけに使う `POST /render-pdf` もあります。これは Sheets には触らず、`PDF_RENDER_KEY` の Bearer token で認証します。

## 環境変数

- `SCORING_API_SECRET`: Cloudflare Pages Functionsと共有するHMAC秘密鍵
- `SCORING_SPREADSHEET_ID`: 保存先スプレッドシートID
- `SCORING_UPLOAD_BACKEND`: 原本保存先。`drive`（既定）または `r2`
- `SCORING_UPLOAD_DRIVE_FOLDER_ID`: `drive` 使用時のGoogle Drive folder ID
- `R2_ACCOUNT_ID`: `r2` 使用時のCloudflare account ID
- `R2_BUCKET_NAME`: `r2` 使用時の非公開バケット名（本番は `cheq-eqtest-files`）
- `R2_ACCESS_KEY_ID`: `r2` 使用時のバケット限定S3 API access key（Secret Managerで管理）
- `R2_SECRET_ACCESS_KEY`: `r2` 使用時のバケット限定S3 API secret（Secret Managerで管理）
- `R2_ENDPOINT`: 任意。未設定時は `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
- `PDF_RENDER_KEY`: D1経路から `/render-pdf` を呼ぶための専用Bearerトークン
- `ALLOW_INSECURE_DEV_AUTH=1`: ローカル開発用。署名/timestamp/nonce検証だけをスキップ

Cloudflare Pages側:

- `SCORING_API_URL`: このCloud Run APIのURL。例: `https://cheq-scoring-xxxxx-an.a.run.app/api`
- `SCORING_API_SECRET`: Cloud Run側と同じ値

旧 `FUNCTIONS_GAS_SECRET` と旧audience `gas-api` はローリング移行中のみ互換性のため受け入れます。新規設定では `SCORING_API_SECRET` を使用し、scoring-apiをPagesより先にデプロイしてください。

`SCORING_UPLOAD_BACKEND` を未設定にすると従来どおりDriveへ保存されるため、R2の設定を追加しただけでは保存先は切り替わりません。`r2` に切り替えた後に作成した原本だけがR2へ保存され、既存のDrive URLはそのまま利用できます。R2の原本URLはCloudflare Access認証を通る `/files/r2/*` で、バケット自体を公開する必要はありません。

履歴書・作文・その他の参考資料PDFは採点用紙の保存先設定とは独立して常にR2へ保存します。そのため、この機能には `SCORING_UPLOAD_BACKEND=drive` の期間中もR2の4設定（account、bucket、access key、secret）が必要です。endpointは任意です。参考資料は9MB以下のPDF限定で、OCRや採点ステータスの更新対象にはなりません。

Google Sheets/Drive APIはADCを使います。Cloud Run実行サービスアカウントへ対象スプレッドシートを共有し、Drive保存も使う場合はアップロード保存先Drive folderも共有してください。

## テスト

```bash
cd scoring-api
uv sync
uv run pytest -q
```

## デプロイ

PMが実施します。Codex作業では `gcloud` / `wrangler` は実行しません。
