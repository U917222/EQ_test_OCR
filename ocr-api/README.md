# ocr-api — CHEQ採点用紙 マーク検出API

CHEQ採点支援システムの画像解析を担うCloud Run用Python API。
GASから受け取った採点用紙画像をOpenCVで解析し、採点表セル `s01`〜`s80` の値（0〜3）と信頼度を読み取って、GASのWebhookへ返します。

> 設計の背景・データ契約は `../docs/`（`requirements.md`・`cell-contract.md`）を参照。本READMEは実行手順に絞っています。

---

## 目次

1. [全体の流れ](#全体の流れ)
2. [構成ファイル](#構成ファイル)
3. [前提ツール](#前提ツール)
4. [セットアップ](#セットアップ)
5. [ローカルで試す（認証不要）](#ローカルで試す認証不要)
6. [テスト](#テスト)
7. [用紙レイアウトのキャリブレーション](#用紙レイアウトのキャリブレーション最重要)
8. [Cloud Runへのデプロイ](#cloud-runへのデプロイ)
9. [GAS側の設定](#gas側の設定)
10. [エンドツーエンド動作確認](#エンドツーエンド動作確認)
11. [環境変数リファレンス](#環境変数リファレンス)
12. [トラブルシューティング](#トラブルシューティング)

---

## 全体の流れ

```text
GAS Webアプリ
  │ 1. 候補者登録時、Drive画像URLとコールバックURLをPOST
  │    POST /recognize { candidateId, sourceUrl, callbackUrl }
  │    Header: Authorization: Bearer <RECOGNITION_API_KEY>
  ▼
ocr-api (Cloud Run)
  │ 2. Bearerトークンを検証して即 202 を返す
  │ 3. バックグラウンドでDrive画像を取得
  │ 4. PDF/画像を読み込み → 採点表の格子を検出 → ○の濃さを計測
  │ 5. ○で囲まれた数字をセル値に変換し、信頼度を計算
  │ 6. 低信頼設問は切り出し画像をDriveへ保存（任意）
  │ 7. callbackUrl へ結果をPOST
  │    POST { action: "recognitionResult", candidateId, recognition }
  │    Query: cheqTimestamp=<unix秒>&cheqSignature=sha256=<HMAC>
  ▼
GAS Webhook (doPost)
  └ RawCells / ReviewQueue / Results へ反映
```

解析に失敗した場合は全設問を「空欄・信頼度0」で返し、ReviewQueueで人間が確認できるようにします（握りつぶさない方針）。

D1 / Cloudflare Pages Functions 経路では、Drive/callback を使わない同期API `POST /recognize-sync` も使います。`file.base64` と MIME type を受け取り、その場で `recognition` を返します。

---

## 構成ファイル

| ファイル | 役割 |
| --- | --- |
| `main.py` | FastAPIのHTTP入口（`POST /recognize`、`POST /recognize-sync`、`GET /healthz`、`GET /readyz`）。Bearer検証とバックグラウンド処理 |
| `src/scoresheet_recognizer.py` | 採点表 `s01`〜`s80` の○検出・信頼度計算 |
| `src/scoresheet_grid.py` | 採点表の罫線格子検出 |
| `src/scoresheet_layout.py` | セルキー `s01`〜`s80` と数字配列マスタの読み込み |
| `src/recognizer.py` | 旧200問モデルの認識処理。現行の採点表連携では通常使わない |
| `src/drive_client.py` | Drive画像の取得・レビュー画像の保存 |
| `src/callback_client.py` | GAS Webhookへの結果返却 |
| `src/sample.py` | 旧200問モデル用の合成サンプル画像生成 |
| `cli.py` | ローカル確認用CLI（認証不要） |
| `tests/` | 合成画像による認識テスト |
| `Dockerfile` | Cloud Run用コンテナ定義 |

---

## 前提ツール

- **Python 3.12 以上**
- **uv**（パッケージ管理。`pip` は使わない）
  ```bash
  # 未インストールなら
  brew install uv
  ```
- Cloud Runへデプロイする場合のみ **gcloud CLI**

---

## セットアップ

```bash
cd ocr-api
uv sync          # pyproject.toml / uv.lock どおりに依存をインストール
```

`uv sync` は `.venv/` を作成します。以降のコマンドは `uv run` 経由で実行すれば仮想環境を自動で使います。

---

## ローカルで試す（認証不要）

Google Cloud認証なしで、認識ロジックだけをその場で試せます。

### 1. 採点表画像またはPDFを用意

現行のOCRは CHEQ 採点表 page.5 の `s01`〜`s80` を読む処理です。JPEG、PNG、PDF の採点表画像を用意してください。

HEIC / HEIF は未対応です。iPhone 画像が HEIC の場合は、先に JPEG へ変換します。

```bash
sips -s format jpeg input.HEIC --out input.jpg
```

### 2. 認識して結果を表示

```bash
uv run python cli.py scoresheet scan.pdf
uv run python cli.py scoresheet scan.jpg
```

出力例:

```text
=== 採点表 認識結果 ===
PDFページ        : 5ページ目
確定セル        : 78/80
信頼度 平均/最小: 0.982 / 0.200

--- 行得点 (上ブロック/下ブロック) ---
  A1= 7  B1= 9  C1= 8  D1= 5  E1= 6  F1=10  G1= 4  H1= 9  I1= 7  J1= 8
  A2= 8  B2= 6  C2= 7  D2= 9  E2= 5  F2= 8  G2= 7  H2= 6  I2= 8  J2= 9

--- 要確認セル ---
  s07 (B1): blank
  s42 (A2): multiple
```

### 3. 要確認セルの切り出し画像も保存する

```bash
uv run python cli.py scoresheet scan.pdf --dump-review ./out
```

`./out` に低信頼セルの画像が保存されます。枠ズレや○の読み取り失敗を目で確認するときに使います。

### サーバーを起動して疎通だけ確認

```bash
uv run uvicorn main:app --port 8080
# 別ターミナルで
curl -s http://127.0.0.1:8080/healthz       # => {"ok":true}
```

`POST /recognize` 自体はDrive取得とGASコールバックが必要なため、完全な動作確認は[エンドツーエンド](#エンドツーエンド動作確認)で行います。

D1 経路と同じ同期APIを試す場合:

```bash
curl -s http://127.0.0.1:8080/recognize-sync \
  -H "Authorization: Bearer $RECOGNITION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"file":{"base64":"<BASE64>","mimeType":"application/pdf","name":"scan.pdf"}}'
```

---

## テスト

```bash
uv run pytest            # OCR APIと認識処理のテスト
uv run pytest -v         # 詳細表示
```

---

## 用紙レイアウトのキャリブレーション（最重要）

`src/scoresheet_grid.py` と `src/scoresheet_recognizer.py` のしきい値は、スキャン品質に応じて調整が必要になる場合があります。本番運用前に実物のCHEQ用紙で必ず確認してください。

### 手順

1. 実際のCHEQ用紙を1〜数枚スキャン／撮影する
2. `uv run python cli.py scoresheet <実物画像またはPDF> --dump-review ./out` を実行する
3. `./out` の切り出し画像を見て、枠ズレや○の検出失敗がないか確認する
4. 格子検出が失敗する場合は `src/scoresheet_grid.py` を調整する
   | パラメータ | 意味 |
   | --- | --- |
   | `HORIZ_KERNEL_RATIO` | 水平罫線を拾う強さ |
   | `VERT_KERNEL_RATIO` | 垂直罫線を拾う強さ |
   | `TABLE_MIN_X_RATIO` | 得点表が用紙右側にある前提の位置 |
   | `TABLE_MIN_W_RATIO` / `TABLE_MIN_H_RATIO` | 得点表として採用する最小サイズ |
5. ○の判定が不安定な場合は `src/scoresheet_recognizer.py` を調整する
   | しきい値 | 意味 |
   | --- | --- |
   | `MIN_RING_DELTA` | これ未満は「○なし」とみなす |
   | `TARGET_RING_DELTA` | この差分以上で○の濃さを満点に近く扱う |
   | `MULTI_RING_DELTA` | 2番目の候補もこれ以上なら複数○とみなす |
   | `AMBIGUOUS_MARGIN` | 1位と2位の差が小さいとき信頼度を下げる |
   | `REVIEW_CONFIDENCE` | これ未満の設問は切り出し画像を保存 |
6. 数字の並びが実物と違う場合は `src/scoresheet_digit_map.json` を修正する
7. 誤読パターン（薄い鉛筆／消し跡／複数選択／斜め撮影／影／低解像度／用紙端欠け／折れしわ）を分類して再調整する
8. 30〜100枚程度で再テストし、信頼度しきい値を保守的に設定する

---

## Cloud Runへのデプロイ

### 1. Google Cloud準備（初回のみ）

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>

# 必要なAPIを有効化
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Billingの有効化と**予算アラートの設定**も忘れずに（無料枠運用でもBilling有効化は必要）。

### 2. デプロイ

```bash
cd ocr-api
gcloud run deploy ocr-api \
  --source . \
  --region asia-northeast1 \
  --cpu 1 --memory 512Mi \
  --min-instances 0 --max-instances 1 --concurrency 1 \
  --allow-unauthenticated \
  --set-env-vars RECOGNITION_API_KEY=<生成した強いランダム文字列>,RECOGNITION_WEBHOOK_SECRET=<別の強いランダム文字列>,RECOGNITION_CALLBACK_ALLOWED_HOSTS=script.google.com
```

- `--allow-unauthenticated` で公開URLにし、API側の `Authorization: Bearer` で守る方式（GASから呼びやすい）。
- secretは平文env varより **Secret Manager** 管理が望ましい（`--set-secrets` を使用）。
- 低信頼設問の切り出し画像をDriveへ保存したい場合は `REVIEW_IMAGE_FOLDER_ID=<DriveフォルダID>` も追加。

デプロイ後に表示される `https://ocr-api-xxxxx-an.a.run.app` がエンドポイントです。`/recognize` を付けてGASに設定します。

### 3. Driveの共有設定

Cloud Run実行サービスアカウント（ADC）でDriveへアクセスします。サービスアカウントのメールアドレスへ、対象フォルダを共有してください。

| フォルダ | 必要権限 |
| --- | --- |
| `UPLOAD_FOLDER_ID`（GAS側の原本保存先） | 閲覧者以上 |
| `REVIEW_IMAGE_FOLDER_ID`（レビュー画像保存先、使う場合） | 編集者 |

```bash
# 実行サービスアカウントの確認
gcloud run services describe ocr-api --region asia-northeast1 \
  --format 'value(spec.template.spec.serviceAccountName)'
```

### 4. 無料枠の目安

Cloud Runは小規模なら無料枠に収まりやすい。1枚あたりの処理時間ごとの、無料枠内で処理できるおおよその月間枚数:

| 1枚あたりの処理時間 | 無料枠内の目安 |
| --- | ---: |
| 5秒 | 約36,000枚/月 |
| 10秒 | 約18,000枚/月 |
| 30秒 | 約6,000枚/月 |
| 60秒 | 約3,000枚/月 |

無料運用を狙う場合は、デプロイ時の `--min-instances 0 --max-instances 1 --concurrency 1 --cpu 1 --memory 512Mi` を基準にし、**Google Cloud Billingの予算アラートを必ず設定**する（無料枠でもBilling有効化は必要。無料枠超過やログ量で少額課金される可能性がある）。

---

## GAS側の設定

スプレッドシートの `Config` シート:

| key | value |
| --- | --- |
| `UPLOAD_FOLDER_ID` | アップロード原本の保存先DriveフォルダID（必須） |
| `RECOGNITION_ENDPOINT_URL` | `https://ocr-api-xxxxx-an.a.run.app/recognize` |
| `RECOGNITION_MIN_CONFIDENCE` | `0.8`（初期値） |
| `AUTO_FINALIZE_WHEN_CLEAN` | `false`（初期値） |

Apps ScriptのScript Properties（**Cloud Run側と同じ値**にする）:

| key | value |
| --- | --- |
| `RECOGNITION_API_KEY` | Cloud Runに設定したものと同じ |
| `RECOGNITION_WEBHOOK_SECRET` | Cloud Runに設定したものと同じ |
| `RECOGNITION_ENDPOINT_HOSTS` | OCR APIの許可host。例: `ocr-api-xxxxx-an.a.run.app` |
| `AUTHORIZED_USER_EMAILS` | Web UI利用者メールアドレス（カンマ区切り） |
| `ADMIN_USER_EMAILS` | 管理者メールアドレス（カンマ区切り） |
| `APP_ACCESS_CODE` | Web UIで入力するアクセスコード |

GAS Webアプリは `実行ユーザー: 自分`、`アクセスできるユーザー: 全員` でデプロイし、Cloud Runから到達できるようにします。Apps Script Web Appの `doPost(e)` はカスタムHTTPヘッダーを読めないため、OCR APIはJSON bodyそのものをHMAC署名し、`cheqTimestamp` と `cheqSignature` query parameterで返します。公開範囲を広げるため、Web UI操作は `APP_ACCESS_CODE` または許可済みメールで守り、Webhookは必ず `RECOGNITION_WEBHOOK_SECRET` によるHMAC検証を有効にしてください。

---

## エンドツーエンド動作確認

1. テスト用の回答画像をGAS Webアプリからアップロードする
2. `Candidates` シートに行が作成される
3. 候補者ステータスが `PROCESSING` になる
4. Cloud Runのログにリクエストが届く
   ```bash
   gcloud run services logs read ocr-api --region asia-northeast1 --limit 50
   ```
5. `RawCells` に回答が入る
6. 低信頼の設問が `ReviewQueue` に入る
7. 採点結果が想定通りになる

---

## 環境変数リファレンス

このAPIが実際に参照する環境変数:

| 変数 | 必須 | 用途 |
| --- | --- | --- |
| `RECOGNITION_API_KEY` | 本番で必須 | GASからの呼び出しを検証するBearerトークン。未設定時は `/recognize` を拒否 |
| `ALLOW_INSECURE_DEV_AUTH` | ローカルのみ | `true` の場合だけ、`RECOGNITION_API_KEY` 未設定でも `/recognize` を許可 |
| `RECOGNITION_CALLBACK_URL` | 任意 | GAS callback URLをCloud Run側で固定する。設定時はリクエストの `callbackUrl` を使わない |
| `RECOGNITION_CALLBACK_ALLOWED_HOSTS` | 条件付き必須 | リクエスト供給の `callbackUrl` を使う場合のHTTPS host allowlist（カンマ区切り） |
| `RECOGNITION_WEBHOOK_SECRET` | 本番で必須 | callback JSON bodyには入れず、`cheqSignature` HMAC生成に使う共有secret |
| `RECOGNITION_ALLOWED_MIME_TYPES` | 任意 | Driveから取得可能なMIME type allowlist。未設定時は `application/pdf,image/jpeg,image/png` |
| `RECOGNITION_MAX_FILE_BYTES` | 任意 | Driveダウンロード前に拒否する最大バイト数。未設定時は20MiB |
| `REVIEW_IMAGE_FOLDER_ID` | 任意 | 低信頼設問の切り出し画像を保存するDriveフォルダID。未設定なら保存しない |

> `GOOGLE_CLOUD_PROJECT` / `USE_VISION_OCR` は現時点のコードでは未使用です（Vision OCRは未実装）。氏名・日付などの文字欄OCRが必要になった段階で追加します。

---

## トラブルシューティング

| 症状 | 原因・対処 |
| --- | --- |
| サンプルは読めるが実物が読めない | レイアウト未調整。[キャリブレーション](#用紙レイアウトのキャリブレーション最重要)を実施 |
| `401 invalid bearer token` | GASのScript Property `RECOGNITION_API_KEY` とCloud Runのenv varが不一致 |
| `503 RECOGNITION_API_KEY is not configured` | Cloud Run側の `RECOGNITION_API_KEY` が未設定。ローカル検証以外は設定必須 |
| `400 callback_host_not_allowed` | `callbackUrl` のhostが `RECOGNITION_CALLBACK_ALLOWED_HOSTS` に入っていない |
| GASに結果が届かない | `RECOGNITION_WEBHOOK_SECRET` のHMAC検証不一致、timestamp期限切れ、またはWebアプリの公開範囲。Cloud Runログを確認 |
| `could not extract Drive file id` | `sourceUrl` がDrive共有URL形式でない。GASの `saveUploadedFile_` の戻り値URLを確認 |
| Driveで403/404 | サービスアカウントへフォルダが共有されていない。[Drive共有設定](#3-driveの共有設定)を確認 |
| 全設問が空欄・信頼度0で返る | 画像デコード失敗や例外。Cloud Runログのスタックトレースを確認 |
| ローカルで `No module named 'src'` | `ocr-api/` 直下から `uv run` で実行する（`pyproject.toml` の `pythonpath=["."]` が効く位置） |
