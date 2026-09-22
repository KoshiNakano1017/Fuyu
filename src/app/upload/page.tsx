import { UploadForm } from "@/components/media/UploadForm";
import { requireSignedIn } from "@/lib/auth/guard";
import { MEDIA_PURPOSE_PRESETS } from "@/lib/media/upload-policy";

/**
 * アップロード（画面ID A10 ／ WBS 14-2 アップロード画面）。
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
 */
export default async function UploadPage() {
  await requireSignedIn();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">アップロード</h1>
      <p className="text-sm text-neutral-600">
        写真・動画は<strong>端末からストレージへ直接</strong>送られます（アプリのサーバを経由しません）。
        位置情報つきの写真は、Exif から撮影日時と撮影地が自動で読み取られます。
      </p>
      <UploadForm presets={MEDIA_PURPOSE_PRESETS} />
    </main>
  );
}
