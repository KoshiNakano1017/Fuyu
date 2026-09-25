import { MediaModerationList, type ModerationEntry } from "@/components/media/MediaModerationList";
import { UploadForm } from "@/components/media/UploadForm";
import { requireSignedIn } from "@/lib/auth/guard";
import { isStaff } from "@/lib/auth/session";
import { listModerationOffers } from "@/lib/media/moderation";
import { fetchRecentMedia, type MediaAsset } from "@/lib/media/store";
import { MEDIA_PURPOSE_PRESETS } from "@/lib/media/upload-policy";

import { moderateMediaAction } from "./actions";

/**
 * アップロード（画面ID A10 ／ WBS 14-2 アップロード画面 ＋ 14-3 メディアの運営措置）。
 *
 * 保存先（署名付きURL＝`POST /api/media/signed-upload-url`）と台帳（`media_assets` ／
 * `0027`）は PR #119 で入っており、本画面はその上の操作面である。
 *
 * ## 対象はゲストを含む全員（v13 §5.11.7 ①）
 *
 * ロールで分岐しない。ログインだけを要求するのは、投稿が必ず誰かの名義になるためで、
 * 名義の固定は RLS（`media_assets_insert_self`）が行う。
 *
 * ## 用途タグのプリセットはサーバから渡す
 *
 * `MEDIA_PURPOSE_PRESETS` は許可リストではない（タグ語彙はフォークソノミー／v13 §5.11.3）。
 * 画面の既定の選択肢としてだけ使い、自由入力も同じ列へ入る。
 *
 * ## 運営措置を同じ画面に置く（WBS 14-3）
 *
 * v13 §5.11.7 の警告は「公開機能だけを出さないこと」を求めている。**アップロードを
 * 全ロールへ開いた以上、不適切な投稿を止める操作が同時に無ければならない。**
 * メディアライブラリ画面（`14-5`）は Phase 2 なので、それを待たずにここへ置く。
 *
 * 一覧に何件出るかは**RLS が決める**（運営は全件、それ以外は自分の投稿＋公開分）。
 * ここでロールを見て条件を足さない（境界が2箇所に分かれるため）。
 */
export default async function UploadPage() {
  const viewer = await requireSignedIn();
  const assets = await fetchRecentMedia();
  const canModerateOthers = isStaff(viewer.role);

  const entries = assets.map((asset) =>
    toModerationEntry(asset, { memberId: viewer.memberId, role: viewer.role }),
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">アップロード</h1>
      <p className="text-sm text-neutral-600">
        写真・動画は<strong>端末からストレージへ直接</strong>送られます（アプリのサーバを経由しません）。
        位置情報つきの写真は、Exif から撮影日時と撮影地が自動で読み取られます。
      </p>

      {/*
        v13 §5.11.7 の警告2点目。全ロールへ開いた以上、注意書きは画面に出す。
        「同意を得ること」を送信ボタンの近くではなく冒頭に置くのは、
        撮影・選択を始める前に読まれてはじめて意味があるため。
      */}
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>他の人が写っている写真・動画は、本人の同意を得てから投稿してください。</strong>
        投稿は既定で「公開」になります。公開したくないものは、投稿後に公開範囲を「運営のみ」へ
        変更するか取り下げてください。不適切な投稿は運営が非表示化・削除することがあります。
      </p>

      <UploadForm presets={MEDIA_PURPOSE_PRESETS} />

      <MediaModerationList
        entries={entries}
        moderate={moderateMediaAction}
        canModerateOthers={canModerateOthers}
      />
    </main>
  );
}

/**
 * 1件ぶんの「出せる操作」をサーバ側で決める。
 *
 * ★ 画面へ渡すのは**判定の結果だけ**である（ロールは渡さない）。クライアント側で
 * 判定すると利用者の手元で書き換えられるため、`listModerationOffers()` をここで回す。
 * 理由の要否も同じ関数から取るので、画面とサーバで条件がずれない。
 */
function toModerationEntry(
  asset: MediaAsset,
  viewer: { memberId: string; role: Parameters<typeof isStaff>[0] },
): ModerationEntry {
  const isOwnPost = asset.memberId === viewer.memberId;
  const offers = listModerationOffers({
    actorRole: viewer.role,
    isOwnPost,
    currentVisibility: asset.visibility,
    isDeleted: asset.isDeleted,
  });

  return {
    mediaId: asset.mediaId,
    uploaderLabel: asset.uploaderLabel,
    isOwnPost,
    mediaType: asset.mediaType,
    purposeTags: asset.purposeTags,
    visibility: asset.visibility,
    isDeleted: asset.isDeleted,
    createdAt: asset.createdAt,
    offers,
  };
}
