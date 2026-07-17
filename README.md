# CHEQ 採点支援システム

CHEQ採点用紙を登録し、OCRまたは手入力で `s01`〜`s80` を確認して、採点結果・採用判定・面接評価・ダッシュボードまでを扱うシステムです。

## 目次

- [主な機能](#主な機能)
- [現在の構成](#現在の構成)
- [リポジトリ構成](#リポジトリ構成)
- [5分で画面を出す](#5分で画面を出す)
- [ローカル開発](#ローカル開発)
- [利用フロー](#利用フロー)
- [ステータス](#ステータス)
- [Pages Functions](#pages-functions)
- [権限](#権限)
- [ファイル保存の現状](#ファイル保存の現状)
- [主な環境変数](#主な環境変数)
- [データモデル](#データモデル)
- [テスト](#テスト)
- [デプロイ](#デプロイ)
- [トラブルシューティング](#トラブルシューティング)
- [関連ドキュメント](#関連ドキュメント)
- [License](#license)

## 主な機能

- 候補者の登録・編集・削除
- 採点用紙なしでの候補者先行登録（結果は後から投入可能）
- 履歴書・作文・その他PDFの参考資料管理（一覧・プレビュー・削除）
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
  -> R2: private scoring-sheet and candidate-document storage
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

> **`scoring-core` は仕様のリファレンス実装です。** 本番では `web`（TypeScript版 `functions/_lib/cheqScoring.ts`）と `scoring-api`（Python版 `src/scoring.py`）がそれぞれ独立に同じロジックを実装しており、`scoring-core` はどちらからも呼ばれていません。採点ロジックの仕様を変更するときは3か所（`scoring-core`、`web`、`scoring-api`）を揃える必要があります。

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
2. `/candidates/:id/result` で履歴書・作文・その他PDFを参考資料として必要に応じて追加する。
3. 採点用紙があればOCRする。なければ後からアップロードまたは手入力する。
4. `/candidates/:id/review` で80セルを確認・修正する。
5. reviewerが採点を確定する。
6. `/candidates/:id/result` で結果・合否・結果PDFを扱う。
7. 面接官ごとの総合評定を登録する。
8. `/dashboard` で全体を確認する。

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

1. パスの `action` を検証する（不正なactionは404）。
2. 認証を検証する。優先順位は次のとおりです。
   - `APP_ACCESS_PASSWORD` が設定されていれば、共有パスワード（ヘッダーまたはCookie）をタイミングセーフに検証し、`MVP_OPERATOR_EMAIL` 等のemailで確定する（Cloudflare Accessログイン無しのMVP運用向け）。
   - `APP_ACCESS_PASSWORD` が無くても `MVP_OPERATOR_EMAIL` と `ALLOW_INSECURE_DEV_AUTH` が設定されていればローカル開発用にバイパスする。
   - どちらもなければ `Cf-Access-Jwt-Assertion` のJWTをCloudflare Access JWKS（`/cdn-cgi/access/certs`）で検証する。
3. 書き込みactionでは `operationId` を必須化する。
4. `SCORING_API_URL` と `SCORING_API_SECRET`（またはレガシーの `FUNCTIONS_GAS_SECRET`）が両方揃っていればscoring-apiへHMAC署名付きで転送し、揃っていなければD1実装へフォールバックする。片方だけの設定はfail-closedで500になる。

ロール確認は転送先ごとに実装が分かれています。

- **scoring-api転送経路**（候補者、セル、採点用紙、参考資料など）: Pages Functions側ではロールを確認せず、scoring-api側の `authorize()` が判定する。
- **D1直接経路**（面接評価、バックアップ、結果PDFなど）: `d1Backend.ts` がD1の `users` テーブルからロールを引いて確認する。

scoring-api通信は `web/functions/_lib/scoringApiClient.ts`、転送対象の判定は `scoringApiBackend.ts` にあります。

### ファイル配信 (`/files/*`)

`web/functions/files/[[path]].ts` がすべて認証必須で処理します。

| Path pattern | 用途 | 実装 |
| --- | --- | --- |
| `/files/{fileId}/{filename}` | D1経路で登録した採点用紙。`candidate_files`（分割時は`candidate_file_chunks`）から復元、または`storage_kind=r2`ならR2から取得 | D1参照 |
| `/files/r2/{candidateId}/{fileId}/{filename}` | R2に直接保存した採点用紙原本 | R2から直接取得 |
| `/files/r2/{candidateId}/documents/{category}/{fileId}/{filename}` | 履歴書・作文・その他の参考資料PDF（`category`は`resume`/`essay`/`other`） | R2から直接取得 |

`/files/r2/*` はCloudflare Access認証に加え、scoring-apiまたはD1で有効なアプリ利用者と候補者の存在を確認してから配信します。candidateId・fileId（UUID）・filenameを厳格な正規表現で検証し、パストラバーサル（`..`混入等）を拒否します。`CHEQ_FILES` bindingが無ければ500でfail-closeします。

## 権限

| Role | Main permissions |
| --- | --- |
| `operator` | 候補者、セル、参考資料、面接評価の登録・更新 |
| `reviewer` | operator権限 + 採点確定、合否、結果PDF、評価削除 |
| `admin` | reviewer権限 + D1バックアップ |

本番のユーザー・ロールはGoogle Sheetsの `Users`、D1経路ではD1の `users` を参照します。

## ファイル保存の現状

本番の採点用紙はscoring-apiが設定に応じてGoogle DriveまたはR2へ保存し、URLをSheetsの `source_url` に記録します。`SCORING_UPLOAD_BACKEND`（既定 `drive`）を明示的に `r2` へ切り替えるまでDriveのまま保存され続け、切り替え後に作成した原本だけがR2へ移ります。採点用紙原本は10MB以下、PDF/JPEG/PNGに限定します。

D1経路では次の順で保存します。

1. `CHEQ_FILES` bindingがあれば非公開R2（キー: `candidates/<candidateId>/<fileId>/<filename>`）
2. bindingがなければD1またはD1チャンク

履歴書・作文・その他PDFは採点用紙と別の `candidates/<candidateId>/documents/<category>/<fileId>/<filename>` 名前空間へ保存します（`category`は`resume`/`essay`/`other`）。R2の一覧とcustom metadataから表示情報を復元するため、SheetsやD1に参考資料メタデータは持ちません。PDFは9MB以下・先頭バイトの `%PDF-` 検証つきに限定し、アップロードしてもOCR・採点結果・候補者ステータスは変更しません。候補者削除時は採点用紙・参考資料ともにbest-effortで削除します。

## 主な環境変数

### Cloudflare Pages

| Name | Purpose |
| --- | --- |
| `SCORING_API_URL` | Cloud Run scoring-apiの `/api` URL |
| `SCORING_API_SECRET` | Pagesとscoring-apiのHMAC共有鍵 |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain |
| `CF_ACCESS_AUD` | Access application audience |
| `APP_ACCESS_PASSWORD` | Cloudflare Accessログイン無しMVP運用向けの共有パスワード（任意） |
| `MVP_OPERATOR_EMAIL` | 共有パスワード認証時／ローカル開発時に確定させるoperator email |
| `ALLOW_INSECURE_DEV_AUTH` | ローカル専用認証スキップ |
| `CHEQ_DB` | D1 binding |
| `CHEQ_FILES` | 非公開R2 binding（`cheq-eqtest-files`）。`/files/r2/*` の配信、D1経路のファイル保存、参考資料の保存に使用 |
| `OCR_API_URL` | 任意の同期OCR URL |
| `OCR_API_KEY` | OCR用Bearer token |
| `PDF_RENDER_URL` | D1経路用PDF renderer |
| `PDF_RENDER_KEY` | PDF renderer用Bearer token |

### scoring-api

| Name | Purpose |
| --- | --- |
| `SCORING_API_SECRET` | Pagesと共有するHMAC鍵 |
| `SCORING_SPREADSHEET_ID` | 保存先Google Sheets ID |
| `SCORING_UPLOAD_BACKEND` | 採点用紙保存先。`drive`（既定）または `r2` |
| `SCORING_UPLOAD_DRIVE_FOLDER_ID` | `drive` 使用時の採点用紙保存先 |
| `R2_ACCOUNT_ID` | 参考資料およびR2採点用紙用のCloudflare account ID |
| `R2_BUCKET_NAME` | 非公開R2 bucket名 |
| `R2_ACCESS_KEY_ID` | bucket限定S3 API access key |
| `R2_SECRET_ACCESS_KEY` | bucket限定S3 API secret |
| `R2_ENDPOINT` | 任意。未設定時は `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `PDF_RENDER_KEY` | `/render-pdf` 専用Bearer token |
| `ALLOW_INSECURE_DEV_AUTH` | ローカル専用認証スキップ |

参考資料（履歴書・作文・その他PDF）は `SCORING_UPLOAD_BACKEND` の値に関わらず常にR2へ保存するため、`drive` 運用中もR2の4設定（account/bucket/access key/secret）が必要です。

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
| `evaluation_item_master` / `evaluators` | 面接評価の項目マスタ・評価者マスタ |
| `item_master` / `score_bands` / `rank_rules` / `handwritten_totals` | CHEQ採点マスタ（配点・段階・ランク規則） |
| `api_operations` | 冪等性 |
| `api_nonces` | リプレイ防止 |
| `audit_log` | 操作監査 |

参考資料（候補者ドキュメント）はD1テーブルを持ちません。R2オブジェクトのcustom metadataのみで一覧・表示情報を復元します。

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
| 参考資料アップロードが失敗する | scoring-apiのR2設定4項目（`R2_ACCOUNT_ID`/`R2_BUCKET_NAME`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`）。`SCORING_UPLOAD_BACKEND=drive` でも参考資料には必須 |

## 関連ドキュメント

| Doc | 内容 |
| --- | --- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 各コンポーネントのデプロイ手順、D1 migration、R2切り替え手順、秘密値管理 |
| [SECURITY.md](SECURITY.md) | 秘密情報の扱い、脆弱性報告方法、公開データのルール |
| [scoring-api/README.md](scoring-api/README.md) | Cloud Run scoring-apiのAPI仕様・環境変数 |
| [ocr-api/README.md](ocr-api/README.md) | 同期OCR APIの仕様・環境変数 |
| [archive/gas/README.md](archive/gas/README.md) | 廃止済みGAS実装の履歴（変更・デプロイ対象外） |

## License

See [LICENSE](LICENSE).
