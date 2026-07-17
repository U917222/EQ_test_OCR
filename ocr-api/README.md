# ocr-api

CHEQ採点用紙の画像/PDFを同期解析し、`s01`〜`s80` の認識結果を返すCloud Run用FastAPIです。
Pages FunctionsのD1経路から必要に応じて呼び出します。Google Drive取得や非同期callbackは扱いません。

## API

### Health check

```text
GET /healthz
GET /readyz
```

どちらも `{"ok": true}` を返します。

### Synchronous recognition

```text
POST /recognize-sync
Authorization: Bearer <RECOGNITION_API_KEY>
Content-Type: application/json
```

リクエスト:

```json
{
  "file": {
    "base64": "...",
    "mimeType": "application/pdf",
    "name": "scoresheet.pdf"
  },
  "pageIndex": 4
}
```

`pageIndex` は省略可能です。PDFでは既定で5ページ目を使い、ページ数が足りない場合は最終ページへフォールバックします。

成功時は `recognition.cells.s01`〜`s80`、平均信頼度、未解決件数、レビュー用切り抜きを返します。解析失敗時もHTTP 200で全80セルを未解決にしたfailure payloadを返し、セルを黙って欠落させません。

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `RECOGNITION_API_KEY` | Production | Bearer token |
| `RECOGNITION_ALLOWED_MIME_TYPES` | No | Comma-separated MIME allowlist |
| `RECOGNITION_MAX_FILE_BYTES` | No | Maximum decoded bytes; default 20 MiB |
| `ALLOW_INSECURE_DEV_AUTH` | Local only | Set to `1` to skip Bearer authentication |

Default MIME types:

- `application/pdf`
- `image/jpeg`
- `image/png`

## Local development

```bash
cd ocr-api
uv sync
ALLOW_INSECURE_DEV_AUTH=1 uv run uvicorn main:app --host 0.0.0.0 --port 8081
```

## Tests

```bash
cd ocr-api
uv run pytest -q
```

## Main files

| Path | Responsibility |
| --- | --- |
| `main.py` | FastAPI routes, authentication, upload decoding |
| `src/upload_validation.py` | MIME and size settings |
| `src/scoresheet_recognizer.py` | Page selection and score-cell recognition |
| `src/scoresheet_grid.py` | Grid extraction |
| `src/scoresheet_layout.py` | `s01`〜`s80` layout contract |

The retired Drive and callback adapter is preserved under `archive/gas/ocr-api/` and is not deployed.
