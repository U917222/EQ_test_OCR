# CHEQ 採点支援システム

CHEQ の採点用紙を登録し、OCR または手入力で `s01`〜`s80` のセル値を確認し、採点結果・判定・ダッシュボードを扱うためのシステムです。

このリポジトリには、現行の Cloudflare Pages Web アプリ、Cloud Run 用の採点 API、GAS 版のバックエンド、OCR 単体 API、採点コアが入っています。新しく参加した人は、まずこの README で全体像を掴み、必要なサブプロジェクトの README に進んでください。

## まず読む場所

| 目的 | 読む場所 |
| --- | --- |
| ローカルで画面を動かしたい | [ローカル開発](#ローカル開発) |
| 本番/検証環境の構成を理解したい | [現行アーキテクチャ](#現行アーキテクチャ) |
| API やデータ保存先を理解したい | [Web/API の処理フロー](#webapi-の処理フロー), [データモデル](#データモデル) |
| 採点ロジックを直したい | [採点コア](#採点コア) |
| OCR を調整したい | [ocr-api](#ocr-api) と [ocr-api/README.md](ocr-api/README.md) |
| Cloud Run の採点 API を扱いたい | [scoring-api](#scoring-api) と [scoring-api/README.md](scoring-api/README.md) |
| 旧 GAS 連携を扱いたい | [GAS](#gas) |

## 現行アーキテクチャ

現行の推奨経路は Cloudflare Pages の Web アプリから Cloud Run の `scoring-api` に委譲する構成です。

```text
利用者
  -> Cloudflare Pages / React
  -> Pages Functions /api/*
  -> Cloud Run scoring-api (/api)
  -> Google Sheets
  -> OCR + 採点 + PDF生成
```

`web/functions/_lib/gasClient.ts` は `SCORING_API_URL` を `GAS_API_URL` より優先します。`web/wrangler.toml` では `SCORING_API_URL` が設定されているため、Pages Functions は基本的に Cloud Run の `scoring-api` に HMAC 署名付き envelope を送ります。

代替経路として、Pages Functions 内の D1 バックエンドだけで候補者・セル・結果を扱う実装もあります。

```text
利用者
  -> Cloudflare Pages / React
  -> Pages Functions /api/*
  -> Cloudflare D1 (+ 任意で R2)
```

D1 経路では OCR を起動せず、登録時に 80 セルを `manual_entry_required` として作り、人がレビュー画面で入力する前提です。PDF 生成も未実装です。OCR、PDF、大きなファイル保存、Google Drive 保存が必要な場合は `SCORING_API_URL` または `GAS_API_URL` と `FUNCTIONS_GAS_SECRET` を設定して上流へ委譲してください。

旧構成として、GAS Web アプリと `ocr-api` を直接つなぐ運用も残っています。

```text
GAS Web アプリ
  -> Google Drive
  -> ocr-api /recognize
  -> GAS Webhook
  -> Google Sheets
```

## 利用フロー

1. `/candidates/new` で採点用紙の画像または PDF と候補者情報を登録する。
2. OCR が読めたセルは自動反映され、読めないセルはレビュー対象になる。
3. `/candidates/:id/review` で `s01`〜`s80` の値を確認・修正する。
4. reviewer 以上のユーザーが採点を確定する。
5. `/candidates/:id/result` で総合ランク、項目別結果、PDF、採用判定を確認する。
6. `/dashboard` で年度別の件数、合否、ランク、注意項目を見る。

ステータスは Web API 上では `uploaded`、`recognizing`、`needs_review`、`scored`、`finalized` を使います。D1 や Sheets 側では `UPLOADED`、`PROCESSING`、`REVIEW_REQUIRED`、`READY_TO_FINALIZE`、`FINALIZED` のような内部名に変換されます。

## リポジトリ構成

| パス | 役割 |
| --- | --- |
| `web/` | React + Vite の画面、Cloudflare Pages Functions、D1 migrations |
| `scoring-api/` | Cloud Run 用 FastAPI。Pages Functions から呼ばれる採点 API |
| `ocr-api/` | GAS 旧連携向けの OCR 単体 FastAPI |
| `scoring-core/` | GAS とテストで共有する採点コアの純粋関数 |
| `gas/` | Google Apps Script 版バックエンドと旧 Web UI |
| `SECURITY.md` | セキュリティ方針 |

Node.js 系は `pnpm`、Python 系は `uv` を使います。`npm`、`yarn`、`pip` は使いません。

## ローカル開発

### 前提

- Node.js
- `pnpm`
- Python 3.12 以上
- `uv`

### Web

```bash
cd web
pnpm install
pnpm exec wrangler d1 migrations apply cheq-eqtest-db --local
pnpm build
ALLOW_INSECURE_DEV_AUTH=1 MVP_OPERATOR_EMAIL=tsu26mu@gmail.com pnpm pages:dev
```

`ALLOW_INSECURE_DEV_AUTH=1` と `MVP_OPERATOR_EMAIL` を指定すると Cloudflare Access JWT を使わずにローカル API を呼べます。初期 D1 migration では `tsu26mu@gmail.com` が `admin` として seed されています。別メールで試す場合は `users` テーブルにも追加してください。

Vite の UI だけを確認したい場合は次でも起動できます。ただし Pages Functions と D1 を通す実 API の確認には `pnpm pages:dev` を使います。

```bash
cd web
pnpm dev
```

リモート D1 に migration を適用する場合:

```bash
cd web
pnpm exec wrangler d1 migrations apply cheq-eqtest-db --remote
```

### scoring-api

```bash
cd scoring-api
uv sync
ALLOW_INSECURE_DEV_AUTH=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

ヘルスチェック:

```bash
curl -s http://127.0.0.1:8080/readyz
```

API 本体は `POST /` または `POST /api` です。Pages Functions と同じ GAS 互換 envelope を受け取ります。

### ocr-api

```bash
cd ocr-api
uv sync
uv run uvicorn main:app --port 8081
```

採点用紙ファイルをローカルで読む場合:

```bash
cd ocr-api
uv run python cli.py scoresheet scan.pdf
uv run python cli.py scoresheet scan.jpg --dump-review ./out
```

### 採点コア

```bash
cd scoring-core
pnpm install
pnpm test
```

## テストと検証

変更範囲に応じて、最低限次を実行してください。

```bash
cd web
pnpm build
```

```bash
cd scoring-api
uv sync
uv run pytest -q
```

```bash
cd ocr-api
uv sync
uv run pytest -q
```

```bash
cd scoring-core
pnpm test
```

README だけの変更ではアプリのビルドは必須ではありませんが、コマンド・環境変数・データ構造を変えた場合は該当プロジェクトのテストも更新してください。

## Web/API の処理フロー

### フロントエンド

`web/src/App.tsx` が主要ルートを定義しています。

| ルート | 画面 |
| --- | --- |
| `/dashboard` | 年度別ダッシュボード |
| `/candidates` | 候補者一覧。カンバン/テーブル表示 |
| `/candidates/new` | 採点用紙登録 |
| `/candidates/:id/review` | セルレビュー |
| `/candidates/:id/result` | 採点結果・判定 |

API 呼び出しは `web/src/lib/api.ts` の `postApi()` に集約されています。書き込み系 action には `operationId` が必要です。`operationId` は冪等性管理に使われます。

### Pages Functions

入口は `web/functions/api/[[route]].ts` です。`POST /api/:action` のみ受け付けます。

主な action:

| action | 役割 | 必要ロール |
| --- | --- | --- |
| `me` | ログインユーザー取得 | なし |
| `listCandidates` | 候補者一覧 | operator |
| `getDashboard` | ダッシュボード | operator |
| `getCells` | セル・レビューキュー取得 | operator |
| `getResult` | 結果取得 | operator |
| `registerCandidate` | 候補者登録 | operator |
| `saveCells` | セル保存 | operator |
| `updateStatus` | ステータス変更 | operator |
| `deleteCandidate` | 候補者削除 | operator |
| `finalize` | 採点確定 | reviewer |
| `saveDecision` | 合否・職員番号保存 | reviewer |
| `getResultPdf` | 結果 PDF 取得 | reviewer |
| `exportBackup` | D1 バックアップ出力 | admin |

認証は `web/functions/_lib/accessJwt.ts` です。優先順は次の通りです。

1. `APP_ACCESS_PASSWORD` が設定され、リクエストの `X-App-Password` または Cookie が一致すれば共有パスワード認証。
2. `ALLOW_INSECURE_DEV_AUTH=1` と `MVP_OPERATOR_EMAIL` があればローカル開発用バイパス。
3. Cloudflare Access JWT の `Cf-Access-Jwt-Assertion` を検証。

本番では Cloudflare Access JWT を基本にしてください。共有パスワードは小規模検証や暫定運用向けです。ブラウザ側では共有パスワードを永続保存せず、セッション中だけ保持します。

### バックエンド選択

`web/functions/_lib/gasBackend.ts` は、`SCORING_API_URL` または `GAS_API_URL` と `FUNCTIONS_GAS_SECRET` が揃っていて、対象 action が委譲可能な場合に外部 API へ転送します。`SCORING_API_URL` があれば Cloud Run の `scoring-api` が優先されます。

委譲しない場合は `web/functions/_lib/d1Backend.ts` が D1 に保存します。D1 経路は候補者、ファイル、セル、レビュー、採点、監査ログを持ちますが、OCR は走らず、`getResultPdf` もまだ未実装です。総合ランクは GAS、`scoring-api`、D1 経路すべてで ①〜④ の段階2以下の個数から A〜D を固定判定します。

## 環境変数と secrets

### web / Cloudflare Pages

| 名前 | 用途 |
| --- | --- |
| `SCORING_API_URL` | Cloud Run `scoring-api` の `/api` URL。`GAS_API_URL` より優先 |
| `GAS_API_URL` | GAS Web アプリ API URL。Drive 保存や旧経路で使用 |
| `FUNCTIONS_GAS_SECRET` | Pages Functions と `scoring-api`/GAS の HMAC 共有鍵。secret として設定 |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access JWT 検証用 team domain |
| `CF_ACCESS_AUD` | Cloudflare Access JWT の audience |
| `APP_ACCESS_PASSWORD` | 任意。共有パスワード認証 |
| `APP_ACCESS_EMAIL` | 任意。共有パスワード認証時に割り当てるメール |
| `MVP_OPERATOR_EMAIL` | ローカルバイパス、または共有パスワード時の fallback メール |
| `ALLOW_INSECURE_DEV_AUTH` | `1` のときローカル認証バイパス |
| `CHEQ_DB` | D1 binding |
| `CHEQ_FILES` | 任意の R2 binding。大きな採点用紙保存に使用 |

`web/wrangler.toml` には公開してよい値だけ置き、`FUNCTIONS_GAS_SECRET` やパスワードは Pages secret として設定します。

### scoring-api / Cloud Run

| 名前 | 用途 |
| --- | --- |
| `FUNCTIONS_GAS_SECRET` | Pages Functions と共有する HMAC 鍵 |
| `SCORING_SPREADSHEET_ID` | 保存先 Google Spreadsheet ID |
| `SCORING_UPLOAD_DRIVE_FOLDER_ID` | 直接アップロードされた採点用紙原本を保存する Google Drive folder |
| `ALLOW_INSECURE_DEV_AUTH` | `1` のときローカル開発用に署名・timestamp・nonce 検証をスキップ |

Google Sheets/Drive API は ADC を使います。Cloud Run 実行サービスアカウントに対象スプレッドシートと、アップロード保存先 Drive folder を共有してください。

### ocr-api / Cloud Run

| 名前 | 用途 |
| --- | --- |
| `RECOGNITION_API_KEY` | GAS から `/recognize` を呼ぶ Bearer token |
| `RECOGNITION_WEBHOOK_SECRET` | OCR 結果 callback の HMAC 署名鍵 |
| `RECOGNITION_CALLBACK_ALLOWED_HOSTS` | request-supplied callback を許可する host。例: `script.google.com` |
| `RECOGNITION_CALLBACK_URL` | 固定 callback URL を使う場合に設定 |
| `REVIEW_IMAGE_FOLDER_ID` | 低信頼セルの切り出し画像保存先 Drive folder |
| `RECOGNITION_ALLOWED_MIME_TYPES` | 任意。Drive から取得する MIME type 制限 |
| `RECOGNITION_MAX_FILE_BYTES` | 任意。Drive から取得する最大ファイルサイズ |
| `ALLOW_INSECURE_DEV_AUTH` | `1` のときローカル開発用に Bearer token 検証をスキップ |

## データモデル

### D1

D1 schema は `web/migrations/` にあります。主なテーブルは次の通りです。

| テーブル | 内容 |
| --- | --- |
| `users` | メール、ロール、有効/無効 |
| `candidates` | 候補者、受験日、ステータス、採用判定 |
| `candidate_files` | 採点用紙ファイルのメタデータ |
| `candidate_file_chunks` | D1 内に分割保存したファイル本体 |
| `raw_cells` | `s01`〜`s80` のセル JSON、信頼度、未解決数 |
| `review_queue` | 要確認セル |
| `results` | 採点確定結果 |
| `api_operations` | 書き込み action の冪等性記録 |
| `api_nonces` | 署名付き envelope の nonce |
| `audit_log` | 操作ログ |
| `item_master` | CHEQ 項目マスタ |
| `score_bands` | 点数帯と段階 |
| `rank_rules` | 旧 RankRules 互換の保存先。現行の総合ランク固定判定では参照しない |
| `handwritten_totals` | 手書き合計との突合用 |

### Google Sheets

GAS と `scoring-api` は Google Sheets 上の同等シートを使います。主なシートは `Candidates`、`RawCells`、`ReviewQueue`、`ItemMaster`、`ScoreBands`、`RankRules`、`HandwrittenTotals`、`Results`、`AuditLog`、`ApiOperations`、`ApiNonces`、`ApiUsers` です。`RankRules` は旧データ互換として残っていますが、現行の総合ランク判定では参照しません。

## サブプロジェクト

### web

React + Vite + Tailwind の UI と Cloudflare Pages Functions です。UI コンポーネントは `web/src/components/`、画面は `web/src/pages/`、API 型は `web/src/lib/types.ts` にあります。

ファイルアップロードの目安:

- D1 直保存: 小さなファイル
- D1 chunk 保存: base64 が一定サイズを超えるファイル
- R2: `CHEQ_FILES` binding がある場合
- Google Drive: `GAS_API_URL` と `FUNCTIONS_GAS_SECRET` があり、Drive 委譲が必要な場合

フロント側では 9 MB を超える PDF/画像を拒否しています。より大きいファイルを扱う場合は R2 binding と UI 制限の両方を確認してください。

### scoring-api

Cloud Run 用 FastAPI です。Pages Functions から送られる envelope を検証し、Google Sheets を読み書きします。`registerCandidate` に `file.base64` が含まれる場合は Cloud Run 上で PDF/画像を直接 OCR し、未解決セルが 0 件なら採点確定まで進みます。

主要ファイル:

| ファイル | 役割 |
| --- | --- |
| `scoring-api/main.py` | HTTP 入口、`/readyz`、`/api` |
| `scoring-api/src/wire.py` | envelope、署名、action/role |
| `scoring-api/src/security.py` | HMAC、timestamp、nonce、認可 |
| `scoring-api/src/repository.py` | Google Sheets repository |
| `scoring-api/src/handlers.py` | action handler |
| `scoring-api/src/upload_recognition.py` | アップロードファイル OCR |
| `scoring-api/src/scoresheet_recognizer.py` | 採点表 OCR |
| `scoring-api/src/scoring.py` | 採点ロジック |
| `scoring-api/src/pdf.py` | 結果 PDF 生成 |

詳細は [scoring-api/README.md](scoring-api/README.md) を参照してください。

### ocr-api

GAS から `/recognize` を呼ぶ旧連携向けの OCR 単体 API です。Drive から採点用紙を取得し、採点表 page.5 の `s01`〜`s80` を OpenCV で解析して GAS Webhook に返します。

主要ファイル:

| ファイル | 役割 |
| --- | --- |
| `ocr-api/main.py` | `POST /recognize`、`GET /healthz` |
| `ocr-api/src/scoresheet_recognizer.py` | 現行採点表の認識 |
| `ocr-api/src/scoresheet_grid.py` | 格子検出 |
| `ocr-api/src/drive_client.py` | Drive ファイル取得・レビュー画像保存 |
| `ocr-api/src/callback_client.py` | GAS callback |
| `ocr-api/cli.py` | ローカル OCR 確認 |

実物用紙で OCR を調整する場合は [ocr-api/README.md](ocr-api/README.md) のキャリブレーション手順を使ってください。

### 採点コア

`scoring-core/src/cheqScoring.js` は GAS へコピー可能な CommonJS の純粋関数です。`s01`〜`s80` から行得点、項目合計、段階、応答態度減点、職務要件減点、手書き合計との突合を計算します。

GAS 側の `gas/CheqScoring.gs` とロジックが対応しています。採点ロジックを変更した場合は、`scoring-core` のテストを先に更新し、GAS、Cloud Run `scoring-api/src/scoring.py`、D1 `web/functions/_lib/cheqScoring.ts` への反映漏れがないか確認してください。

### GAS

`gas/Code.production.gs` は旧運用の GAS バックエンドです。スプレッドシート初期化、Drive 保存、OCR 起動、Webhook 取り込み、採点、PDF 生成を持っています。`gas/ApiRouter.gs` は Pages Functions や `scoring-api` と同じ action/envelope に寄せた API router です。

主な Script Properties:

| 名前 | 用途 |
| --- | --- |
| `SPREADSHEET_ID` | 対象 Spreadsheet |
| `FUNCTIONS_GAS_SECRET` | Pages Functions/Cloud Run と共有する HMAC 鍵 |
| `RECOGNITION_API_KEY` | `ocr-api` 呼び出し Bearer token |
| `RECOGNITION_WEBHOOK_SECRET` | `ocr-api` callback 署名鍵 |
| `RECOGNITION_ENDPOINT_HOSTS` | 許可する OCR endpoint host |
| `ADMIN_USER_EMAILS` | 管理者メール |
| `AUTHORIZED_USER_EMAILS` | 利用者メール |
| `APP_ACCESS_CODE` | 旧 Web UI 用アクセスコード |

`Config` シートでは `UPLOAD_FOLDER_ID`、`RECOGNITION_ENDPOINT_URL`、`RECOGNITION_MIN_CONFIDENCE`、`AUTO_FINALIZE_WHEN_CLEAN` などを管理します。GAS の初期化は `setupProductionWorkbook()`、採点マスタ seed は `seedScoresheetMasters()` です。

## デプロイの考え方

この README では事故防止のため、具体的な本番デプロイ実行を自動化していません。実行担当者は対象環境、secrets、サービスアカウント、Spreadsheet 共有を確認してから行ってください。

### Cloudflare Pages

1. `web/` で `pnpm build` が通ることを確認する。
2. D1 migrations を対象環境に適用する。
3. `FUNCTIONS_GAS_SECRET`、認証関連、必要なら `SCORING_API_URL`/`GAS_API_URL` を Pages secrets/vars に設定する。
4. Cloudflare Access を使う場合は `CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` を設定する。
5. R2 を使う場合は `CHEQ_FILES` binding を追加する。

### Cloud Run scoring-api

1. `scoring-api/` で `uv run pytest -q` を通す。
2. Cloud Run 実行サービスアカウントを対象 Spreadsheet とアップロード保存先 Drive folder に共有する。
3. `FUNCTIONS_GAS_SECRET`、`SCORING_SPREADSHEET_ID`、`SCORING_UPLOAD_DRIVE_FOLDER_ID` を設定する。
4. `/readyz` と Pages Functions からの `me` action で疎通確認する。

### Cloud Run ocr-api

旧 GAS 連携で必要な場合のみ使います。`RECOGNITION_API_KEY` と `RECOGNITION_WEBHOOK_SECRET` を GAS と揃え、Drive フォルダを Cloud Run 実行サービスアカウントに共有してください。

## 引き継ぎ時の注意点

- `web/src/components/layout/TopBar.tsx` に未コミット変更がある場合があります。README 更新とは無関係なので、作業前に差分を確認してください。
- `SCORING_API_URL` が設定されている環境では、D1 ではなく Cloud Run `scoring-api` + Google Sheets が主な保存先になります。
- D1 経路と Sheets 経路は同じ API 形に寄せていますが、完全に同等ではありません。D1 経路は OCR を走らせず、採点ランクも fallback 実装で、PDF 生成も未実装です。
- `ocr-api/src/scoresheet_*` と `scoring-api/src/scoresheet_*` は同種の OCR 実装です。しきい値や `scoresheet_digit_map.json` を変える場合は、どちらを正とするか決めて同期してください。
- `web/scripts/export-d1-spreadsheet-backup.mjs` のデフォルト DB 名は `cheq-eqtest` ですが、`web/wrangler.toml` の D1 database name は `cheq-eqtest-db` です。使う場合は `--database cheq-eqtest-db` を明示してください。
- OCR はスキャン品質に強く依存します。実物用紙で `ocr-api` または `scoring-api` の `scoresheet_recognizer` を確認してから本番投入してください。
- `FUNCTIONS_GAS_SECRET`、`RECOGNITION_API_KEY`、`RECOGNITION_WEBHOOK_SECRET`、共有パスワードは Git に置かず、Cloudflare Pages secrets、Cloud Run secrets、Apps Script Properties で管理してください。
- 書き込み action は `operationId` 必須です。同じ `operationId` を別 action に使うと conflict になります。
- ユーザー権限は `operator`、`reviewer`、`admin` の 3 段階です。採点確定、PDF、採用判定、バックアップは必要ロールを確認してください。
- 採点マスタを変更した場合は、D1 migrations、Google Sheets の seed、GAS、`scoring-core`、`scoring-api` の整合性を確認してください。

## 新しく開発に入る人向けチェックリスト

1. `git status --short` で既存の未コミット変更を確認する。
2. 変更対象が Web、Cloud Run、OCR、GAS、採点コアのどれかを決める。
3. 対象サブプロジェクトの依存を `pnpm install` または `uv sync` で用意する。
4. 既存テストを実行して現在地を確認する。
5. API action、型、保存先、ロールのいずれかを変える場合は Web とバックエンドの両方を追う。
6. OCR や採点ロジックを変える場合は、合成テストだけでなく実物に近い PDF/画像でも確認する。
7. README やサブ README に、次の担当者が必要とするコマンド・環境変数・制約を残す。

## よくあるトラブル

| 症状 | 確認すること |
| --- | --- |
| API が 401 | Cloudflare Access JWT、`APP_ACCESS_PASSWORD`、`ALLOW_INSECURE_DEV_AUTH` のどれで認証するか確認 |
| API が 403 | `users` / `ApiUsers` のロールと active 状態を確認 |
| 書き込みが 400 | `operationId` が入っているか確認 |
| Cloud Run 委譲が失敗 | `SCORING_API_URL`、`FUNCTIONS_GAS_SECRET`、Cloud Run logs を確認 |
| Sheets 読み書きが失敗 | Cloud Run 実行サービスアカウントに Spreadsheet を共有しているか確認 |
| レビュー画面に用紙が出ない | `source_url`、`candidate_files`、R2/GAS Drive 保存先、`/files/*` を確認 |
| PDF が D1 経路で出ない | D1 backend の `getResultPdf` は未実装。`scoring-api` または GAS 経路を使う |
| OCR が全セル要確認になる | 用紙 page、解像度、傾き、`scoresheet_grid.py` の格子検出、MIME type を確認 |

## ライセンス

MIT License です。詳しくは [LICENSE](LICENSE) を見てください。
