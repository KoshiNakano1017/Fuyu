/**
 * GCS Object Finalize（Eventarc）→ Cloud Tasks への中継（WBS 14-1 ／ v13 §5.11.2 ③④）。
 *
 * ## なぜこの中継が要るのか
 *
 * `システムアーキテクチャ.md`「非同期ジョブ一覧と実行基盤」①・`functions/media-object-finalize`
 * の docstring が定める起動経路は
 *
 *   GCS Object Finalize → Cloud Tasks → media-object-finalize（HTTP）
 *
 * であり、GCS から `media-object-finalize` を**直接**叩く2段構成ではない
 * （Eventarc の GCS トリガーは直接 Cloud Run/Functions を叩くこともできるが、
 * 2026-09-10 決定はあえて Cloud Tasks を1段挟んでいる。理由はレート制限・
 * 再試行ポリシーを Cloud Tasks 側で一元管理するため）。
 *
 * 本関数はその「挟む1段」を実装する。**やることは Cloud Tasks へ1件積むだけ**であり、
 * `media_assets` の書き戻しには一切触れない（それは `media-object-finalize` の責務）。
 *
 * ## 認可
 *
 * 本関数自体は Eventarc（GCS の Object Finalize イベント）からのみ呼ばれ、
 * `--no-allow-unauthenticated` でデプロイする。Cloud Tasks へ積むタスクには
 * OIDC トークンを載せ、`media-object-finalize` 側の `--no-allow-unauthenticated`
 * をそのまま維持する（v13 §5.11.2 不可侵ルール4）。
 */

import { CloudTasksClient } from "@google-cloud/tasks";

const tasksClient = new CloudTasksClient();

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCS_LOCATION = process.env.GCS_LOCATION ?? "asia-northeast1";
const QUEUE_NAME = process.env.MEDIA_FINALIZE_QUEUE ?? "media-finalize";
const TARGET_URL = process.env.MEDIA_FINALIZE_URL;
const INVOKER_SERVICE_ACCOUNT = process.env.MEDIA_FINALIZE_INVOKER_SA;

/**
 * Eventarc（CloudEvents）トリガのエントリポイント。
 *
 * `cloudEvent.data` は GCS オブジェクトリソース（`name` / `bucket` / `size` /
 * `timeCreated` 等）であり、`media-object-finalize` が期待する形とそのまま一致する
 * （GCS の Object Finalize 通知の形式。`functions/media-object-finalize` の docstring 参照）。
 *
 * ⚠️ ログにオブジェクト名より詳しいものを出さない（v13 §5.11.2 トレードオフ ／ CLAUDE.md §3.2）。
 */
export async function enqueueMediaObjectFinalize(cloudEvent) {
  const objectMetadata = cloudEvent.data;

  if (!objectMetadata || typeof objectMetadata.name !== "string") {
    // 設定ミスでもイベント形式の異常でもない限り起きない。再試行しても直らないため
    // 例外を投げず終える（Eventarc の再配送ループを避ける）。
    console.error("イベントに GCS オブジェクト名が無い。無視する");
    return;
  }

  if (!GCP_PROJECT_ID || !TARGET_URL || !INVOKER_SERVICE_ACCOUNT) {
    // 設定漏れは再試行しても直らない。例外を投げて Eventarc 側にリトライさせず、
    // ログで気づけるようにする（`media-object-finalize` と同じ考え方）。
    throw new Error("GCP_PROJECT_ID / MEDIA_FINALIZE_URL / MEDIA_FINALIZE_INVOKER_SA が未設定");
  }

  const parent = tasksClient.queuePath(GCP_PROJECT_ID, GCS_LOCATION, QUEUE_NAME);

  await tasksClient.createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: TARGET_URL,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(objectMetadata)).toString("base64"),
        oidcToken: {
          serviceAccountEmail: INVOKER_SERVICE_ACCOUNT,
          audience: TARGET_URL,
        },
      },
    },
  });
}
