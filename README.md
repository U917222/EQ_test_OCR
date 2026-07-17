# CHEQ 採点支援システム

CHEQ採点用紙を登録し、OCRまたは手入力で `s01`〜`s80` を確認して、採点結果・採用判定・面接評価・ダッシュボードまでを扱うシステムです。

## 主な機能

- 候補者の登録・編集・削除
- 採点用紙なしでの候補者先行登録
- PDF/画像のOCRと80セルのレビュー
- 総合ランク、項目別結果、採用判定、結果PDF
- 面接官による6項目×5段階の総合評定
- 年度・地域・性別・ステータス別ダッシュボード

## 現在の構成

本番の標準経路は次の1系統です。

```text
Browser
  -> Cloudflare Pages / React
  -> Pages Functions /api/*
  -> Cloud Run scoring-api
  -> Google Sheets
  -> OCR / scoring / PDF rendering
```

面接評価とD1バックアップはPages FunctionsからCloudflare D1へ直接保存します。

```text
Pages Functions
  -> D1: evaluations, audit and local fallback data
  -> R2: optional file storage binding (not enabled yet)
```

ローカルでは `SCORING_API_URL` と `SCORING_API_SECRET` を設定しない場合、Pages FunctionsのD1実装へフォールバックします。

旧Google Apps Script実装は `archive/gas/` に隔離され、ビルド・テスト・デプロイ対象ではありません。

## リポジトリ構成

| Path | Role |
| --- | --- |
| `web/` | React、Vite、Cloudflare Pages Functions、D1 migrations |
| `scoring-api/` | 本番のCloud Run API、Sheets、OCR、採点、PDF |
| `ocr-api/` | D1ローカル経路向けの同期OCR API |
| `scoring-core/` | 採点ロジックの純粋関数と回帰テスト |
| `archive/gas/` | 廃止済み実装の履歴保管。変更・デプロイ対象外 |

Node.js系は `pnpm`、Python系は `uv` を使います。`npm`、`yarn`、`pip` は使いません。

## 5分で画面を出す

APIを呼ばないデモモード:

```bash
cd web
pnpm install
VITE_DEMO=1 pnpm dev
```

候補者一覧、登録、レビュー、結果、面接評価、ダッシュボードをモックデータで確認できます。

## ローカル開発

### Web + D1

```bash
cd web
pnpm install
pnpm exec wrangler d1 migrations apply cheq-eqtest-db --local
ALLOW_INSECURE_DEV_AUTH=1 MVP_OPERATOR_EMAIL=operator@example.com pnpm pages:dev
```

この構成はD1だけで動きます。`OCR_API_URL` がなければ採点セルは手入力です。

### Web + local scoring-api

ターミナル1:

```bash
cd scoring-api
uv sync
ALLOW_INSECURE_DEV_AUTH=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

ターミナル2の `web/.dev.vars`:

```text
SCORING_API_URL=http://127.0.0.1:8080/api
SCORING_API_SECRET=local-development-secret
ALLOW_INSECURE_DEV_AUTH=1
MVP_OPERATOR_EMAIL=operator@example.com
```

その後:

```bash
cd web
pnpm pages:dev
```

### ocr-api

D1経路で同期OCRを試す場合だけ起動します。

```bash
cd ocr-api
uv sync
ALLOW_INSECURE_DEV_AUTH=1 uv run uvicorn main:app --host 0.0.0.0 --port 8081
```

Pages側に次を設定します。

```text
OCR_API_URL=http://127.0.0.1:8081/recognize-sync
OCR_API_KEY=local-recognition-secret
```

## 利用フロー

1. `/candidates/new` で候補者を登録する。採点用紙は任意。
2. 採点用紙があればOCRする。なければ後からアップロードまたは手入力する。
3. `/candidates/:id/review` で80セルを確認・修正する。
4. reviewerが採点を確定する。
5. `/candidates/:id/result` で結果・合否・結果PDFを扱う。
6. 面接官ごとの総合評定を登録する。
7. `/dashboard` で全体を確認する。

## ステータス

| API | Stored value | Meaning |
| --- | --- | --- |
| `uploaded` | `REGISTERED` / `UPLOADED` | 登録済み |
| `recognizing` | `PROCESSING` | OCR処理中 |
| `needs_review` | `REVIEW_REQUIRED` / `PROCESSING_FAILED` | 要確認 |
| `scored` | `READY_TO_FINALIZE` | 確定待ち |
| `finalized` | `FINALIZED` | 採点確定済み |

## Pages Functions

`web/functions/api/[[route]].ts` がすべてのJSON APIを受けます。

- Cloudflare Access JWTまたはローカル開発認証を検証
- actionごとのロールを確認
- 書き込みでは `operationId` を必須化
- `SCORING_API_URL` と `SCORING_API_SECRET` があればscoring-apiへHMAC署名付きで転送
- 面接評価、バックアップ、上流未設定時はD1実装を使用

scoring-api通信は `web/functions/_lib/scoringApiClient.ts`、転送対象の判定は `scoringApiBackend.ts` にあります。

## 権限

| Role | Main permissions |
| --- | --- |
| `operator` | 候補者、セル、面接評価の登録・更新 |
| `reviewer` | operator権限 + 採点確定、合否、結果PDF、評価削除 |
| `admin` | reviewer権限 + D1バックアップ |

本番のユーザー・ロールはGoogle Sheetsの `Users`、D1経路ではD1の `users` を参照します。

## ファイル保存の現状

本番の採点用紙はscoring-apiがGoogle Driveへ保存し、URLをSheetsの `source_url` に記録します。

D1経路では次の順で保存します。

1. `CHEQ_FILES` bindingがあればR2
2. bindingがなければD1またはD1チャンク

R2への統一と、履歴書・作文・その他資料への拡張は次の開発フェーズです。それまでは `SCORING_UPLOAD_DRIVE_FOLDER_ID` を本番から外さないでください。

## 主な環境変数

### Cloudflare Pages

| Name | Purpose |
| --- | --- |
| `SCORING_API_URL` | Cloud Run scoring-apiの `/api` URL |
| `SCORING_API_SECRET` | Pagesとscoring-apiのHMAC共有鍵 |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain |
| `CF_ACCESS_AUD` | Access application audience |
| `CHEQ_DB` | D1 binding |
| `CHEQ_FILES` | 任意のR2 binding。現在未設定 |
| `OCR_API_URL` | 任意の同期OCR URL |
| `OCR_API_KEY` | OCR用Bearer token |
| `PDF_RENDER_URL` | D1経路用PDF renderer |
| `PDF_RENDER_KEY` | PDF renderer用Bearer token |

### scoring-api

| Name | Purpose |
| --- | --- |
| `SCORING_API_SECRET` | Pagesと共有するHMAC鍵 |
| `SCORING_SPREADSHEET_ID` | 保存先Google Sheets ID |
| `SCORING_UPLOAD_DRIVE_FOLDER_ID` | 現行の採点用紙保存先 |
| `PDF_RENDER_KEY` | `/render-pdf` 専用Bearer token |
| `ALLOW_INSECURE_DEV_AUTH` | ローカル専用認証スキップ |

### ocr-api

| Name | Purpose |
| --- | --- |
| `RECOGNITION_API_KEY` | `/recognize-sync` のBearer token |
| `RECOGNITION_ALLOWED_MIME_TYPES` | MIME allowlist |
| `RECOGNITION_MAX_FILE_BYTES` | デコード後の上限bytes |

秘密値はGitへ置かず、Cloudflare Pages secretsまたはCloud Run secretsで管理してください。

## データモデル

### D1

| Table | Purpose |
| --- | --- |
| `users` | ローカルユーザーとロール |
| `candidates` | D1経路の候補者 |
| `candidate_files` | D1経路の採点用紙メタデータ |
| `candidate_file_chunks` | D1チャンク保存されたファイル本体 |
| `raw_cells` | `s01`〜`s80` とOCRサマリー |
| `review_queue` | 要確認セル |
| `results` | 確定結果 |
| `evaluations` / `evaluation_items` | 面接評価 |
| `api_operations` | 冪等性 |
| `api_nonces` | リプレイ防止 |
| `audit_log` | 操作監査 |

### Google Sheets

本番の主要タブは `Candidates`、`RawCells`、`ReviewQueue`、`Results`、`Users`、`ApiOperations`、`ApiNonces`、`AuditLog` と採点マスタです。

## テスト

```bash
cd web
pnpm test
pnpm build
```

```bash
cd scoring-api
uv run pytest -q
```

```bash
cd ocr-api
uv run pytest -q
```

```bash
cd scoring-core
pnpm test
```

## デプロイ

デプロイ手順は [DEPLOYMENT.md](DEPLOYMENT.md) を参照してください。

重要な順序:

1. D1スキーマ変更があればmigrationを適用
2. scoring-apiをデプロイ
3. Pagesをデプロイ
4. `/readyz` と主要画面を確認

`SCORING_API_SECRET` はPagesとscoring-apiへ同じ値を設定してください。今回の名称変更では、停止を避けるためscoring-apiを先にデプロイしてからPagesを切り替えます。移行期間中のみ旧名 `FUNCTIONS_GAS_SECRET` と旧audience `gas-api` も受け入れますが、新規設定では使用しません。

## トラブルシューティング

| Symptom | Check |
| --- | --- |
| Pagesからscoring-apiへ転送されない | `SCORING_API_URL`、`SCORING_API_SECRET` |
| 401/403 | HMAC secret、Cloudflare Access、Sheets `Users` |
| OCRされない | 本番ならscoring-api logs、D1なら `OCR_API_URL` / `OCR_API_KEY` |
| レビュー画面に用紙が出ない | `source_url`、Drive権限、D1なら `/files/*` |
| 面接評価が失敗 | D1 migrations `0007` / `0008` |
| PDFが出ない | reviewer権限、`PDF_RENDER_KEY`、Cloud Run logs |

## License

See [LICENSE](LICENSE).
