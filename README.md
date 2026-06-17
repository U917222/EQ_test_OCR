# CHEQ 採点支援システム

CHEQ の採点用紙をアップロードし、読み取り、確認し、採点結果を出すためのシステムです。

この README は「手順どおりに進めれば使える」ことを優先して書いています。わからない言葉が出てきたら、まずはそのままコピーして進めてください。

## この README の歩き方

この README は長いですが、**全部を読む必要はありません**。自分の役割の行だけ読めば大丈夫です。

| あなたは… | 読むところ | だいたいの所要時間 |
| --- | --- | --- |
| 採点用紙を登録・確認したいだけの人（利用者） | 「9. 使い方」だけ | 5分 |
| システムを一から立ち上げる人（導入担当） | 「初回導入でやること」→ 1〜10章を上から順に | 半日〜1日 |
| OCR（画像の自動読み取り）も使いたい人 | 上に加えて「8. OCR API を Cloud Run に出す」 | +1〜2時間 |
| コードを直したい人（開発者） | 「開発する人向け」 | 環境構築 約30分 |

### つまずいたら

- **わからない言葉が出てきたら** → 一番下の「用語集」を見てください。たいていの専門用語はそこで説明しています。
- **コマンドを打つ黒い画面（ターミナル）の開き方がわからない** → Mac なら、画面右上の虫めがね（Spotlight）を押して「ターミナル」と打ち、Enter で開きます。`アプリケーション` → `ユーティリティ` → `ターミナル.app` でも開けます。
- **コマンドは、まるごとコピーして貼り付け、最後に Enter** で実行します。意味がわからなくても、手順どおりなら動きます。
- **エラーが出ても焦らない** → 「よくあるトラブル」と各章の確認表を見れば、たいていは設定の入れ忘れです。

### 最低限おぼえる5つの言葉

| 言葉 | ざっくり言うと |
| --- | --- |
| GAS（ガス） | Google の無料のプログラム置き場。今回は管理画面を動かす土台 |
| スプレッドシート | Google の表計算。今回はデータベース兼管理画面として使う |
| OCR（オーシーアール） | 画像から文字や丸印を読み取る技術 |
| Cloud Run（クラウドラン） | Google Cloud 上でプログラムを動かす場所。OCR をここで動かす |
| ID（アイディー） | ファイルやフォルダに付いた長い文字列の「住所」。URL の中に入っている |

すべての用語は一番下の「用語集」にまとめてあります。

## できること

- Google スプレッドシートを管理画面として使う
- Apps Script の Web 画面から候補者と採点用紙を登録する
- OCR API が採点用紙画像や PDF を読み取る
- 読み取りが怪しいセルを人が確認する
- 採点結果とダッシュボードを見る

## 全体のしくみ

```text
Web画面(GAS)
  ↓ 採点用紙をアップロード
Google Drive
  ↓ 画像を読む
OCR API(Cloud Run)
  ↓ 読み取り結果を返す
Googleスプレッドシート
  ↓
採点・確認・結果表示
```

## フォルダの説明

| フォルダ | 何が入っているか |
| --- | --- |
| `gas/` | Google Apps Script に入れるファイル |
| `ocr-api/` | 採点用紙を読み取る Python API |
| `scoring-core/` | 採点ロジックとテスト |
| `docs/` | 詳しい設計メモ、チェックリスト |

## 初回導入でやること

新しく参加した人は、次の順番で進めると最初から最後まで動かせます。

1. このリポジトリを手元に用意する
2. Google スプレッドシートを作る
3. Apps Script に `gas/` のファイルを入れる
4. Apps Script の初期セットアップを実行する
5. Drive のアップロード用フォルダを作る
6. Apps Script のスクリプトプロパティを設定する
7. Apps Script を Web アプリとして公開する
8. OCR API を Cloud Run にデプロイする
9. スプレッドシート、Apps Script、Cloud Run を接続する
10. テスト用データで動作確認する

OCR を使わず手入力だけで運用する場合は、8 の Cloud Run 手順だけ飛ばせます。

## 最初に用意するもの

### 必ず必要

- Google アカウント
- Google スプレッドシート
- Google Drive のフォルダ
- Google Apps Script

### OCR を自動で使う場合に必要

- Google Cloud プロジェクト
- Cloud Run
- `gcloud` コマンド
- 請求先アカウントの設定
- Google Cloud で次を操作できる権限
  - API の有効化
  - Cloud Run のデプロイ
  - Secret Manager の作成
  - サービスアカウントの作成
  - IAM 権限の付与

### 開発やテストをする人だけ必要

- Node.js
- `pnpm`
- Python 3.12 以上
- `uv`

このリポジトリでは Node.js 系は `pnpm`、Python 系は `uv` を使います。`npm`、`yarn`、`pip` は使いません。

## 1. ファイルを手元に用意する

Git が使える場合:

```bash
git clone <このリポジトリのURL>
cd eqtest
```

Git がわからない場合:

1. GitHub のページを開く
2. `Code` ボタンを押す
3. `Download ZIP` を押す
4. ZIP を解凍する

## 2. Google スプレッドシートを作る

1. Google Drive を開く
2. `新規` を押す
3. `Google スプレッドシート` を押す
4. ファイル名を `CHEQ 採点管理` などに変える
5. 上のメニューから `拡張機能` → `Apps Script` を開く

あとで Apps Script に設定するため、スプレッドシート ID も控えます。

URL 例:

```text
https://docs.google.com/spreadsheets/d/ここがスプレッドシートID/edit
```

## 3. Apps Script にファイルを入れる

Apps Script 画面で、次のファイルを作ります。

### `Code.gs`

1. 最初からある `コード.gs` を開く
2. 中身を全部消す
3. このリポジトリの `gas/Code.production.gs` の中身を全部コピーする
4. `コード.gs` に貼り付ける

Apps Script 側のファイル名は `Code.gs` で問題ありません。

### `CheqScoring.gs`

1. Apps Script 左側の `+` を押す
2. `スクリプト` を選ぶ
3. ファイル名を `CheqScoring` にする
4. このリポジトリの `gas/CheqScoring.gs` の中身を全部コピーして貼り付ける

### `Index.html`

1. Apps Script 左側の `+` を押す
2. `HTML` を選ぶ
3. ファイル名を `Index` にする
4. このリポジトリの `gas/Index.html` の中身を全部コピーして貼り付ける

### `appsscript.json`

1. Apps Script 左側の歯車アイコンを押す
2. `appsscript.json マニフェスト ファイルをエディタで表示する` をオンにする
3. 左側に出てきた `appsscript.json` を開く
4. 中身を全部消す
5. このリポジトリの `gas/appsscript.json` の中身を全部コピーして貼り付ける

## 4. 初期セットアップを実行する

Apps Script 画面の上部で関数を選べる場所があります。

まず、初期セットアップ先のスプレッドシートを指定します。

1. Apps Script 左側の歯車アイコンを押す
2. `スクリプト プロパティ` を探す
3. `スクリプト プロパティを追加` を押す
4. プロパティに `SPREADSHEET_ID`、値に 2 で控えたスプレッドシート ID を入れる

次にシートを作成します。

1. 関数で `setupProductionWorkbook` を選ぶ
2. `実行` を押す
3. 権限確認が出たら許可する

成功すると、スプレッドシートに次のシートができます。

- `Candidates`
- `RawCells`
- `ReviewQueue`
- `ItemMaster`
- `ScoreBands`
- `RankRules`
- `HandwrittenTotals`
- `Results`
- `AuditLog`
- `Config`

次に採点マスタを入れます。

1. 関数で `seedScoresheetMasters` を選ぶ
2. `実行` を押す

## 5. Drive フォルダを作る

採点用紙を保存する場所を作ります。

1. Google Drive を開く
2. `新規` → `フォルダ` を押す
3. 名前を `CHEQ アップロード原本` などにする
4. 作ったフォルダを開く
5. URL の中のフォルダ ID をコピーする

URL 例:

```text
https://drive.google.com/drive/folders/ここがフォルダID
```

スプレッドシートの `Config` シートを開き、`UPLOAD_FOLDER_ID` の `value` にフォルダ ID を貼り付けます。

## 6. Apps Script の設定値を入れる

Apps Script 画面で設定を入れます。

1. 左側の歯車アイコンを押す
2. `スクリプト プロパティ` を探す
3. `スクリプト プロパティを追加` を押す

まずは最低限、次を入れます。

| プロパティ | 入れる値 |
| --- | --- |
| `SPREADSHEET_ID` | 2 で控えたスプレッドシート ID |
| `ADMIN_USER_EMAILS` | 管理者のメールアドレス |
| `AUTHORIZED_USER_EMAILS` | 使う人のメールアドレス。複数ならカンマ区切り |
| `APP_ACCESS_CODE` | Web 画面で入力するアクセスコード |

例:

```text
SPREADSHEET_ID = ここにスプレッドシートID
ADMIN_USER_EMAILS = admin@example.com
AUTHORIZED_USER_EMAILS = user1@example.com,user2@example.com
APP_ACCESS_CODE = cheq-ここに長めの合言葉
```

`APP_ACCESS_CODE` は Web 画面を開いた人が入力する合言葉です。Apps Script は利用者のメールアドレスを取得できない場合があるため、必ず入れておくと安全です。利用者にはこの値だけを伝え、GitHub や公開資料には載せないでください。

OCR API を使う場合は、あとで次も入れます。

| プロパティ | 入れる値 |
| --- | --- |
| `RECOGNITION_ENDPOINT_HOSTS` | OCR API のホスト名 |
| `RECOGNITION_API_KEY` | OCR API と同じ API キー |
| `RECOGNITION_WEBHOOK_SECRET` | OCR API と同じ Webhook secret |

## 7. Web アプリとして公開する

1. Apps Script 画面右上の `デプロイ` を押す
2. `新しいデプロイ` を押す
3. 種類で `ウェブアプリ` を選ぶ
4. 次のように設定する

| 項目 | 設定 |
| --- | --- |
| 実行するユーザー | 自分 |
| アクセスできるユーザー | 全員 |

5. `デプロイ` を押す
6. Web アプリの URL をコピーする

この URL が利用者用の画面です。

`アクセスできるユーザー` を `全員` にする理由は、Cloud Run から Apps Script へ読み取り結果を返すためです。知らない人が URL を開いても、操作には `APP_ACCESS_CODE` または許可済みメールアドレスが必要です。URL と `APP_ACCESS_CODE` は利用者以外に共有しないでください。

## 8. OCR API を Cloud Run に出す

OCR を自動で使わない場合、この章は飛ばして構いません。

Cloud Run は Google Cloud 上で OCR API を動かすサービスです。ここだけ少し難しいので、上から順番に進めてください。

参考:

- Cloud Billing: https://docs.cloud.google.com/billing/docs/how-to/manage-billing-account
- 予算アラート: https://docs.cloud.google.com/billing/docs/how-to/budgets
- Cloud Run のソースコードデプロイ: https://docs.cloud.google.com/run/docs/deploying-source-code

### 8-1. Google Cloud にログインする

1. https://console.cloud.google.com/ を開く
2. Google アカウントでログインする
3. 初めて使う場合は、利用規約の確認が出るので進める

### 8-2. 請求先アカウントを作る

Cloud Run を使うには、無料枠の範囲で使う場合でも請求先アカウントが必要です。

1. Google Cloud コンソール左上のメニューを開く
2. `お支払い` または `Billing` を開く
3. `請求先アカウントを作成` を押す
4. 国、名前、住所、支払い方法を入力する
5. 画面の案内に従って登録を完了する

注意:

- カード確認のために一時的な確認表示が出ることがあります。
- これは実際の利用料金とは別の確認処理です。
- OCR API を大量に使うと料金が発生する可能性があります。

### 8-3. Google Cloud プロジェクトを作る

1. 画面上部のプロジェクト選択を押す
2. `新しいプロジェクト` を押す
3. プロジェクト名を入れる

例:

```text
CHEQ OCR
```

4. `作成` を押す
5. 作成したプロジェクトを選ぶ

次に、プロジェクト ID を控えます。

1. Google Cloud コンソール上部でプロジェクト名を押す
2. `ID` と書かれている値をコピーする

例:

```text
cheq-ocr-123456
```

この README では、この値を `<YOUR_PROJECT_ID>` と書きます。

### 8-4. プロジェクトに請求先を紐づける

1. Google Cloud コンソール左上のメニューを開く
2. `お支払い` または `Billing` を開く
3. `マイ プロジェクト` を開く
4. 作成したプロジェクトを探す
5. 請求先アカウントが未設定なら、作成済みの請求先アカウントに紐づける

ここが終わっていないと、Cloud Run のデプロイで失敗します。

### 8-5. 予算アラートを作る

使いすぎを防ぐため、予算アラートを作ります。

1. Google Cloud コンソール左上のメニューを開く
2. `お支払い` または `Billing` を開く
3. 対象の請求先アカウントを選ぶ
4. `予算とアラート` を開く
5. `予算を作成` を押す
6. 対象プロジェクトで、作成した `CHEQ OCR` プロジェクトを選ぶ
7. 予算額を入れる

最初は少額で構いません。例:

```text
予算額: 1000円
通知: 50%、90%、100%
```

Google Cloud の予算アラートは「止める機能」ではなく「メールで知らせる機能」です。メールが来たらすぐ確認してください。

### 8-6. gcloud コマンドを用意する

Mac で Homebrew が使える場合:

```bash
brew install --cask google-cloud-sdk
```

インストールできたか確認します。

```bash
gcloud --version
```

バージョンが表示されれば大丈夫です。

### 8-7. ターミナルで Google Cloud にログインする

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>
```

`<YOUR_PROJECT_ID>` は自分の Google Cloud プロジェクト ID に置き換えます。

例:

```bash
gcloud config set project cheq-ocr-123456
```

今どのプロジェクトを使っているか確認します。

```bash
gcloud config get-value project
```

自分のプロジェクト ID が表示されれば OK です。

### 8-8. 必要な API を有効にする

Cloud Run のソースコードデプロイでは、Cloud Run、Cloud Build、Artifact Registry、Secret Manager、IAM を使います。まとめて有効にします。

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com
```

途中で確認が出たら `y` を入力します。

権限エラーが出る場合は、Google Cloud の管理者に次を依頼してください。

- 必要 API を有効化できる権限
- Cloud Run をデプロイできる権限
- Secret Manager に secret を作れる権限
- サービスアカウントを作れる権限
- Cloud Run にサービスアカウントを指定できる権限
- IAM 権限を付与できる権限

### 8-9. Cloud Run 用のサービスアカウントを作る

Cloud Run が Drive のファイルを読むための専用サービスアカウントを作ります。このメールアドレスをあとで Drive フォルダに共有します。

ここから 8-13 までは、できるだけ同じターミナルで続けて実行してください。途中でターミナルを閉じた場合は、この章の変数設定からやり直せば大丈夫です。

```bash
PROJECT_ID="$(gcloud config get-value project)"
CHEQ_REGION="asia-northeast1"
CHEQ_SERVICE="ocr-api"
CHEQ_RUN_SA="cheq-ocr-run@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create cheq-ocr-run \
  --display-name "CHEQ OCR Cloud Run runtime"
```

すでに作成済みで `already exists` と出た場合は、そのまま次へ進んでください。

### 8-10. OCR API の秘密値を作る

次の2つを作ります。

| 名前 | 何に使うか |
| --- | --- |
| `RECOGNITION_API_KEY` | GAS から OCR API を呼ぶための合言葉 |
| `RECOGNITION_WEBHOOK_SECRET` | OCR API から GAS に結果を返すときの署名用 |

この手順では Secret Manager に保存します。

```bash
CHEQ_API_KEY="$(openssl rand -hex 32)"
CHEQ_WEBHOOK_SECRET="$(openssl rand -hex 32)"

printf "%s" "$CHEQ_API_KEY" | gcloud secrets create cheq-recognition-api-key --data-file=-
printf "%s" "$CHEQ_WEBHOOK_SECRET" | gcloud secrets create cheq-recognition-webhook-secret --data-file=-
```

すでに secret があり `already exists` と出た場合は、新しいバージョンとして追加します。

```bash
printf "%s" "$CHEQ_API_KEY" | gcloud secrets versions add cheq-recognition-api-key --data-file=-
printf "%s" "$CHEQ_WEBHOOK_SECRET" | gcloud secrets versions add cheq-recognition-webhook-secret --data-file=-
```

作った値を Apps Script にも設定するため、次の表示結果を安全なメモに控えます。

```bash
printf "RECOGNITION_API_KEY = %s\n" "$CHEQ_API_KEY"
printf "RECOGNITION_WEBHOOK_SECRET = %s\n" "$CHEQ_WEBHOOK_SECRET"
```

この2つは他人に見せないでください。GitHub、README、スプレッドシートの通常セルには書かないでください。

ターミナルを閉じて値がわからなくなった場合は、権限があれば次で確認できます。

```bash
gcloud secrets versions access latest --secret=cheq-recognition-api-key
gcloud secrets versions access latest --secret=cheq-recognition-webhook-secret
```

### 8-11. Cloud Run が secret を読めるようにする

Cloud Run の実行サービスアカウントに Secret Manager の読み取り権限を付けます。

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${CHEQ_RUN_SA}" \
  --role "roles/secretmanager.secretAccessor"
```

`Policy modification failed` や `Permission denied` が出る場合は、Google Cloud の管理者に実行を依頼してください。

### 8-12. Cloud Run にデプロイする

このリポジトリの `ocr-api` フォルダに移動してから実行します。

```bash
cd ocr-api

gcloud run deploy "$CHEQ_SERVICE" \
  --source . \
  --region "$CHEQ_REGION" \
  --service-account "$CHEQ_RUN_SA" \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 1 \
  --allow-unauthenticated \
  --set-secrets RECOGNITION_API_KEY=cheq-recognition-api-key:latest,RECOGNITION_WEBHOOK_SECRET=cheq-recognition-webhook-secret:latest \
  --set-env-vars RECOGNITION_CALLBACK_ALLOWED_HOSTS=script.google.com
```

実行中に質問が出た場合:

| 質問 | 答え |
| --- | --- |
| API を有効にしますか | `y` |
| リージョンを選んでください | `asia-northeast1` |
| 未認証アクセスを許可しますか | `y` |

この OCR API は URL 自体は外からアクセス可能にしますが、`RECOGNITION_API_KEY` がないリクエストは拒否します。GAS から呼びやすくするため、この構成にしています。

デプロイ後に、次のような URL が表示されます。

```text
https://ocr-api-xxxxx-an.a.run.app
```

この URL を控えてください。

### 8-13. Cloud Run が動いているか確認する

サービス URL を取得します。

```bash
CHEQ_OCR_URL="$(gcloud run services describe "$CHEQ_SERVICE" \
  --region "$CHEQ_REGION" \
  --format 'value(status.url)')"

printf "%s\n" "$CHEQ_OCR_URL"
```

`/healthz` を開いて確認します。

```bash
curl "$CHEQ_OCR_URL/healthz"
```

次のように出れば OK です。

```json
{"ok":true}
```

### 8-14. スプレッドシート側に OCR API URL を入れる

スプレッドシートの `Config` シートで、次を入れます。

| key | value |
| --- | --- |
| `RECOGNITION_ENDPOINT_URL` | `https://ocr-api-xxxxx-an.a.run.app/recognize` |
| `RECOGNITION_MIN_CONFIDENCE` | `0.8` |
| `AUTO_FINALIZE_WHEN_CLEAN` | `false` |

`RECOGNITION_ENDPOINT_URL` は `/recognize` まで入れます。`/healthz` ではありません。

### 8-15. Apps Script 側に秘密値を入れる

Apps Script のスクリプトプロパティにも、次を入れます。

| プロパティ | 入れる値 |
| --- | --- |
| `RECOGNITION_ENDPOINT_HOSTS` | `ocr-api-xxxxx-an.a.run.app` |
| `RECOGNITION_API_KEY` | Secret Manager に保存した API キー |
| `RECOGNITION_WEBHOOK_SECRET` | Secret Manager に保存した Webhook secret |

`RECOGNITION_ENDPOINT_HOSTS` は `https://` を入れません。ホスト名だけを入れます。

良い例:

```text
ocr-api-xxxxx-an.a.run.app
```

悪い例:

```text
https://ocr-api-xxxxx-an.a.run.app/recognize
```

### 8-16. Drive フォルダを Cloud Run に共有する

Cloud Run が Drive の画像を読めるようにします。共有先は 8-9 で作ったサービスアカウントです。

```bash
printf "%s\n" "$CHEQ_RUN_SA"
```

表示されたメールアドレスに、`CHEQ アップロード原本` フォルダを共有します。

権限は `閲覧者` で大丈夫です。

Drive での操作:

1. `CHEQ アップロード原本` フォルダを右クリック
2. `共有` を押す
3. 表示されたサービスアカウントのメールアドレスを貼り付ける
4. 権限を `閲覧者` にする
5. `送信` または `共有` を押す

低信頼セルの切り出し画像も Drive に保存したい場合は、別のフォルダを作って同じサービスアカウントに `編集者` 権限で共有し、Cloud Run に `REVIEW_IMAGE_FOLDER_ID` を追加します。

```bash
gcloud run services update "$CHEQ_SERVICE" \
  --region "$CHEQ_REGION" \
  --update-env-vars REVIEW_IMAGE_FOLDER_ID=<レビュー画像フォルダID>
```

### 8-17. Cloud Run を更新するとき

`ocr-api/` のコードを変更したら、同じデプロイコマンドをもう一度実行します。

```bash
cd ocr-api
gcloud run deploy "$CHEQ_SERVICE" \
  --source . \
  --region "$CHEQ_REGION" \
  --service-account "$CHEQ_RUN_SA" \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 1 \
  --allow-unauthenticated \
  --set-secrets RECOGNITION_API_KEY=cheq-recognition-api-key:latest,RECOGNITION_WEBHOOK_SECRET=cheq-recognition-webhook-secret:latest \
  --set-env-vars RECOGNITION_CALLBACK_ALLOWED_HOSTS=script.google.com
```

API キーや Webhook secret を変えた場合は、Apps Script のスクリプトプロパティも同じ値に更新してください。

`REVIEW_IMAGE_FOLDER_ID` を使っている場合は、再デプロイ後に 8-16 の `gcloud run services update` も必要に応じて再実行してください。

### 8-18. Cloud Run で困ったとき

ログを見る:

```bash
gcloud run services logs read "$CHEQ_SERVICE" --region "$CHEQ_REGION" --limit 50
```

サービスの URL をもう一度見る:

```bash
gcloud run services describe "$CHEQ_SERVICE" --region "$CHEQ_REGION" --format 'value(status.url)'
```

実行サービスアカウントを確認する:

```bash
gcloud run services describe "$CHEQ_SERVICE" --region "$CHEQ_REGION" \
  --format 'value(spec.template.spec.serviceAccountName)'
```

よくあるエラー:

| エラー | 原因 |
| --- | --- |
| `Billing account not found` | 請求先がプロジェクトに紐づいていない |
| `Permission denied` | Google Cloud の権限が足りない |
| `iam.serviceAccounts.actAs` のエラー | デプロイする人にサービスアカウントを使う権限がない |
| `API has not been used` | 必要な API が有効になっていない |
| `401 invalid bearer token` | Apps Script と Cloud Run の `RECOGNITION_API_KEY` が違う |
| Drive の `403` / `404` | Drive フォルダをサービスアカウントに共有していない |

## 9. 使い方

1. Web アプリの URL を開く
2. 画面右上の `アクセスコード` に `APP_ACCESS_CODE` を入力する
3. 候補者名、検査日、役割、メモを入力する
4. 採点用紙の画像または PDF を選ぶ
5. 登録する
6. 読み取りが終わるまで待つ
7. `ReviewQueue` に確認が必要なものがあれば修正する
8. 採点確定を押す
9. 結果を確認する

Web 画面にアップロードできるファイル:

- JPEG
- PNG
- HEIC / HEIF
- PDF

アップロードできるファイルサイズは最大 10MB です。

OCR API が標準で自動読み取りできるファイルは、JPEG、PNG、PDF です。HEIC / HEIF は Web 画面への保存はできますが、Cloud Run の OCR API では標準設定のままだと読めません。iPhone の写真が HEIC になる場合は、JPEG に変換してからアップロードしてください。

## 10. 動作確認

### OCR API のテスト

```bash
cd ocr-api
uv sync
uv run pytest
```

### 採点ロジックのテスト

```bash
cd scoring-core
pnpm test
```

### GAS の手動チェック

詳しくは `docs/gas-deployment-checklist.md` を見てください。

最低限、次を確認します。

- Web アプリを開ける
- `APP_ACCESS_CODE` または許可したメールアドレスで操作できる
- 候補者を登録できる
- ファイルをアップロードできる
- 確認待ちを修正できる
- 採点確定できる

### Cloud Run まで含めた確認

OCR API を使う場合は、次の順番で確認します。

1. Web アプリを開く
2. `APP_ACCESS_CODE` を入力する
3. テスト用の候補者を登録し、JPEG、PNG、または PDF の採点用紙をアップロードする
4. `Candidates` シートで候補者の行が増えることを確認する
5. OCR 中はステータスが `PROCESSING` になることを確認する
6. Cloud Run のログを見る

```bash
gcloud run services logs read ocr-api --region asia-northeast1 --limit 50
```

7. `RawCells` シートに `s01` から `s80` の読み取り結果が入ることを確認する
8. 読み取りが怪しいセルがある場合は `ReviewQueue` に入ることを確認する
9. Web 画面またはシートで確認待ちを修正する
10. 採点確定を実行し、`Results` に結果が入ることを確認する

Cloud Run のログに何も出ない場合は、`Config` の `RECOGNITION_ENDPOINT_URL` が空、URL が間違っている、または Apps Script 側で候補者登録に失敗している可能性があります。

## よくあるトラブル

| 困ったこと | 確認すること |
| --- | --- |
| Web アプリが開けない | デプロイ URL が正しいか、アクセス権限があるか確認 |
| `Unauthorized` と出る | 画面右上のアクセスコードが `APP_ACCESS_CODE` と同じか確認。メール認証で使う場合は `AUTHORIZED_USER_EMAILS` または `ADMIN_USER_EMAILS` も確認 |
| アップロードできない | `Config` の `UPLOAD_FOLDER_ID` が入っているか確認 |
| OCR が動かない | `RECOGNITION_ENDPOINT_URL`、`RECOGNITION_API_KEY`、`RECOGNITION_ENDPOINT_HOSTS` を確認 |
| Cloud Run が Drive を読めない | Drive フォルダを Cloud Run のサービスアカウントに共有したか確認 |
| 結果が返ってこない | Webhook secret が Apps Script と Cloud Run で同じか確認 |
| 実物の用紙だけ読めない | 用紙レイアウト調整が必要。`ocr-api/README.md` のキャリブレーション手順を確認 |

## 絶対に公開しないもの

GitHub に公開する前に、次のものが入っていないか確認してください。

- 本物の採点用紙画像
- 候補者の個人情報
- `.env` ファイル
- `gas/.clasp.json`
- API キー
- Webhook secret
- `APP_ACCESS_CODE`
- Google Cloud のサービスアカウント JSON

確認コマンド:

```bash
rg -n "RECOGNITION_API_KEY=|RECOGNITION_WEBHOOK_SECRET=|private_key|client_secret|refresh_token" .
find . -name '.DS_Store' -o -name '.venv' -o -name '__pycache__' -o -name '.pytest_cache' -o -name '*.HEIC'
```

## 開発する人向け

ここはコードを直したい人だけが読めば大丈夫です。利用や導入だけなら飛ばしてください。

### このシステムの3つの部品

| 部品 | 場所 | 言語 | 役割 |
| --- | --- | --- | --- |
| 管理画面・採点処理 | `gas/` | Apps Script (JavaScript) | Web 画面、シート操作、採点の呼び出し |
| 採点ロジック（正本） | `scoring-core/` | JavaScript | 点数・段階・ランク計算。テスト付き |
| OCR（画像読み取り） | `ocr-api/` | Python | 採点用紙の丸印を読む Cloud Run の API |

大事なルール: **採点ロジックの正本は `scoring-core/src/cheqScoring.js` です。** `gas/CheqScoring.gs` はそこから自動生成したコピーなので、直接編集しないでください（直しても次の同期で上書きされます）。

### 開発環境を準備する

このリポジトリでは、JavaScript 系は `pnpm`、Python 系は `uv` だけを使います。`npm`・`yarn`・`pip` は使いません。`pnpm-lock.yaml` と `uv.lock` は勝手に消したり作り直したりしないでください。

Mac で Homebrew が使える場合:

```bash
# JavaScript 用
brew install node
brew install pnpm

# Python 用
brew install uv

# Cloud Run / clasp をコマンドで触る人だけ
brew install --cask google-cloud-sdk   # gcloud
```

入ったか確認します。バージョンの数字が表示されれば OK です。

```bash
node --version
pnpm --version
uv --version
```

### 採点ロジックを直すとき（いちばん多い作業）

「Red（テストを先に書く）→ Green（実装）→ Refactor」の順で進めます。

1. テストを直す／足す: `scoring-core/test/cheqScoring.test.js`
2. 本体を直す: `scoring-core/src/cheqScoring.js`
3. テストを通す

   ```bash
   cd scoring-core
   pnpm test
   ```

4. GAS 配布用ファイルへ同期する（`gas/CheqScoring.gs` が上書きされます）

   ```bash
   ./sync-gas.sh
   ```

5. GAS へ反映する（次の「GAS へ反映するとき」へ）

採点ルールの中身（項目・段階・ランク条件）はコードではなくスプレッドシートの `ItemMaster` / `ScoreBands` / `RankRules` で管理します。ルールを変えるだけならコード変更は不要です。詳しくは `docs/gas-setup.md` を見てください。

### GAS へ反映するとき

方法は2つあります。コードが苦手なら方法 A、慣れているなら方法 B。

**方法 A: 手でコピー&ペースト（簡単・確実）**

「3. Apps Script にファイルを入れる」と同じ要領で、変更したファイルの中身を Apps Script エディタへ貼り直し、`デプロイ` →（既存のデプロイを編集）→ 新しいバージョンとして保存します。

**方法 B: clasp でコマンド反映（速い）**

`clasp` は Apps Script をコマンドで更新する Google 公式ツールです。初回だけログインと設定が必要です。

```bash
cd gas
pnpm dlx @google/clasp login          # 初回のみ。ブラウザで Google ログイン
```

`gas/.clasp.json.example` をコピーして `gas/.clasp.json` を作り、自分の Apps Script プロジェクト ID を書きます。`.clasp.json` は本物の ID を含むので Git に入れません（公開するのは `.clasp.json.example` だけ）。

```bash
cd gas
pnpm dlx @google/clasp push -f                              # ローカルのファイルを Apps Script へ送る
pnpm dlx @google/clasp deploy -i <デプロイID> -d "変更の説明"   # 利用者の URL へ反映する
```

注意:

- `push` だけでは利用者が開く URL（`/exec`）には反映されません。`deploy` まで必ず実行します。
- `<デプロイID>` は、利用者に配っている Web アプリのデプロイ ID です。`-i` を付けず新規 `deploy` にすると URL が変わってしまうので、本番では既存 ID を `-i` で指定して更新します。
- `gas/Code.gs`（旧デモ）は関数名が衝突するため `.claspignore` で送信から除外しています。本番実装は `Code.production.gs` です。

### OCR（画像読み取り）を直すとき

```bash
cd ocr-api
uv sync                 # 依存をそろえる（初回・更新時）
uv run pytest           # テスト
```

手元の画像で読み取りを試す（Google Cloud 認証は不要）:

```bash
uv run python cli.py scoresheet scan.pdf
uv run python cli.py scoresheet scan.jpg --dump-review ./out   # 怪しいセルの切り出し画像も保存
```

実物の用紙で精度が出ないときは、`ocr-api/README.md` の「用紙レイアウトのキャリブレーション」を見てしきい値を調整します。直したら「8-17. Cloud Run を更新するとき」で再デプロイします。

### 開発で守ること（まとめ）

- 採点ロジックを変えたら必ず `pnpm test` → `./sync-gas.sh` → GAS へ反映、の順番。
- `gas/CheqScoring.gs` は同期生成物なので、通常は直接編集しない。
- `ocr-api/.venv/` はローカル生成物なので Git に入れない。
- `gas/.clasp.json` は本物の Apps Script ID を含むので Git に入れない（`gas/.clasp.json.example` だけ公開）。
- さらに詳しい設計は `docs/`（要件・契約・チェックリスト）と `ocr-api/README.md` にあります。これらが現行仕様の正です。

## 用語集

手順の途中でわからない言葉が出たら、ここを見てください。

| 言葉 | 意味 |
| --- | --- |
| GAS / Apps Script | Google が無料で提供するプログラム実行環境。スプレッドシートに付いていて、今回は管理画面と採点処理を動かす |
| スプレッドシート | Google の表計算。今回はデータの保存場所（データベース）として使う |
| スプレッドシート ID | スプレッドシートごとの住所。URL `.../d/【ここ】/edit` の部分 |
| フォルダ ID | Drive フォルダごとの住所。URL `.../folders/【ここ】` の部分 |
| Drive | Google のファイル置き場。採点用紙の画像をここに保存する |
| OCR | 画像から文字や丸印を読み取る技術。今回は採点用紙の○を読む |
| Cloud Run | Google Cloud 上でプログラム（今回は OCR）を動かすサービス |
| Google Cloud | Google の有料クラウド。Cloud Run はこの中の機能 |
| gcloud | Google Cloud をコマンドで操作する道具 |
| 請求先アカウント | Google Cloud の支払い情報。無料枠で使う場合でも登録が必要 |
| プロジェクト（GCP） | Google Cloud の作業のまとまり。今回は OCR 用に1つ作る |
| プロジェクト ID | Google Cloud プロジェクトの住所。例 `cheq-ocr-123456` |
| リージョン | サーバーが動く地域。今回は東京 `asia-northeast1` |
| サービスアカウント | 人ではなくプログラム用の Google アカウント。Cloud Run が Drive を読むのに使う |
| Secret Manager | API キーなどの秘密の値を安全に保管する Google Cloud の金庫 |
| IAM | 「誰が何をしてよいか」を決める権限の仕組み |
| ターミナル | コマンドを打つ黒い画面。Mac は `ユーティリティ` の中にある |
| コマンド | ターミナルに打つ命令文。コピペして Enter で実行できる |
| デプロイ | プログラムを「公開して使える状態にする」こと |
| Web アプリ / Web 画面 | GAS を公開して作る、利用者がブラウザで開く画面 |
| スクリプトプロパティ | GAS に秘密の設定値（パスワードや鍵）を保存する場所 |
| Config シート | 公開しても比較的安全な設定をまとめたスプレッドシートのシート |
| API キー | プログラム同士が「正しい相手だ」と確認するための合言葉 |
| Webhook | あるサービスが別のサービスへ結果を送りつける仕組み。OCR の結果を GAS へ返すのに使う |
| HMAC / 署名 | 送られたデータが本物で改ざんされていないと確認する技術 |
| 信頼度 | OCR が「この読み取りにどれくらい自信があるか」を 0〜1 で表した数 |
| ReviewQueue | 読み取りが怪しく、人の確認が必要なものを集めたシート |
| pnpm | JavaScript の部品（パッケージ）を入れる道具。npm の代わり |
| uv | Python の部品を入れる道具。pip の代わり |
| clasp | GAS のコードをコマンドで反映する Google 公式ツール |
| HEIC / HEIF | iPhone 標準の画像形式。OCR は未対応なので JPEG に変換が必要 |

## ライセンス

MIT License です。詳しくは `LICENSE` を見てください。
