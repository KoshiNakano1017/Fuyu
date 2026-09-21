import { NotYetAvailable } from "@/components/ui/NotYetAvailable";
import { requireSignedIn } from "@/lib/auth/guard";

/**
 * アップロード（画面ID A10 ／ WBS 14-2 アップロード画面（A10））。
 *
 * ⚠️ **まだ作れない。** 保存先と台帳の両方が揃っていない。
 *
 * - WBS 1-4（Cloud Storage for Firebase設定・署名付きURL基盤）が未着手のため、
 *   ファイルの置き場所と署名付きURLの発行経路が無い
 * - WBS 2-1c（`media_assets` のスキーマ ＋ RLS）が未着手のため、
 *   アップロードした資産を記録する台帳が無い（`0018_menu_items.sql` の
 *   `image_media_id` も FK を張れずにいる）
 *
 * 入力欄だけ先に置かない。送信先が無いまま選ばせると、
 * 利用者は「アップロードした」と思い込み、実際には何も残らない。
 *
 * 対象ロールはゲストを含む全員（v13 §5.9.1）。ログインだけは要求する。
 */
export default async function UploadPage() {
  await requireSignedIn();

  return (
    <NotYetAvailable
      title="アップロード"
      blockedBy={[
        "WBS 1-4（Cloud Storage for Firebase設定・署名付きURL基盤） — 保存先と署名付きURLの発行経路が未整備です",
        "WBS 2-1c（media_assets のスキーマ ＋ RLS） — アップロードした資産を記録する台帳が未作成です",
      ]}
    />
  );
}
