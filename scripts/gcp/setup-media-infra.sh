#!/usr/bin/env bash
#
# メディア基盤（Cloud Storage for Firebase ／ GCS）の作成（WBS 1-4）。
#
# 根拠: v13 §5.11.2（不可侵ルール1〜4）・§5.11.4（ライフサイクル・予算アラート）・§5.11.5、
#       Issue #18 完了条件 A（バケット構成）・C（サービスアカウント）・D（コスト制御）・E（後処理の起動経路）、
#       `システムアーキテクチャ.md`「前線3: Cloud Storage → IAM とバケット設定」
#
# ⚠️ このスクリプトは**オーナーが手元で実行する**。CI からは実行しない
#    （GCP の認証情報を CI へ置かないため／CLAUDE.md §3.2）。
#
# ⚠️ 冪等に書いてある（既に在るものは作らない）。途中で失敗しても、直して再実行してよい。
#
# 使い方:
#   export GCP_PROJECT_ID=fuyuugai-app
#   export GCS_BUCKET_PRIVATE=fuyuugai-media-private
#   bash scripts/gcp/setup-media-infra.sh
#
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID を設定してください}"
BUCKET="${GCS_BUCKET_PRIVATE:?GCS_BUCKET_PRIVATE を設定してください}"
LOCATION="${GCS_LOCATION:-asia-northeast1}"
SIGNER_SA="media-signer"
FINALIZE_SA="media-finalize"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== プロジェクト: ${PROJECT_ID} ／ バケット: ${BUCKET} ／ ロケーション: ${LOCATION}"

# ⚠️ メディア用バケットを line-rag-bot と同じプロジェクトに置くかは未決である
#    （`QUESTIONS.md`「[2026-09-19] メディア用 GCS バケットを `line-rag-bot` と同一 GCP
#    プロジェクトに置くか」／推奨 B＝専用プロジェクト）。本スクリプトは
#    GCP_PROJECT_ID を外から受けるため、どちらに決まっても書き換えずに済む。

# -----------------------------------------------------------------------------
# 1. バケット — 署名付きURL以外の経路を物理的に塞ぐ（v13 §5.11.2 不可侵ルール3）
# -----------------------------------------------------------------------------

if gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "-- バケットは既に在る。設定だけ当て直す"
else
  # --uniform-bucket-level-access: ACL を殺し、権限を IAM ひとつに寄せる
  # --public-access-prevention:    公開アクセスを恒久的に禁止する
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi

# 既存バケットにも必ず当てる（作成済みの手動バケットが緩い設定のままになるのを防ぐ）
gcloud storage buckets update "gs://${BUCKET}" \
  --project "${PROJECT_ID}" \
  --uniform-bucket-level-access \
  --public-access-prevention

# ライフサイクル（v13 §5.11.4）
gcloud storage buckets update "gs://${BUCKET}" \
  --project "${PROJECT_ID}" \
  --lifecycle-file "${SCRIPT_DIR}/media-bucket-lifecycle.json"

# CORS（WBS 14-2 アップロード画面）
#
# ⚠️ **これが無いとブラウザからのアップロードは1件も成功しない。**
#    実体は端末 → ストレージへ直接送られる（v13 §5.11.2 不可侵ルール1）ため、ブラウザは
#    別オリジンへの PUT として preflight を投げる。バケットに CORS が無いと preflight が
#    拒否され、**署名も IAM も正しいのにアップロードだけが失敗する**（画面には
#    「通信に失敗しました」としか出ず、原因が読めない失敗様式になる）。
#
# 許可するオリジンは環境ごとに違う。既定は開発用のローカルだけで、Vercel の URL は
# MEDIA_CORS_ORIGINS へカンマ区切りで渡す。
#   例: export MEDIA_CORS_ORIGINS="http://localhost:3000,https://fuyu.vercel.app"
CORS_ORIGINS="${MEDIA_CORS_ORIGINS:-http://localhost:3000}"
CORS_FILE="$(mktemp)"
sed "s|__ORIGINS__|$(printf '%s' "${CORS_ORIGINS}" | sed 's/,/","/g')|" "${SCRIPT_DIR}/media-bucket-cors.json" > "${CORS_FILE}"
gcloud storage buckets update "gs://${BUCKET}" --project "${PROJECT_ID}" --cors-file "${CORS_FILE}"
rm -f "${CORS_FILE}"
echo "-- CORS 許可オリジン: ${CORS_ORIGINS}"

# -----------------------------------------------------------------------------
# 2. サービスアカウント — 用途ごとに分ける
#
#    Issue #18 完了条件 C:「署名付きURL発行に使うサービスアカウントがメディア用バケット専用であり、
#    監査ログ用バケットへのアクセス権を一切持たない」。
#    そのため **プロジェクト全体のロールを付けず、バケット単位で権限を与える**。
# -----------------------------------------------------------------------------

create_service_account_if_missing() {
  local account_id="$1" display_name="$2"
  if gcloud iam service-accounts describe \
      "${account_id}@${PROJECT_ID}.iam.gserviceaccount.com" \
      --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "-- サービスアカウント ${account_id} は既に在る"
  else
    gcloud iam service-accounts create "${account_id}" \
      --project "${PROJECT_ID}" \
      --display-name "${display_name}"
  fi
}

create_service_account_if_missing "${SIGNER_SA}"   "署名付きURL発行（アプリ層）"
create_service_account_if_missing "${FINALIZE_SA}" "Object Finalize の書き戻し"

# 署名用: オブジェクトの読み書きだけ。バケットの設定を触る権限は与えない。
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --project "${PROJECT_ID}" \
  --member "serviceAccount:${SIGNER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role "roles/storage.objectAdmin"

# 書き戻し用: 実体を読む必要すら無い（メタデータの取得のみ）。最小権限で閲覧者に留める。
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --project "${PROJECT_ID}" \
  --member "serviceAccount:${FINALIZE_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role "roles/storage.objectViewer"

cat <<'NOTE'

-- 署名鍵について
   署名付きURLの発行には media-signer の鍵が要る。鍵は次で作り、**JSON の中身を**
   環境変数 GCP_SERVICE_ACCOUNT_JSON へ入れる（ファイルをリポジトリへ置かない／CLAUDE.md §3.1）。

     gcloud iam service-accounts keys create /tmp/media-signer.json \
       --iam-account "media-signer@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

   Vercel へは Secret 型で入れる（NEXT_PUBLIC_ を付けない／CLAUDE.md §6.3）:

     vercel env add GCP_SERVICE_ACCOUNT_JSON production < /tmp/media-signer.json

   登録したら /tmp の鍵は消すこと。

NOTE

# -----------------------------------------------------------------------------
# 3. 後処理の起動経路（Issue #18 完了条件 E ／ 2026-09-10 決定の A 案）
#
#    GCS Object Finalize → Cloud Tasks → Cloud Functions（本リポジトリの
#    functions/media-object-finalize）。ここで作るのは**経路の疎通まで**であり、
#    サムネイル生成・Exif 抽出・AI タグ付けは WBS 14-1 の担当である。
# -----------------------------------------------------------------------------

QUEUE_NAME="media-finalize"
if gcloud tasks queues describe "${QUEUE_NAME}" \
    --project "${PROJECT_ID}" --location "${LOCATION}" >/dev/null 2>&1; then
  echo "-- Cloud Tasks キューは既に在る"
else
  gcloud tasks queues create "${QUEUE_NAME}" \
    --project "${PROJECT_ID}" --location "${LOCATION}"
fi

cat <<'NOTE'

-- 関数のデプロイ（service_role キーは Secret Manager から渡す）
   --no-allow-unauthenticated が要。IAM で閉じ、Cloud Tasks の OIDC トークンで呼ぶ
   （関数側にアプリ層の共有シークレットを置かない／v13 §5.11.2 不可侵ルール4）。

   <secret_name> は Secret Manager へ登録したシークレットの名前に置き換える
   （例: supabase-service-role-key）。**鍵の値そのものをここへ書かない。**

     gcloud functions deploy media-object-finalize \
       --gen2 --runtime nodejs20 --region "${GCS_LOCATION:-asia-northeast1}" \
       --source functions/media-object-finalize \
       --entry-point mediaObjectFinalize \
       --trigger-http --no-allow-unauthenticated \
       --service-account "media-finalize@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
       --set-env-vars "SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}" \
       --set-secrets "SUPABASE_SERVICE_ROLE_KEY=<secret_name>:latest"

NOTE

# -----------------------------------------------------------------------------
# 4. 予算アラート（v13 §5.11.4 ／ Issue #18 完了条件 D）
#
#    ⚠️ 金額の水準は**未回答**である（`QUESTIONS.md`「[2026-09-19] GCP 月額予算アラートの
#       水準（監査ログの GCS 保管を追加した後の妥当性）」／推奨 A＝月5,000円）。
#       決まるまでは正本 §5.11.4 の例示値をそのまま使う。**遮断ではなく通知**であるため、
#       低めに置いて実績で上げるほうが安全（同論点の推奨理由）。
# -----------------------------------------------------------------------------

BILLING_ACCOUNT="${GCP_BILLING_ACCOUNT:-}"
if [[ -z "${BILLING_ACCOUNT}" ]]; then
  echo "-- GCP_BILLING_ACCOUNT が未設定のため予算アラートは作らない（後で設定すること）"
else
  gcloud billing budgets create \
    --billing-account "${BILLING_ACCOUNT}" \
    --display-name "浮遊街アプリ メディア基盤" \
    --budget-amount "5000JPY" \
    --threshold-rule percent=0.5 \
    --threshold-rule percent=0.9 \
    --threshold-rule percent=1.0
fi

echo "== 完了。.env の GCS_BUCKET_PRIVATE / GCP_PROJECT_ID / GCP_SERVICE_ACCOUNT_JSON を設定すること"
