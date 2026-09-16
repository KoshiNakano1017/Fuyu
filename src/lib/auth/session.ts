import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * 認可の唯一の根拠となるロール（v13 §2 の5値）。
 *
 * ⚠️ `member_type`（親方／街人（コア）／街人（一般）／ゲスト）は**立場**であって
 * 権限ではない。認可に使ってはならない（v13 §2・CLAUDE.md §4.1）。
 */
export type Role = "admin" | "core_member" | "member" | "guest" | "custom";

export type Viewer =
  | { signedIn: false }
  | { signedIn: true; memberId: string; role: Role; accountStatus: string };

/** 運営（管理者・コアメンバー）か。`DB物理設計.md` §6-2① の `is_staff()` と同じ定義。 */
export function isStaff(role: Role): boolean {
  return role === "admin" || role === "core_member";
}

export function isAdmin(role: Role): boolean {
  return role === "admin";
}

/**
 * いまのリクエストの利用者を返す。**認可判定はこれを根拠に行う。**
 *
 * ## なぜ毎回 DB から `role` を読むのか
 *
 * v13 §8 が「**認可の判定は `members.role` のみを根拠とし、JWT へ焼き込んだ
 * ロールを判定に使わない**」と定めているため。JWT に焼き込むと、
 * 運営が `core_member` → `member` へ降格しても、**そのセッションの有効期限が切れるまで
 * 権限が下がらない**。降格は事故対応で行われることがあるので、即時に効く必要がある。
 *
 * 毎リクエストで1クエリ増えるが、これは仕様が要求している代償である。
 *
 * ## `getUser()` を使う理由
 *
 * `getSession()` は Cookie の中身をそのまま返すため、サーバ側では信用できない
 * （Supabase の Next.js ガイドが明示）。`getUser()` は Auth サーバへ問い合わせて
 * トークンを検証する。**認証（誰か）はここで確定させ、認可（何ができるか）は
 * `members.role` で決める。** この2つを混ぜない。
 */
export async function readViewer(): Promise<Viewer> {
  const supabase = await createServerSupabaseClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return { signedIn: false };
  }

  // RLS 越しに自分の行を読む。結合済み（auth_user_id が入っている）なら本人ポリシーで引ける。
  const { data, error } = await supabase
    .from("members")
    .select("member_id, role, account_status")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();

  if (error || !data) {
    // Auth には通ったが members へ結合されていない。
    // 権限は与えない（安全側）。呼び出し側はログインへ戻す。
    return { signedIn: false };
  }

  return {
    signedIn: true,
    memberId: data.member_id as string,
    role: data.role as Role,
    accountStatus: data.account_status as string,
  };
}
