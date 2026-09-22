/**
 * Object Finalize 起点の書き戻し（WBS 1-4 ／ v13 §5.11.2 ③④）。
 *
 * ## このファイルの範囲は「経路が通ること」だけである
 *
 * Issue #18 の ⚠️1 で、Cloud Functions をどこまで `1-4` に含めるかが
 * **A（経路の疎通まで。実処理は `14-1` へ送る）** と整理されている。それに従い、
 * ここでは **`media_assets` を `pending` → `stored` にするだけ**を行う。
 *
 * ここに置かないもの（すべて WBS 14-1「メディアアップロード基盤」の担当）:
 *   - サムネイル生成・WebP / MP4 変換・トランスコード
 *   - Exif（撮影日時・GPS）抽出
 *   - AI タグ付け（Claude／§5.11.3。Phase 2 で有効化）
 *
 * ## なぜ書き戻しだけでも先に要るのか
 *
 * v13 §5.11.2 note のとおり、アップロード完了は**クライアントの完了通知ではなく
 * Object Finalize を起点**にする。DB 側に「実体が着いた」を記録する手段が無いと、
 * `pending` の行と実体の対応が永久に付かず、孤児ファイル検出（同 note）も、
 * 閲覧URLの発行可否（実体が無いのに URL を配る）も判断できない。
 *
 * ## 起動経路（2026-09-10 決定 ／ `システムアーキテクチャ.md`「非同期ジョブ一覧と実行基盤」①）
 *
 *   GCS Object Finalize → Cloud Tasks → 本関数（HTTP）
 *
 * v13 §5.11.2 の図は GCS → Cloud Functions 直結だが、上記決定で Cloud Tasks が1つ挟まった。
 * 本関数は**どちらの経路からでも同じ JSON を受け取れる**よう、GCS のオブジェクト
 * メタデータ（`name` / `bucket` / `size`）の形をそのまま入力として扱う。
 *
 * ## 認可
 *
 * `--no-allow-unauthenticated` でデプロイし、Cloud Tasks の OIDC トークンで呼ぶ
 * （`scripts/gcp/setup-media-infra.sh`）。**アプリ層の共有シークレットは置かない。**
 * 置くと「IAM で閉じているつもりの経路に、実はもう1本の合鍵がある」状態になり、
 * 鍵の管理先が増える（v13 §5.11.2 不可侵ルール4：認可の所在を増やさない）。
 *
 * ⚠️ Supabase への書き戻しには service_role キーを使う（v13 §5.11.2 トレードオフ）。
 *    Secret Manager で管理し、**本関数にだけ**参照権を与えること。
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * GCS のオブジェクトメタデータから、`media_assets` へ書き戻す値を作る。
 *
 * `storage_path` はバケット名を含まないオブジェクト名である（`0021_media_assets.sql` の注記）。
 * GCS の `name` がまさにその形なので、そのまま突き合わせる。
 */
export function buildStoredPatch(objectMetadata) {
  const sizeBytes = Number(objectMetadata.size);

  return {
    storagePath: objectMetadata.name,
    patch: {
      upload_state: "stored",
      stored_at: objectMetadata.timeCreated ?? new Date().toISOString(),
      // 実体のサイズは**ここで初めて確定する**（署名発行時は未確定のため NULL だった）。
      file_size_bytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null,
      updated_at: new Date().toISOString(),
    },
  };
}

/**
 * Cloud Functions（HTTP トリガ）のエントリポイント。
 *
 * ⚠️ ログにオブジェクト名より詳しいものを出さない。署名付きURL・位置情報は
 *    ログへ残さない（v13 §5.11.2 トレードオフ ／ CLAUDE.md §3.2）。
 */
export async function mediaObjectFinalize(request, response) {
  if (request.method !== "POST") {
    response.status(405).send("POST のみ受け付ける");
    return;
  }

  const objectMetadata = request.body;
  if (!objectMetadata || typeof objectMetadata.name !== "string") {
    response.status(400).send("オブジェクト名が無い");
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // 設定漏れは再試行しても直らない。Cloud Tasks に無限再試行させないため 500 ではなく落とす。
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定");
    response.status(500).send("設定が不足している");
    return;
  }

  const { storagePath, patch } = buildStoredPatch(objectMetadata);

  // PostgREST を直接叩く。SDK を入れないのは、この関数が行う操作が
  // 「1行を UPDATE する」だけであり、依存を足すほどの内容が無いため。
  const endpoint =
    `${SUPABASE_URL}/rest/v1/media_assets` +
    `?storage_path=eq.${encodeURIComponent(storagePath)}&upload_state=eq.pending`;

  const result = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!result.ok) {
    // 再試行で直る可能性があるため 5xx を返し、Cloud Tasks の再試行に任せる。
    console.error(`書き戻しに失敗した: ${result.status}`);
    response.status(502).send("書き戻しに失敗した");
    return;
  }

  const updatedRows = await result.json();
  if (Array.isArray(updatedRows) && updatedRows.length === 0) {
    // 署名付きURLを経ずに置かれた実体、または既に stored 済み。
    // **再試行しても状況は変わらない**ため 200 で終える（孤児の掃除は定期ジョブの担当）。
    console.warn(`対応する pending 行が無い: ${storagePath}`);
  }

  response.status(200).send("ok");
}
