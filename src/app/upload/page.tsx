import { NotYetAvailable } from "@/components/ui/NotYetAvailable";
import { requireSignedIn } from "@/lib/auth/guard";

/**
 * アップロード（画面ID A10 ／ WBS 14-2 アップロード画面（A10））。
 *
 * ⚠️ **まだ作れない。** 保存先（署名付きURL発行）と台帳（`media_assets`）は
 * 2026-09-22（PR #119）で実装済み——`POST /api/media/signed-upload-url` と
 * `supabase/migrations/0027_media_assets.sql`。**残っているのはこの画面自体**
 * （ファイル選択／撮影・用途タグ入力・進捗表示・失敗分のみ再試行）の実装のみ（WBS 14-2）。
 *
 * 入力欄だけ先に置かない。バックエンドは動くが、進捗表示・失敗時の再試行・
 * Exifからの撮影日時／位置の自動取得（v13 §5.11.7）を実装しないまま入力欄だけ
 * 出すと、利用者は「アップロードした」と思っても実際の挙動を保証できない。
 *
 * 対象ロールはゲストを含む全員（v13 §5.9.1）。ログインだけは要求する。
 */
export default async function UploadPage() {
  await requireSignedIn();

  return (
    <NotYetAvailable
      title="アップロード"
      blockedBy={[
        "WBS 14-2（アップロード画面） — 保存先（署名付きURL・PR #119）と台帳（media_assets）は用意済みですが、画面自体（ファイル選択／撮影・用途タグ入力・進捗表示）が未着手です",
      ]}
    />
  );
}
