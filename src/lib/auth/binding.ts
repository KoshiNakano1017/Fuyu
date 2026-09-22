import { findUsableInvitation } from "@/lib/auth/invitations";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/**
 * システム操作者の `member_id`。`supabase/migrations/0004_login_binding_and_invitations.sql`
 * が同じ値で1行だけ作る。**人ではない**（ログインの入口を持たない）。
 *
 * 固定値にしているのは、アプリ側が起動時に検索せず参照できるようにするため。
 * 検索にすると「見つからなければ作る」経路が要り、そこが新しい穴になる。
 */
export const SYSTEM_OPERATOR_MEMBER_ID = "00000000-0000-0000-0000-000000000001";

export type BindResult =
  | { ok: true; memberId: string; alreadyBound: boolean }
  | { ok: false; reason: "no_member_for_email" | "already_bound_to_other" | "failed" };

/**
 * 初回ログインを通った `auth.users` の行を、`members` の行へ結合する。
 *
 * ## なぜ service_role が要るのか
 *
 * 結合**前**の本人は `members.auth_user_id` が NULL なので、`auth.uid()` から
 * 自分の行を引けない。つまり本人ポリシーが成立せず、RLS 越しには自分の行を
 * 更新できない。鶏と卵の関係にある。
 *
 * ## なぜ `app.operator_id` にシステム操作者を申告するのか
 *
 * `0003_members_guard_triggers.sql` のガードは、権限列（`auth_user_id` /
 * `account_status` ほか）の変更に対して次を課している。
 *
 *   - 操作者を特定できなければ拒否（`operator_id IS NULL`）
 *   - 操作者 = 対象本人なら `auth_user_id` の変更を拒否（②）
 *   - 操作者 = 対象本人なら `pre_registered → active` を拒否（③）
 *
 * したがって本人を操作者として申告することはできない。**システム操作者**
 * （対象本人とは別の member）を申告することで、②③の自己変更制限に当たらずに通る。
 *
 * ガードトリガー自体は**改訂していない**。DB物理設計 §6-6b が
 * 「service_role は RLS も GRANT も迂回するため、必ず発火する関門はトリガーだけ」
 * としており、そこに「本人なら通る」という穴を開けたくないためである。
 *
 * ## 冪等性
 *
 * 既に結合済み（`auth_user_id` が一致）なら何もせず成功を返す。
 * 毎回のログインで呼ばれても安全でなければならない。
 */
export async function bindAuthUserToMember(
  authUserId: string,
  email: string,
): Promise<BindResult> {
  const admin = createAdminSupabaseClient();

  // ── 1. すでに結合済みか ────────────────────────────────────
  const bound = await admin
    .from("members")
    .select("member_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (bound.data?.member_id) {
    return { ok: true, memberId: bound.data.member_id as string, alreadyBound: true };
  }

  // ── 2. メールアドレスから会員を引く ─────────────────────────
  //   `member_identifiers`（メール・電話の分離テーブル）は WBS 2-1 の範囲外で
  //   まだ存在しない。現時点で辿れるのは `auth.users.email` → 招待台帳のみ。
  //   招待（経路B）で送った宛先と突き合わせる（v13 §5.2.6 経路B 手順4
  //   「**招待台帳の宛先と一致することを確認したうえで**結合する」）。
  //
  //   照会は `findUsableInvitation()` に集約してある。コード方式化（WBS `2-1d`）で
  //   **ログインのコード送信側も同じ判定を要する**ようになり、条件（未消費・期限内・最新）を
  //   2箇所へ書くと片方だけ緩む事故が起きるため。
  const invitation = await findUsableInvitation(admin, email);

  const memberId = invitation?.memberId;
  if (!memberId) {
    // 招待が無い／期限切れ／消費済み。**ここで会員を新規作成してはならない。**
    // 作ると、誰でもメールアドレスさえあれば会員になれてしまう。
    return { ok: false, reason: "no_member_for_email" };
  }

  // ── 3. 対象会員が既に他の Auth ユーザーへ結合されていないか ──
  const target = await admin
    .from("members")
    .select("member_id, auth_user_id, account_status")
    .eq("member_id", memberId)
    .maybeSingle();

  if (!target.data) {
    return { ok: false, reason: "no_member_for_email" };
  }
  if (target.data.auth_user_id && target.data.auth_user_id !== authUserId) {
    // 0003 のガード②も同じことを拒否するが、ここで先に落として
    // 意味のあるエラーを返す（ガードに任せると SQLSTATE しか分からない）。
    return { ok: false, reason: "already_bound_to_other" };
  }

  // ── 4. 結合する（システム操作者を申告してガードを通す）──────
  const applied = await admin.rpc("bind_member_auth_user", {
    p_member_id: memberId,
    p_auth_user_id: authUserId,
    p_operator_id: SYSTEM_OPERATOR_MEMBER_ID,
  });

  if (applied.error) {
    return { ok: false, reason: "failed" };
  }

  // ── 5. 招待を消費済みにする（監査のため。誤送信の追跡に使う）──
  if (invitation?.invitationId) {
    await admin
      .from("member_invitations")
      .update({ consumed_at: new Date().toISOString() })
      .eq("invitation_id", invitation.invitationId);
  }

  return { ok: true, memberId, alreadyBound: false };
}
