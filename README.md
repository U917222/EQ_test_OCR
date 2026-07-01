# CHEQ 採点支援システム

CHEQ の採点用紙を登録し、OCR または手入力で `s01`〜`s80` のセル値を確認して、採点結果・採用判定・面接評価・ダッシュボードまでを扱うシステムです。

主にできること:

- 候補者(受験者)を登録する。**採点用紙は任意**で、テスト結果が出ていない候補者を先に登録し、後から用紙を読み込ませることもできます。
- 採点用紙を OCR で読み取り、`s01`〜`s80` の 80 セルを画面で確認・修正して採点を確定する。
- 総合ランク(A〜D)・項目別の結果・採用合否・結果 PDF を扱う。
- 面接官による **総合評定(面接評価)** を、CHEQ 自動採点とは別系統で 6 項目 × 5 段階で登録する。
- 候補者の性別・住所(郵便番号からの自動補完つき)を登録し、**年度別・地域別・男女別** のダッシュボードで俯瞰する。

このリポジトリには、現行の Cloudflare Pages Web アプリ、Cloud Run 用の採点 API、OCR 単体 API、GAS 版バックエンド、採点コアが入っています。新しく参加した人は、まず次の「用語ミニ辞典」と「5 分で画面を出す」を読み、全体像を掴んでから必要なサブプロジェクトに進んでください。

## 用語ミニ辞典

このシステムは Cloudflare と Google のサービスを組み合わせています。本文を読む前に、最低限ここだけ押さえてください。

| 用語 | かみ砕いた意味 |
| --- | --- |
| Cloudflare Pages | 画面(React)を配信するホスティング。利用者がアクセスする Web サイト本体。 |
| Pages Functions | 上記 Pages にくっついて動くサーバ側の小さな API。ブラウザからの `/api/...` をここで受ける。 |
| D1 | Cloudflare が提供するクラウド上の SQLite データベース。サーバを立てずに表データを保存できる。 |
| R2 | Cloudflare のファイル置き場(Amazon S3 相当)。大きい画像/PDF の倉庫。**現状この設定は未定義**(後述)。 |
| Cloud Run | Google のコンテナ実行基盤。`scoring-api` と `ocr-api`(Python)がここで動く。 |
| Google Sheets | 本番の候補者・採点データの主な保存先。`scoring-api` と GAS が読み書きする。 |
| OCR | 採点用紙の画像から数字(80 マスの ○ 印)を 0〜3 の点数に自動変換する技術。 |
| HMAC 署名つき envelope | 中身(誰が・何の操作か)をまとめた JSON に、両者だけが知る共有鍵で「改ざんされていない印」を付けたもの。受け取った側が同じ鍵で検算する。`{claims, payload}` の形式。 |
| nonce | 一度きりの使い捨て番号。盗んだリクエストを再送する攻撃(リプレイ)を防ぐ。 |
| operationId / 冪等性 | 書き込み 1 回ごとに付ける重複防止の整理番号。通信が二重に届いても同じ ID なら二重登録しない。 |
| ADC | Google API を呼ぶときの「既定のログイン情報」。鍵ファイルを書かなくても実行環境(Cloud Run 等)の権限で自動認証される。 |
| Cloudflare Access JWT | Cloudflare のログイン機能が発行する電子的な通行証。サーバ側で検証して本人確認する。 |
| finalize(採点確定) | レビュー済みのセル値で点数を確定し、結果を保存する操作。reviewer 権限が必要。 |
| evaluation(総合評定/面接評価) | 自動採点(`s01`〜`s80`)とは別に、面接官が手で付ける 6 項目 × 5 段階の人物評価。保存先は **D1 だけ**。 |
| wrangler | Cloudflare をコマンドで操作する道具。D1 マイグレーション適用やローカル起動に使う。 |
| binding | Pages Functions のコードから D1 や R2 を「この名前で使う」と結びつける設定(例: `CHEQ_DB`、`CHEQ_FILES`)。 |

## まず読む場所

| 目的 | 読む場所 |
| --- | --- |
| とにかく画面を見たい | [5 分で画面を出す](#5-分で画面を出す) |
| 構成と「自分が触る経路」を知りたい | [全体像](#全体像今あなたが触る経路はどれか) |
| 業務として何ができるか知りたい | [利用フロー](#利用フロー業務フロー) |
| ローカルで実 API を動かしたい | [ローカル開発](#ローカル開発) |
| API・action・ロールを理解したい | [Web/API の処理フロー](#webapi-の処理フロー) |
| 面接評価を直したい | [面接評価(evaluation)サブシステム](#面接評価evaluationサブシステム) |
| 採点ロジックを直したい | [採点コアと総合ランク](#採点コアと総合ランク) |
| 保存先(D1 / Sheets)を理解したい | [データモデル](#データモデル) |
| OCR を調整したい | [ocr-api](#ocr-api) と [ocr-api/README.md](ocr-api/README.md) |
| Cloud Run の採点 API を扱いたい | [scoring-api](#scoring-api) と [scoring-api/README.md](scoring-api/README.md) |

## はじめて触る人の一本道

開発経験が浅い人、または引き継ぎ直後の人は、まずこの順番で進めてください。途中でエラーが出たら、該当セクションの「よくあるトラブル」を見ます。

### 0. 作業前に確認する

```bash
git status --short
```

何か表示されたら、他の人の作業が残っている可能性があります。READMEだけ直す場合でも、勝手に消したり戻したりしないでください。

### 1. ツールを用意する

- Node.js 系は `pnpm` を使います。`npm` / `yarn` は使いません。
- Python 系は `uv` を使います。`pip` は使いません。
- Cloudflare を触るときは `wrangler`、Google Cloud を触るときは `gcloud` が必要です。最初はデモモードだけで十分です。

### 2. まず画面だけ見る

```bash
cd web
pnpm install
VITE_DEMO=1 pnpm dev
```

ブラウザに出るローカルURLを開き、候補者一覧、登録、レビュー、結果、ダッシュボードを一通り触ります。このモードは実データもAPIも使いません。

### 3. 実APIつきで動かす

```bash
cd web
pnpm install
pnpm exec wrangler d1 migrations apply cheq-eqtest-db --local
ALLOW_INSECURE_DEV_AUTH=1 MVP_OPERATOR_EMAIL=tsu26mu@gmail.com pnpm pages:dev
```

これは Cloudflare D1 だけで動くローカル経路です。OCRやPDFも試したい場合は、あとで `ocr-api` と `scoring-api /render-pdf` の設定を追加します。

### 4. 自分が触る場所を決める

| やりたいこと | 主に触る場所 | 先に読む節 |
| --- | --- | --- |
| 画面の表示や入力を直す | `web/src/` | [フロントエンド](#フロントエンド) |
| `/api/...` の挙動を直す | `web/functions/` | [Pages Functions](#pages-functions) |
| 本番の候補者/採点/Sheets連携を直す | `scoring-api/` | [scoring-api](#scoring-api) |
| D1ローカル・面接評価・バックアップを直す | `web/functions/_lib/d1Backend.ts` | [面接評価(evaluation)サブシステム](#面接評価evaluationサブシステム) |
| OCRの読み取りを直す | `ocr-api/` と `scoring-api/src/scoresheet_*` | [ocr-api](#ocr-api) |
| 点数計算やランクを直す | `scoring-core/`、`scoring-api/src/scoring.py`、`web/functions/_lib/cheqScoring.ts`、`gas/Code.production.gs` | [採点コアと総合ランク](#採点コアと総合ランク) |
| 旧GAS運用を直す | `gas/` | [GAS](#gas) |

### 5. 変更後に最低限確認する

変更した場所に応じて、次のどれかを実行します。

```bash
cd web
pnpm build
pnpm test
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
pnpm install
pnpm test
```

## 5 分で画面を出す

最短でまず画面を触りたいときは、バックエンドを一切起動しないデモモードが使えます。

```bash
cd web
pnpm install
VITE_DEMO=1 pnpm dev
```

`VITE_DEMO=1` のとき、API を呼ばず `web/src/lib/demo.ts` のモックデータで動きます。候補者一覧・レビュー・結果・ダッシュボードの見た目と画面遷移を一通り確認できます。

実際の API(認証・D1 保存)まで通したくなったら、次の [ローカル開発](#ローカル開発) に進んでください。

## 全体像（今あなたが触る経路はどれか）

このシステムには 3 つの経路があり、新しく入った人がまず混乱するポイントです。**最初に「今の自分はどの経路で動かしているか」を確定** させてください。

- **本番(推奨経路)**: Cloudflare Pages → Pages Functions → **Cloud Run `scoring-api` → Google Sheets**。`web/wrangler.toml` に `SCORING_API_URL` が設定済みなので、本番の Pages Functions は基本的にこの経路で動きます。
- **ローカル既定**: `pnpm pages:dev` で起動すると、`web/.dev.vars` に `FUNCTIONS_GAS_SECRET` を入れていない限り上流へ委譲せず、**Cloudflare D1 単独** で動きます。`OCR_API_URL`/`OCR_API_KEY` が無いとOCRはせず手入力、`PDF_RENDER_URL`/`PDF_RENDER_KEY` が無いと結果PDFは出ません。
- **旧経路**: GAS Web アプリ + `ocr-api`。現行では使いませんが、旧運用を引き継ぐ場合のみ必要です。

### 本番経路(Cloud Run scoring-api)

```text
利用者
  -> Cloudflare Pages / React
  -> Pages Functions /api/*
  -> Cloud Run scoring-api (/api)        … HMAC署名つき envelope
  -> Google Sheets
  -> OCR + 採点 + PDF生成
```

`web/functions/_lib/gasClient.ts` は `SCORING_API_URL` を `GAS_API_URL` より優先します。`SCORING_API_URL`(または `GAS_API_URL`)と `FUNCTIONS_GAS_SECRET` が揃っていて、対象 action が委譲対象のときだけ上流へ転送されます。

### D1 経路(委譲しない場合)

```text
利用者
  -> Cloudflare Pages / React
  -> Pages Functions /api/*
  -> Cloudflare D1 (+ 任意で R2)
```

D1 経路は候補者・ファイル・セル・レビュー・採点・面接評価・監査ログを D1 に保存します。`OCR_API_URL`/`OCR_API_KEY` があれば `ocr-api` の `/recognize-sync` で同期OCRし、無ければ 80 セルを `manual_entry_required` として作って人がレビュー画面で入力します。`getResultPdf` は `PDF_RENDER_URL`/`PDF_RENDER_KEY` がある場合だけ、`scoring-api` の `/render-pdf` に委譲して出力できます。

> **重要な非対称(後述)**: 面接評価(evaluation)系の 6 action と `exportBackup` は **常に D1** で処理されます。`SCORING_API_URL` を設定した本番でも、評価だけは Cloud Run/Sheets ではなく D1 に書かれます。「候補者本体は Sheets・評価は D1」という二重ストアになっている点に注意してください。

### 旧経路(GAS + ocr-api)

```text
GAS Web アプリ
  -> Google Drive
  -> ocr-api /recognize
  -> GAS Webhook
  -> Google Sheets
```

## 利用フロー（業務フロー）

採点オペレーター/運用担当の標準的な流れです。各ステップに画面・必要ロールを併記します。

**ステップ 1. 候補者を登録する** — `/candidates/new`(operator)
氏名・受験日が必須。性別・郵便番号・都道府県・市区町村・番地・メモも任意で入力できます。郵便番号欄の「住所を自動入力」ボタンで都道府県・市区町村が補完されます(外部の郵便番号検索サービスへ郵便番号のみ送信。[後述](#郵便番号住所の自動補完外部依存))。**採点用紙の画像/PDF は任意** です。

ここで 2 つに分岐します。

- **分岐 A(用紙あり)**: 登録時に採点用紙を添付すると、本番(Cloud Run)経路では Cloud Run 上で OCR が走り、未解決セルが 0 件なら自動で採点確定まで進みます。
- **分岐 B(テスト結果なし登録)**: 用紙を付けずに登録すると、結果ページに「テスト未実施」と表示されます。後日 `/candidates/:id/result` の「採点用紙をアップロード」(後付け OCR)または「採点する」(手入力)から仕上げます。

**ステップ 2. セルを確認・修正する** — `/candidates/:id/review`(operator)
`s01`〜`s80` を、切り抜き画像と元の採点用紙(画像ズーム/PDF 複数ページ送り)を見ながら確認します。数字キー・Enter・矢印キーで操作でき、「残りは OCR のまま確定」で一括確定もできます。

**ステップ 3. 採点を確定する** — finalize(reviewer)
reviewer 以上が採点を確定します。**全セルが空(テスト結果なし)のままでは確定できません**(安全弁)。確定ボタンが効かないときは、先に用紙アップロードか手入力でセルを埋めてください。

**ステップ 4. 結果と採用判定を見る** — `/candidates/:id/result`(operator / 一部 reviewer)
総合ランク A〜D、項目別プロフィール、応答態度・職務要件の減点、手書き合計との突合を確認します。reviewer は合否(hire/reject)と職員番号(合格時のみ)を登録し、結果 PDF を出力できます。

**ステップ 5. 面接評価を入れる** — `/candidates/:id/evaluation/new`(operator、削除のみ reviewer)
結果ページ下部の評定セクションから、面接官ごとに 6 項目 × 5 段階 + 所見を登録します。評価者名は初回に登録すると以後再利用できます。詳細は [面接評価サブシステム](#面接評価evaluationサブシステム) を参照。

**ステップ 6. 候補者情報を後編集する** — `/candidates/:id/edit`(operator)
結果ページの「候補者情報」ボタンから、氏名・受験日・性別・住所・メモを後から更新できます。

**ステップ 7. 全体を俯瞰する** — `/dashboard`(operator)
年度を選び、月別(男女別の積み上げ)、ステータス、合否、総合ランク、**地域別応募者数**(富山県のみ市区町村粒度・上位 10 区分)、要注意項目、月次テーブルを確認します。性別未登録は「未設定」に集計され、注意バナーが出ます。

候補者一覧 `/candidates` では、カンバン表示(カードをドラッグしてステータス移動)とテーブル表示を切り替えられ、氏名検索・ステータスフィルタ・行からの編集/削除ができます。

## ステータスの意味と遷移

画面(Web API)上のステータスと、保存層の内部名は次のように対応します。

| Web API 表記 | 内部名(D1 / Sheets) | 意味 |
| --- | --- | --- |
| `uploaded` | `REGISTERED` / `UPLOADED` | 登録済み。`REGISTERED` はテスト結果なし登録の初期状態 |
| `recognizing` | `PROCESSING` | OCR 処理中 |
| `needs_review` | `REVIEW_REQUIRED` / `PROCESSING_FAILED` | 要レビュー(未解決セルあり、または OCR 失敗) |
| `scored` | `READY_TO_FINALIZE` | レビュー完了、確定待ち |
| `finalized` | `FINALIZED` | 採点確定済み |

> **経路差に注意**: テスト結果なし登録の初期ステータスは、`scoring-api`(Sheets)も D1 も `REGISTERED`/`UPLOADED`(=uploaded)相当です。D1 ではファイル付き登録時だけ一旦 `PROCESSING` になり、OCR成功後に `REVIEW_REQUIRED` または `READY_TO_FINALIZE` へ更新されます。ファイル無し、またはOCR未設定の場合は 80 セル分の `manual_entry_required` レビュー行を作ります。

## リポジトリ構成

| パス | 役割 |
| --- | --- |
| `web/` | React + Vite の画面、Cloudflare Pages Functions、D1 migrations |
| `scoring-api/` | Cloud Run 用 FastAPI。Pages Functions から呼ばれる本番の採点 API |
| `ocr-api/` | GAS 旧連携向けの OCR 単体 FastAPI |
| `scoring-core/` | 採点ロジックの正本(純粋関数)。GAS へコピー同期する |
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

- `wrangler d1 migrations apply` の DB 名は `web/wrangler.toml` の `database_name` に合わせて **`cheq-eqtest-db`** を使います。`0001`〜`0009` を適用します。**評価・住所・性別の機能はこのマイグレーションが無いと動きません。**
- `ALLOW_INSECURE_DEV_AUTH=1` と `MVP_OPERATOR_EMAIL` を指定すると Cloudflare Access JWT を使わずにローカル API を呼べます。初期 D1 migration では `tsu26mu@gmail.com` が `admin` として seed されています。別メールで試す場合は `users` テーブルにも追加してください。
- この `pnpm pages:dev` 既定構成では **上流委譲されず D1 単独経路** です。Cloud Run/Sheets 経路を確認するには、`web/.dev.vars` に `SCORING_API_URL` と `FUNCTIONS_GAS_SECRET` を追加し、別途 `scoring-api` を起動してください。
- D1 単独でOCRを試す場合は `OCR_API_URL=http://127.0.0.1:8081/recognize-sync` と `OCR_API_KEY` を追加し、別ターミナルで `ocr-api` を起動します。D1 単独でPDFを試す場合は `PDF_RENDER_URL=http://127.0.0.1:8080/render-pdf` と `PDF_RENDER_KEY` を追加し、`scoring-api` を起動します。

UI だけを確認したい場合(実 API なし):

```bash
cd web
pnpm dev          # VITE_DEMO=1 を付けるとモックデータで動く
```

ローカル疎通の確認:

```bash
curl -s http://127.0.0.1:8787/readyz   # 上流(SCORING_API_URL||GAS_API_URL)の設定状況を返す
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

API 本体は `POST /` または `POST /api` です。Pages Functions と同じ GAS 互換 envelope を受け取ります。`ALLOW_INSECURE_DEV_AUTH=1` は署名・timestamp・nonce 検証だけをスキップし、ユーザー解決とロール認可は維持されます。

### ocr-api

```bash
cd ocr-api
uv sync
uv run uvicorn main:app --port 8081
```

> ポート注意: `ocr-api/Dockerfile` は 8080 で起動します。`scoring-api`(8080)と同時に動かす場合に備え、ここではローカル例を 8081 にしています。

採点用紙ファイルをローカルで読む場合(Google 認証不要):

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

テストが通ったら、必要に応じて正本を GAS へ同期します(下記 [採点コアと総合ランク](#採点コアと総合ランク) 参照)。

```bash
./sync-gas.sh    # cheqScoring.js を gas/CheqScoring.gs へコピー
```

## テストと検証

変更範囲に応じて、最低限次を実行してください。

```bash
cd web
pnpm build        # tsc 型チェック + Vite ビルド
pnpm test         # vitest(functions/_lib や lib のユニットテスト)
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

`web/src/App.tsx` がルートを定義しています。

| ルート | 画面 |
| --- | --- |
| `/dashboard` | 年度別・地域別・男女別ダッシュボード |
| `/candidates` | 候補者一覧(カンバン/テーブル、検索、編集/削除) |
| `/candidates/new` | 候補者登録(採点用紙は任意) |
| `/candidates/:id` | `/candidates/:id/result` へリダイレクト |
| `/candidates/:id/edit` | 候補者情報(氏名/受験日/性別/住所/メモ)の編集 |
| `/candidates/:id/review` | セルレビューと採点確定 |
| `/candidates/:id/result` | 採点結果・採用判定・面接評価一覧 |
| `/candidates/:id/evaluation/new` | 面接評価の新規登録 |
| `/candidates/:id/evaluation/:evaluationId/edit` | 面接評価の編集 |

API 呼び出しは `web/src/lib/api.ts` の `postApi()` に集約され、`POST /api/:action` を叩きます。書き込み系 action には冪等性管理のための `operationId` が必要です。`VITE_DEMO=1` のときは `web/src/lib/demo.ts` のモックに切り替わります。

### Pages Functions

入口は `web/functions/api/[[route]].ts` です。`POST /api/:action` のみ受け付けます。action とロールは `web/functions/_lib/roles.ts` が正本です(全 21 action)。

| action | 必要ロール | 処理経路 |
| --- | --- | --- |
| `me` | 要ログイン(*) | 委譲 or D1 |
| `listCandidates` | operator | 委譲 or D1 |
| `getDashboard` | operator | 委譲 or D1 |
| `getCells` | operator | 委譲 or D1 |
| `getResult` | operator | 委譲 or D1 |
| `registerCandidate` | operator | 委譲 or D1 |
| `attachScoresheet` | operator | 委譲 or D1 OCR |
| `updateCandidate` | operator | 委譲 or D1 |
| `saveCells` | operator | 委譲 or D1 |
| `updateStatus` | operator | 委譲 or D1 |
| `deleteCandidate` | operator | 委譲 or D1 |
| `finalize` | reviewer | 委譲 or D1 |
| `saveDecision` | reviewer | 委譲 or D1 |
| `getResultPdf` | reviewer | D1 PDF renderer |
| `exportBackup` | admin | **D1 専用** |
| `listEvaluationMeta` | operator | **D1 専用** |
| `listEvaluations` | operator | **D1 専用** |
| `getEvaluation` | operator | **D1 専用** |
| `registerEvaluator` | operator | **D1 専用** |
| `saveEvaluation` | operator | **D1 専用** |
| `deleteEvaluation` | reviewer | **D1 専用** |

(*) `me` は `roles.ts` 上は公開(role=null)ですが、D1 経路では認証後にユーザー解決を行い、`users` に存在しない/無効なユーザーは 403 になります。実質ログイン済みが必要です。

「委譲 or D1」は、`SCORING_API_URL`(または `GAS_API_URL`)+ `FUNCTIONS_GAS_SECRET` が設定されていれば上流(Cloud Run/GAS)へ、なければ D1 へ処理が回ることを意味します。`attachScoresheet` は委譲経路では `scoring-api` が処理し、D1 経路では `OCR_API_URL`/`OCR_API_KEY` が必要です。`getResultPdf` は通常の委譲セットには含まれず、D1 backend が `PDF_RENDER_URL`/`PDF_RENDER_KEY` を使って `scoring-api` の `/render-pdf` に投げます。

### 認証

認証は `web/functions/_lib/accessJwt.ts` です。優先順は次の通りです。

1. `APP_ACCESS_PASSWORD` が設定され、リクエストの `X-App-Password` または Cookie と一致すれば共有パスワード認証(SHA-256 の定数時間比較)。割り当てメールは `APP_ACCESS_EMAIL` → `MVP_OPERATOR_EMAIL` → 既定の順で決まります。
2. `ALLOW_INSECURE_DEV_AUTH=1` と `MVP_OPERATOR_EMAIL` があればローカル開発用バイパス。
3. Cloudflare Access JWT の `Cf-Access-Jwt-Assertion` を検証(JWKS / aud / exp)。

本番では Cloudflare Access JWT を基本にしてください。共有パスワードは小規模検証や暫定運用向けです。ブラウザ側では共有パスワードを永続保存せず、セッション中だけ保持します。

### バックエンド選択

`web/functions/_lib/gasBackend.ts` の `canDispatchGas()` が委譲可否を判定します。委譲対象は `GAS_ACTIONS`(13 action: `me`、候補者/セル/結果/採点/判定系、`saveDecision`)に限られ、`SCORING_API_URL` があれば Cloud Run の `scoring-api` が優先されます。委譲時 `gasClient.ts` は HMAC 署名を付け、408/429/5xx(500/502/503/504)を最大 3 回まで試行(=リトライは最大 2 回。各試行 60 秒タイムアウト、nonce/timestamp 再生成)します。

委譲しない場合は `web/functions/_lib/d1Backend.ts` が D1 に保存します。`exportBackup` と面接評価系 6 action は `GAS_ACTIONS` に含まれないため、`SCORING_API_URL` を設定した環境でも **常に D1** で処理されます。

総合ランクは GAS・`scoring-api`・D1 経路すべてで、①〜④の段階 2 以下の個数から A〜D を固定判定します(実装は経路ごとに別。後述)。

## 面接評価(evaluation)サブシステム

CHEQ の自動採点(`s01`〜`s80`)とは **完全に独立した、面接官による人手評価** です。混同しやすいので独立した節にまとめます。

- **内容**: 6 項目(知識能力 / 対応力 / 性格人格 / 関心意欲 / 期待値将来性 / 適性)を各 5〜1 段階で採点し、所見を残します。6 項目合計で最大 30 点。合計はサーバ側で再計算され、クライアント値は信用しません。
- **複数評価者**: 1 候補者に複数の面接官が評価を登録できます。評価者名は初回に登録すると以後の入力で再利用できます(評価者マスタは初期 0 名)。
- **画面**: 結果ページ下部の評定セクション(`web/src/components/evaluation/EvaluationSection.tsx`)と、`/candidates/:id/evaluation/new`・`/candidates/:id/evaluation/:evaluationId/edit`。
- **action**: `listEvaluationMeta` / `listEvaluations` / `getEvaluation` / `saveEvaluation` / `registerEvaluator` / `deleteEvaluation`。削除のみ reviewer、ほかは operator。
- **保存先は D1 のみ**: `scoring-api`・GAS・Google Sheets には評価の処理もタブも一切ありません。`SCORING_API_URL` 設定済みの本番でも評価だけは D1 に書かれます。D1 マイグレーション(`0007`/`0008`)が未適用だと評価機能は動きません。
- **候補者との関係**: 本番候補者は Sheets 管理で D1 の `candidates` は空のため、`evaluations.candidate_id` は `candidates` への外部キーではなく、Sheets 由来 ID への緩い参照キーです(migration `0008` で FK を除去)。**評価登録に D1 候補者行の存在チェックを足すと本番で必ず壊れます。**

## 採点コアと総合ランク

`scoring-core/src/cheqScoring.js` が採点ロジックの **正本** です(GAS へコピーできる CommonJS 純粋関数)。`s01`〜`s80` から行得点、項目合計、段階(1〜5)、応答態度減点、職務要件減点、手書き合計との突合を計算します。採点前にマスタ整合性も検証します(`validateMasters`)。

> **総合ランク A〜D は正本コアに含まれません。** ランク判定(`calculateFallbackRank`)は次の 3 箇所に **別個に実装** されています。
> - GAS: `gas/Code.production.gs`(`calculateFallbackRank_`)— ランクの「正」。テスト `scoring-core/test/gasRank.test.js` がこのファイルを直接読んで検証します。
> - Cloud Run: `scoring-api/src/scoring.py`(`calculate_fallback_rank`)
> - D1: `web/functions/_lib/cheqScoring.ts`(`calculateFallbackRank`)

採点ロジックは合計 4 箇所に複製されています。同期方法は次の通りで、**自動同期されるのは GAS の 1 ファイルだけ** です。

| 実装 | 同期方法 |
| --- | --- |
| `scoring-core/src/cheqScoring.js` | 正本 |
| `gas/CheqScoring.gs` | `scoring-core/sync-gas.sh` で正本をコピー(直接編集禁止) |
| `scoring-api/src/scoring.py` | 手動移植 |
| `web/functions/_lib/cheqScoring.ts` | 手動移植(総合ランク判定もここに実装) |

採点ロジックやランク仕様を変えるときは、`scoring-core` のテストを先に更新し、`sync-gas.sh` を実行したうえで、`scoring.py` と `cheqScoring.ts`(およびランクは `Code.production.gs`)への反映漏れがないか必ず確認してください。

## ファイルアップロードの仕様

フロント側(`web/src/lib/upload.ts`)で次のように前処理します。

| 種別 | 挙動 |
| --- | --- |
| PDF | 9 MB を超えると即時拒否(`R2` 有効化が必要というエラー) |
| 画像 | 最大 1800px へ縮小し、900 KB 以下になるよう JPEG 品質を 0.82 から 0.08 刻みで段階的に下げる(到達下限はおおむね 0.42)。圧縮しても 900 KB を超え、かつ元サイズが 9 MB を超える場合のみ拒否 |

つまり 9 MB を超える画像でも、900 KB 以下に圧縮できれば受理されます(拒否されるのは PDF 9 MB 超、または画像で圧縮後も 900 KB 超かつ元 9 MB 超のときだけ)。保存先はバックエンドがサイズで分岐します。`CHEQ_FILES`(R2)binding があれば R2、なければ base64 が一定サイズを超えると D1 にチャンク分割、それ以下は D1 に直接保存します。9 MB を超えるファイルを扱うには、`web/wrangler.toml` に R2 binding を追加し、フロントの上限も合わせて見直してください(現状 R2 binding は未定義)。

## 環境変数と secrets

### web / Cloudflare Pages

| 名前 | 用途 |
| --- | --- |
| `SCORING_API_URL` | Cloud Run `scoring-api` の `/api` URL。`GAS_API_URL` より優先。`wrangler.toml` の `[vars]` に本番値あり |
| `GAS_API_URL` | GAS Web アプリ API URL。Drive 保存や旧経路で使用 |
| `FUNCTIONS_GAS_SECRET` | Pages Functions と `scoring-api`/GAS の HMAC 共有鍵。secret として設定。これが無いと委譲されず D1 経路に落ちる |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access JWT 検証用 team domain |
| `CF_ACCESS_AUD` | Cloudflare Access JWT の audience |
| `APP_ACCESS_PASSWORD` | 任意。共有パスワード認証 |
| `APP_ACCESS_EMAIL` | 任意。共有パスワード認証時に割り当てるメール |
| `MVP_OPERATOR_EMAIL` | ローカルバイパス、または共有パスワード時の fallback メール |
| `ALLOW_INSECURE_DEV_AUTH` | `1` のときローカル認証バイパス |
| `CHEQ_DB` | D1 binding(`wrangler.toml` で定義、`database_name=cheq-eqtest-db`) |
| `CHEQ_FILES` | 任意の R2 binding。大きな採点用紙保存に使用。**現状 `wrangler.toml` には未定義**。使うには手動追加が必要 |
| `OCR_API_URL` | 任意。D1 経路で採点用紙OCRを使う場合の `ocr-api /recognize-sync` URL |
| `OCR_API_KEY` | 任意。`OCR_API_URL` 呼び出し用 Bearer token。`FUNCTIONS_GAS_SECRET` と使い回さない |
| `PDF_RENDER_URL` | 任意。D1 経路で結果PDFを出す場合の `scoring-api /render-pdf` URL |
| `PDF_RENDER_KEY` | 任意。`PDF_RENDER_URL` 呼び出し用 Bearer token |
| `VITE_DEMO` | Vite ビルド用。`1` でバックエンド非接続のモック表示モード |

`web/wrangler.toml` には公開してよい値だけ置き、`FUNCTIONS_GAS_SECRET` やパスワードは Pages secret として設定します。

### scoring-api / Cloud Run

| 名前 | 用途 |
| --- | --- |
| `FUNCTIONS_GAS_SECRET` | Pages Functions と共有する HMAC 鍵 |
| `SCORING_SPREADSHEET_ID` | 保存先 Google Spreadsheet ID。**未設定時は `config.py` の既定 ID に fallback** するため、設定漏れに注意 |
| `SCORING_UPLOAD_DRIVE_FOLDER_ID` | 直接アップロードされた採点用紙原本を保存する Google Drive folder |
| `PDF_RENDER_KEY` | D1 経路から `/render-pdf` を呼ぶための専用 Bearer token |
| `ALLOW_INSECURE_DEV_AUTH` | `1` のとき署名・timestamp・nonce 検証をスキップ(ユーザー解決・ロール認可は維持) |

Google Sheets/Drive API は ADC を使います。Cloud Run 実行サービスアカウントに対象スプレッドシートと、アップロード保存先 Drive folder を共有してください。

### ocr-api / Cloud Run

| 名前 | 用途 |
| --- | --- |
| `RECOGNITION_API_KEY` | GAS から `/recognize` を呼ぶ Bearer token |
| `RECOGNITION_WEBHOOK_SECRET` | OCR 結果 callback の HMAC 署名鍵 |
| `RECOGNITION_CALLBACK_ALLOWED_HOSTS` | request 供給 callback を許可する host。例: `script.google.com` |
| `RECOGNITION_CALLBACK_URL` | 固定 callback URL を使う場合に設定 |
| `REVIEW_IMAGE_FOLDER_ID` | 低信頼セルの切り出し画像保存先 Drive folder |
| `RECOGNITION_ALLOWED_MIME_TYPES` | 任意。Drive から取得する MIME type 制限 |
| `RECOGNITION_MAX_FILE_BYTES` | 任意。Drive から取得する最大ファイルサイズ |
| `ALLOW_INSECURE_DEV_AUTH` | `1` のとき Bearer token 検証をスキップ |

`ocr-api` には旧GAS連携の非同期 `POST /recognize` と、D1/Pages Functions 向けの同期 `POST /recognize-sync` があります。`OCR_API_URL` には `/recognize-sync` を指定してください。

## データモデル

### D1

D1 schema は `web/migrations/` にあります(`0001`〜`0009`)。主なテーブルは次の通りです。

| テーブル | 内容 |
| --- | --- |
| `users` | メール、ロール、有効/無効 |
| `candidates` | 候補者、受験日、ステータス、採用判定。`gender`(0005)、`postal_code`/`prefecture`/`city`/`address_line`(0009)を含む |
| `candidate_files` | 採点用紙ファイルのメタデータ(`storage_kind` で R2/D1/チャンクを切替) |
| `candidate_file_chunks` | D1 内に分割保存したファイル本体 |
| `raw_cells` | `s01`〜`s80` のセル JSON、信頼度、未解決数 |
| `review_queue` | 要確認セル |
| `results` | 採点確定結果 |
| `evaluations` | 面接評価ヘッダ(0007)。`0008` で `candidates` への FK を除去 |
| `evaluation_items` | 面接評価の 6 項目(score 1..5) |
| `evaluation_item_master` | 面接評価の 6 項目マスタ(seed 済み) |
| `evaluators` | 評価者マスタ(初期 0 名) |
| `api_operations` | 書き込み action の冪等性記録 |
| `api_nonces` | 署名付き envelope の nonce |
| `audit_log` | 操作ログ |
| `item_master` | CHEQ 項目マスタ |
| `score_bands` | 点数帯と段階 |
| `rank_rules` | 旧 RankRules 互換。現行の総合ランク固定判定では参照しない |
| `handwritten_totals` | 手書き合計との突合用 |

### Google Sheets

GAS と `scoring-api` は Google Sheets 上の同等シートを使います。主なタブは `Candidates`、`RawCells`、`ReviewQueue`、`ItemMaster`、`ScoreBands`、`RankRules`、`HandwrittenTotals`、`Results`、`AuditLog`、`Users`、`ApiOperations`、`ApiNonces`、`Config` です。

- ユーザータブの正式名は **`Users`** です(`ApiUsers` というタブは存在しません)。
- `Config` タブは `UPLOAD_FOLDER_ID` などを管理します。
- `Candidates` タブも `postal_code`/`prefecture`/`city`/`address_line`/`gender` 列を持ちます。`scoring-api` の `repository.ensure_headers` が書き込み前に不足列(canonical ヘッダー)を自動補完するため、列追加のライブ移行漏れを吸収します。
- **面接評価(evaluation)のタブは Sheets には存在しません。** 評価は D1 専用です。
- `RankRules` は旧データ互換で、現行の総合ランク判定では参照しません。

## 郵便番号→住所の自動補完(外部依存)

候補者フォームの「住所を自動入力」ボタン(`web/src/lib/zipcode.ts`)は、ブラウザから外部の郵便番号検索サービス `https://zipcloud.ibsnet.co.jp/api/search` へ **郵便番号のみ** を直接送信して住所を取得します。

- API キーは不要です。送信内容は郵便番号だけですが、第三者 API への外部通信が発生する点は把握しておいてください。
- 都道府県・市区町村は上書きし、町域は番地欄へ補完します。再検索時は「前回自動補完した町域」だけを差し替え、手入力済みの番地・建物名は保持します(`mergeAutoTown`)。
- 取得に失敗した場合は手入力にフォールバックします。確定した住所は候補者の住所列に保存されます。

## サブプロジェクト

### web

React + Vite + Tailwind の UI と Cloudflare Pages Functions です。UI コンポーネントは `web/src/components/`、画面は `web/src/pages/`、API 型は `web/src/lib/types.ts` にあります。テスト結果なし登録・候補者編集・面接評価・郵便番号補完・性別・地域別/男女別ダッシュボードはここに実装されています。`VITE_DEMO=1` でバックエンド非接続のデモ表示にできます。

### scoring-api

Cloud Run 用 FastAPI です。Pages Functions から送られる envelope を検証し、Google Sheets を読み書きします。`registerCandidate` に `file.base64` が含まれる場合は Cloud Run 上で PDF/画像を直接 OCR し、未解決セルが 0 件なら採点確定まで進みます。`attachScoresheet`(採点用紙の後付け、確定済みは拒否)と `updateCandidate`(氏名/受験日/性別/住所/メモ更新)も実装済みです。D1 経路の結果PDFだけを描画する `POST /render-pdf` も持ち、これは `PDF_RENDER_KEY` Bearer 認証で Sheets には触りません。

主要ファイル:

| ファイル | 役割 |
| --- | --- |
| `scoring-api/main.py` | HTTP 入口、`/readyz`、`/api`、`/render-pdf` |
| `scoring-api/src/wire.py` | envelope、署名、action/role |
| `scoring-api/src/security.py` | HMAC、timestamp、nonce、認可、冪等性 |
| `scoring-api/src/repository.py` | Google Sheets repository、`ensure_headers` |
| `scoring-api/src/handlers.py` | action handler、地域別ダッシュボード集計 |
| `scoring-api/src/upload_recognition.py` | アップロードファイル OCR |
| `scoring-api/src/scoresheet_recognizer.py` | 採点表 OCR |
| `scoring-api/src/scoring.py` | 採点ロジック・ランク判定 |
| `scoring-api/src/pdf.py` | 結果 PDF 生成 |

詳細は [scoring-api/README.md](scoring-api/README.md) を参照してください。

### ocr-api

GAS から `/recognize` を呼ぶ旧連携向けの OCR 単体 API です。Drive から採点用紙を取得し、採点表 page.5 の `s01`〜`s80` を OpenCV で解析して GAS Webhook に返します。D1/Pages Functions 向けには `POST /recognize-sync` があり、base64 のPDF/画像を同期解析して recognition ペイロードを返します。認証・採点・Sheets 書き込み・PDF 生成は持たず、OCR と Drive・GAS callback だけを担います。読めないセルは握りつぶさず、全件レビュー対象として返します。

主要ファイル:

| ファイル | 役割 |
| --- | --- |
| `ocr-api/main.py` | `POST /recognize`、`POST /recognize-sync`、`GET /healthz`、`GET /readyz` |
| `ocr-api/src/scoresheet_recognizer.py` | 現行採点表の認識 |
| `ocr-api/src/scoresheet_grid.py` | 格子検出 |
| `ocr-api/src/scoresheet_layout.py` | セルキーと格子位置の変換、`scoresheet_digit_map.json` 読込 |
| `ocr-api/src/drive_client.py` | Drive ファイル取得・レビュー画像保存 |
| `ocr-api/src/callback_client.py` | GAS callback(署名はクエリで渡す) |
| `ocr-api/cli.py` | ローカル OCR 確認 |

実物用紙で OCR を調整する場合は [ocr-api/README.md](ocr-api/README.md) のキャリブレーション手順を使ってください。

### 採点コア

`scoring-core/src/cheqScoring.js` は GAS へコピー可能な CommonJS の純粋関数で、採点ロジックの正本です。詳細は [採点コアと総合ランク](#採点コアと総合ランク) を参照してください。

### GAS

`gas/Code.production.gs` は旧運用の GAS バックエンドです。スプレッドシート初期化、Drive 保存、OCR 起動、Webhook 取り込み、採点、PDF 生成、総合ランク判定を持っています。`gas/ApiRouter.gs` は Pages Functions や `scoring-api` と同じ action/envelope に寄せた API router です。**面接評価(evaluation)系・`exportBackup`・採点用紙の後付け(`attachScoresheet`)は GAS には実装されていません。**

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

デプロイは [DEPLOYMENT.md](DEPLOYMENT.md) と `deploy-all.sh` が正本です。実行担当者は対象環境、secrets、サービスアカウント、Spreadsheet 共有を確認してから行ってください。

全体デプロイ:

```bash
./deploy-all.sh
```

対象を絞る例:

```bash
./deploy-all.sh --skip-scoring-api --skip-ocr-api  # web only
./deploy-all.sh --skip-web --skip-ocr-api          # scoring-api only
./deploy-all.sh --skip-web --skip-scoring-api      # ocr-api only
./deploy-all.sh --dry-run                          # 実行せずコマンドだけ確認
```

`deploy-all.sh` は `web`、`scoring-api`、`ocr-api` だけを扱います。`gas/` の Apps Script デプロイと `scoring-core/sync-gas.sh` は含まれません。

### Cloudflare Pages

1. `web/` で `pnpm build` が通ることを確認する。
2. D1 migrations(`0001`〜`0009`)を対象環境に適用する。`0005`(性別)/`0007`・`0008`(面接評価)/`0009`(住所)が未適用だと、評価登録・住所保存・地域別ダッシュボードが動かない。
3. `FUNCTIONS_GAS_SECRET`、認証関連、必要なら `SCORING_API_URL`/`GAS_API_URL` を Pages secrets/vars に設定する。
4. Cloudflare Access を使う場合は `CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` を設定する。
5. D1 経路でOCRを使う場合は `OCR_API_URL`/`OCR_API_KEY`、PDFを使う場合は `PDF_RENDER_URL`/`PDF_RENDER_KEY` を設定する。
6. R2 を使う場合は `wrangler.toml` に `CHEQ_FILES` binding を追加する。

実行コマンド:

```bash
cd web
pnpm run deploy
```

`pnpm run deploy` は `--branch main` 付きで `cheq-eqtest` の Cloudflare Pages 本番へデプロイします。

### Cloud Run scoring-api

1. `scoring-api/` で `uv run pytest -q` を通す。
2. Cloud Run 実行サービスアカウントを対象 Spreadsheet とアップロード保存先 Drive folder に共有する。
3. `FUNCTIONS_GAS_SECRET`、`SCORING_SPREADSHEET_ID`、`SCORING_UPLOAD_DRIVE_FOLDER_ID`、必要なら `PDF_RENDER_KEY` を設定する。
4. `/readyz` と Pages Functions からの `me` action で疎通確認する。

実行コマンド:

```bash
make -C scoring-api deploy
```

PDF 生成に WeasyPrint を使うため、`scoring-api/Dockerfile` は `libcairo2`/`libpango`/`libgdk-pixbuf`/`fonts-noto-cjk` 等を導入しています。これらを削ると PDF 生成が壊れます。

### Cloud Run ocr-api

旧 GAS 連携、または D1 経路の同期OCRで必要な場合に使います。`RECOGNITION_API_KEY` と `RECOGNITION_WEBHOOK_SECRET` を GAS と揃え、Drive フォルダを Cloud Run 実行サービスアカウントに共有してください。D1 経路から使う場合は Pages 側の `OCR_API_URL` を `/recognize-sync` に向け、`OCR_API_KEY` には `RECOGNITION_API_KEY` と同じ値を設定します。

実行コマンド:

```bash
make -C ocr-api deploy
```

## 引き継ぎ時の注意点

- **二重ストア**: 本番候補者は Google Sheets(Cloud Run 経路)、面接評価(evaluation)は Cloudflare D1 という分裂があります。`SCORING_API_URL` を設定した本番でも、評価系 6 action と `exportBackup` は常に D1 へ流れます。D1 の `candidates` は空である前提なので、評価処理に候補者の存在チェックを足すと本番で壊れます。
- **D1 単独で追加設定が必要な機能**: `attachScoresheet`(採点用紙後付け)は `OCR_API_URL`/`OCR_API_KEY`、`getResultPdf` は `PDF_RENDER_URL`/`PDF_RENDER_KEY` が無いと 400 になります。`SCORING_API_URL` だけでは D1 専用 action や PDF renderer は有効になりません。
- **テスト結果なし登録の初期ステータス**: 用紙なし登録は `scoring-api`(Sheets)も D1 も uploaded 相当です。D1 では手入力用の review queue は作られますが、ステータス表示だけを見ると「未実施」と混同しやすいので結果ページとレビュー画面の両方で確認してください。
- **採点ロジックの複製**: 採点コアは 4 箇所に複製され、総合ランク A〜D 判定は正本コアに含まれず GAS/`scoring-api`/D1 の 3 箇所に別個実装です。`sync-gas.sh` で同期されるのは `gas/CheqScoring.gs` のみです([採点コアと総合ランク](#採点コアと総合ランク))。
- **OCR 実装の二重管理**: `ocr-api/src/scoresheet_*` と `scoring-api/src/scoresheet_*` は同種の実装で自動共有はありません。しきい値や `scoresheet_digit_map.json` を変える場合は、どちらを正とするか決めて手動同期してください。
- **R2 binding 未定義**: `wrangler.toml` に `CHEQ_FILES`(R2)binding は定義されていません。R2 保存を使うには手動追加が必要です。
- **`export-d1-spreadsheet-backup.mjs` の DB 名**: デフォルトは `cheq-eqtest` ですが、`wrangler.toml` の D1 database name は `cheq-eqtest-db` です。使う場合は `--database cheq-eqtest-db` を明示してください(`package.json` 未配線のため `pnpm exec node scripts/...` で直接実行)。
- **deploy-all.sh の対象外**: `deploy-all.sh` は `web`、`scoring-api`、`ocr-api` だけです。GAS への `clasp` 反映、Apps Script の新バージョン公開、`scoring-core/sync-gas.sh` は別作業です。
- **OCR はスキャン品質に強く依存**します。実物用紙で `ocr-api` または `scoring-api` の `scoresheet_recognizer` を確認してから本番投入してください。
- **secret は Git に置かない**: `FUNCTIONS_GAS_SECRET`、`RECOGNITION_API_KEY`、`RECOGNITION_WEBHOOK_SECRET`、共有パスワードは Cloudflare Pages secrets、Cloud Run secrets、Apps Script Properties で管理してください。
- **書き込み action は `operationId` 必須** です。同じ `operationId` を別 action に使うと conflict になります。
- **ユーザー権限は `operator`/`reviewer`/`admin` の 3 段階** です。採点確定・PDF・採用判定・面接評価の削除・バックアップは必要ロールを確認してください。
- 採点マスタを変更した場合は、D1 migrations、Google Sheets の seed、GAS、`scoring-core`、`scoring-api` の整合性を確認してください。
- 作業前に `git status --short` で既存の未コミット変更を確認してください。

## 新しく開発に入る人向けチェックリスト

1. `git status --short` で既存の未コミット変更を確認する。
2. [全体像](#全体像今あなたが触る経路はどれか) で「今自分が触る経路」(本番 Cloud Run / ローカル D1 単独 / 旧 GAS)を確定する。
3. `VITE_DEMO=1 pnpm dev` でまず画面を一通り触り、機能の全体像を掴む。
4. 変更対象が Web、Cloud Run、OCR、GAS、採点コアのどれかを決める。
5. 対象サブプロジェクトの依存を `pnpm install` または `uv sync` で用意し、既存テストで現在地を確認する。
6. API action・型・保存先・ロールを変える場合は Web とバックエンドの両方を追う。特に面接評価は D1 専用、D1 経路のOCR/PDFは `OCR_API_*` / `PDF_RENDER_*` が必要という非対称に注意する。
7. OCR や採点ロジックを変える場合は、合成テストだけでなく実物に近い PDF/画像でも確認する。総合ランクを変えるなら 3 実装すべてを直す。
8. README やサブ README に、次の担当者が必要とするコマンド・環境変数・制約を残す。

## よくあるトラブル

| 症状 | 確認すること |
| --- | --- |
| API が 401 | Cloudflare Access JWT、`APP_ACCESS_PASSWORD`、`ALLOW_INSECURE_DEV_AUTH` のどれで認証するか確認 |
| API が 403 | `users` / Sheets `Users` タブのロールと active 状態を確認 |
| 書き込みが 400 | `operationId` が入っているか確認 |
| 採点確定ボタンが効かない | 全セルが空(テスト結果なし)では確定不可。用紙アップロードか手入力でセルを埋める |
| 結果ページが「テスト未実施」 | 用紙未添付の登録。`採点用紙をアップロード` か `採点する` から仕上げる |
| `attachScoresheet` が 400 | D1 経路なら `OCR_API_URL`/`OCR_API_KEY`、委譲経路なら `SCORING_API_URL`/`FUNCTIONS_GAS_SECRET` を確認 |
| 面接評価が保存できない / Candidate not found | D1 migrations(`0007`/`0008`)が未適用、または候補者存在チェックを足していないか確認(評価は D1 専用、候補者は Sheets) |
| 郵便番号からの住所補完が効かない | ブラウザから zipcloud 外部 API への到達性、郵便番号の桁を確認 |
| Cloud Run 委譲が失敗 | `SCORING_API_URL`、`FUNCTIONS_GAS_SECRET`、Cloud Run logs を確認 |
| Sheets 読み書きが失敗 | Cloud Run 実行サービスアカウントに Spreadsheet を共有しているか確認 |
| `ApiUsers` タブが見つからない | 正式名は `Users`。`ApiUsers` というタブは存在しない |
| レビュー画面に用紙が出ない | `source_url`、`candidate_files`、R2/GAS Drive 保存先、`/files/*` を確認 |
| PDF が D1 経路で出ない | `PDF_RENDER_URL`/`PDF_RENDER_KEY` と `scoring-api /render-pdf` の応答を確認 |
| OCR が全セル要確認になる | 用紙 page、解像度、傾き、`scoresheet_grid.py` の格子検出、MIME type を確認 |

## ライセンス

MIT License です。詳しくは [LICENSE](LICENSE) を見てください。
