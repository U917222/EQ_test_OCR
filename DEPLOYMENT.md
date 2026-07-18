# 🚀 デプロイ手順

## クイックスタート

### すべてをデプロイ（推奨）
```bash
./deploy-all.sh
```

### 特定のコンポーネントだけデプロイ
```bash
./deploy-all.sh --skip-scoring-api --skip-ocr-api  # web only
./deploy-all.sh --skip-web --skip-ocr-api          # scoring-api only
./deploy-all.sh --skip-web --skip-scoring-api      # ocr-api only
```

### ドライラン（コマンドを確認してから実行）
```bash
./deploy-all.sh --dry-run
```

---

## R2バケットの初期セットアップ

採点用紙原本と参考資料（履歴書・作文・その他PDF）は、Pages Functionsが `CHEQ_FILES` bindingを通じて直接R2へ保存します。保存先は **bindingの有無だけ** で自動的に決まり（ある場合はR2、無い場合はD1またはD1チャンク）、切り替え用の環境変数やscoring-api側の設定はありません。scoring-apiはPDF生成専用で、ストレージには一切関与しません。

本番のバケットはセットアップ済みです。以下は新しい環境（別アカウント等）を構築する場合にのみ必要な手順です。

### 1. R2を有効化して非公開バケットを作る

1. Cloudflare Dashboardの「R2 Object Storage」でR2を有効化する（支払い方法の登録を求められる場合があります）。
2. Storage classが **Standard** の非公開バケット `cheq-eqtest-files` を作る。公開アクセスやカスタムドメインは設定しない。
3. 確認:

```bash
cd web
pnpm exec wrangler r2 bucket info cheq-eqtest-files
```

`web/wrangler.toml` の `CHEQ_FILES` bindingはこのバケット名を参照します。バケット作成前にPagesをデプロイするとbinding解決で失敗するため、必ず先に作成してください。

### 2. Pagesをデプロイする

```bash
cd web
pnpm test
pnpm build
pnpm run deploy
```

Cloudflare DashboardのPages projectで、ProductionのR2 binding `CHEQ_FILES` が `cheq-eqtest-files` を指していることを確認します。

### 3. スモークテスト

管理画面で小さなテストPDFを1件登録し、次を順に確認します。

1. 登録が成功し、候補者の `sourceUrl` が `/files/r2/` で始まる。
2. ログイン中の管理画面から原本を開ける。
3. 未認証ブラウザでは原本を開けない。
4. 候補者を削除すると、R2 Dashboardから該当 `candidates/<candidateId>/...` objectも消える。
5. 候補者詳細の「参考資料」でPDFを追加し、一覧・プレビュー・削除ができる。
6. 参考資料の追加前後で候補者の採点ステータスが変わらない。

### R2を使わない場合

`web/wrangler.toml` の `[[r2_buckets]]` ブロックを削除して再デプロイすると、保存先はD1（またはD1チャンク）に切り替わります。既存のR2オブジェクトは削除されないため、参照状況を確認するまで手動で消さないでください。

## 各コンポーネント別デプロイ

### Web（Cloudflare Pages + Functions）
変更ファイル: `web/**` (TypeScript, React, D1 functions)

```bash
cd web && pnpm run deploy
```

**注意**:
- `--branch main` が本番。省略すると Preview に入るだけで本番は変わりません。
- 行末のコメントは禁止。zsh が `# メモ` を引数として解釈します。

### scoring-api（Cloud Run / PDF生成）
変更ファイル: `scoring-api/**` (Python, FastAPI, PDF render)

```bash
make -C scoring-api deploy
```

または

```bash
cd scoring-api && gcloud run deploy scoring-api --source . --region asia-northeast1
```

### ocr-api（Cloud Run / 数字認識）
変更ファイル: `ocr-api/**` (Python, FastAPI, digit recognition)

```bash
make -C ocr-api deploy
```

または

```bash
cd ocr-api && gcloud run deploy ocr-api --source . --region asia-northeast1
```

---

## D1 マイグレーション（スキーマ変更時のみ）

### 新しいマイグレーション作成
本番で新しいカラム・テーブルが必要になったとき:

```bash
cd web
wrangler d1 migrations create CHEQ_DB <migration_name>
```

→ `web/migrations/0010_<name>.sql` が生成されます。

### ローカルで検証
```bash
cd web
wrangler d1 migrations list CHEQ_DB --local
```

### 本番に適用（未実行分のみ）
```bash
cd web
wrangler d1 migrations apply CHEQ_DB --remote
```

**注意**:
- 現在、本番 D1 には `0001_initial.sql` ～ `0009_candidate_address.sql` が適用済み。
- 新しいマイグレーション（0010 以降）のみ未実行として扱われます。
- `INSERT OR REPLACE` / `INSERT OR IGNORE` を使い、冪等性を保つこと（重複実行しても安全）。

---

## ワークフロー例

### 新機能を追加した場合
```bash
git add .
git commit -m "feat: add xyz feature"
./deploy-all.sh
git push origin main
```

### 特定の API だけ修正した場合
```bash
git add scoring-api/
git commit -m "fix: pdf generation bug"
make -C scoring-api deploy
git push origin main
```

### D1 スキーマを拡張した場合
```bash
cd web
wrangler d1 migrations create CHEQ_DB add_new_column
# ↑ migrations/0010_add_new_column.sql を編集
cd web && wrangler d1 migrations apply CHEQ_DB --remote
git add web/migrations/0010_add_new_column.sql
git commit -m "chore(db): add new_column to candidates table"
cd web && pnpm run deploy  # functions で新カラムを使用する場合
git push origin main
```

---

## トラブルシューティング

### Pages デプロイが Preview に入る
`--branch main` を付け忘れています。`pnpm run deploy` はこれを自動付与するので、必ず `pnpm run deploy` を使用してください。

### gcloud コマンドが見つからない
GCP SDK をインストールし、認証してください:
```bash
gcloud auth application-default login
```

### Cloud Run デプロイで Permission denied
デプロイ権限（Compute Engine → Service Account の権限）を確認してください。

### D1 マイグレーションが適用されない
実行済みマイグレーション一覧を確認（`wrangler d1 migrations list` でも同等の情報が見られます）:
```bash
wrangler d1 execute CHEQ_DB --remote --command "SELECT name, applied_at FROM d1_migrations ORDER BY name;"
```

---

## 秘密値管理

PDF生成を使用する場合、Pagesとscoring-apiには同じ `PDF_RENDER_KEY` を設定し、Pagesに `PDF_RENDER_URL` を設定します。

### 新しい秘密値を追加
```bash
# Cloud Run 側
gcloud run deploy <service> --update-env-vars KEY=value --region asia-northeast1

# Pages 側（分類器がブロック → ユーザー実行）
wrangler pages secret put KEY
```

PagesとCloud Runで共有する鍵は、必要な組み合わせで同じ値を設定してください。

---

## デプロイ確認

各デプロイ後、本番環境で動作確認:

1. **Web**: https://cheq-eqtest.pages.dev（ダッシュボード・候補者一覧が高速＆D1表示）
2. **scoring-api**: `curl https://scoring-api-170627264528.asia-northeast1.run.app/readyz` → 200 OK
3. **ocr-api**: `curl https://ocr-api-170627264528.asia-northeast1.run.app/readyz` または `/healthz` → 200 OK

実際のURLは `gcloud run services list --region asia-northeast1 --format="table(SERVICE,URL)"` でも確認できます。

---

## ロールバック

万が一問題が発生した場合:

```bash
git revert HEAD  # 問題のコミットを巻き戻す
./deploy-all.sh  # 直前の状態を再デプロイ
git push origin main
```

または、git履歴から特定の状態に戻す:
```bash
git reset --hard <commit-hash>
git push --force-with-lease origin main
./deploy-all.sh
```
