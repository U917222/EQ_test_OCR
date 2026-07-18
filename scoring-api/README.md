# scoring-api

CHEQ採点結果PDFを生成するCloud Run用FastAPIサービスです。候補者・採点データの永続化やOCRは行わず、Cloudflare Pages FunctionsのD1経路から受け取ったデータをPDFに変換します。

## エンドポイント

- `GET /readyz`: 認証なしで `{"ok":true}` を返すヘルスチェック
- `POST /render-pdf`: D1経路用の結果PDF生成。`PDF_RENDER_KEY` のBearer tokenで認証

`POST /` と `POST /api` は提供しません。

## ローカル実行

```bash
cd scoring-api
uv sync
ALLOW_INSECURE_DEV_AUTH=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

## 環境変数

- `PDF_RENDER_KEY`: Pagesから `/render-pdf` を呼ぶための専用Bearer token
- `ALLOW_INSECURE_DEV_AUTH=1`: ローカル開発時のみ `PDF_RENDER_KEY` 未設定を許可

Pages側には `PDF_RENDER_URL` と同じ `PDF_RENDER_KEY` を設定します。

## テスト

```bash
cd scoring-api
uv run pytest
```

## デプロイ

PMが実施します。Codex作業では `gcloud` / `wrangler` は実行しません。
