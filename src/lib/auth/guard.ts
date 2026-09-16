import { redirect } from "next/navigation";

import { isAdmin, isStaff, readViewer, type Role, type Viewer } from "./session";

/** 認可に失敗した理由。アクセス制限画面（v13 §5.9.4）の表示に使う。 */
export type DenialReason = {
  currentRole: Role | null;
  requiredRoleLabel: string;
};

export class AccessDeniedError extends Error {
  constructor(readonly denial: DenialReason) {
    super("アクセス権限がありません");
    this.name = "AccessDeniedError";
  }
}

/**
 * ログイン済みであることを要求する。未ログインならログイン画面へ送る。
 *
 * **戻り値を受け取った後の分岐でコンテンツを出し分けない。** この関数が返った
 * 時点で「ログイン済み」は確定しているので、呼び出し側は素直に描画してよい。
 */
export async function requireSignedIn(): Promise<Extract<Viewer, { signedIn: true }>> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    redirect("/login");
  }
  return viewer;
}

/**
 * 運営（`admin` / `core_member`）であることを要求する。
 *
 * ## フラッシュが起きない理由（v13 §5.9.2）
 *
 * これは **Server Component から呼ぶ**。判定が終わるまでページの本体は
 * レンダリングされないので、権限外の利用者に中身が一瞬見えることがない。
 * クライアント側で `useEffect` を使って隠す実装だと、
 * **最初の描画で中身が出てから消える**。それを避けるための配置である。
 *
 * ## `member_type` を見ない理由
 *
 * v13 §2 が「`member_type` は立場であって権限ではない」と定めている。
 * 親方（`member_type = '親方'`）であっても `role = 'member'` なら運営ではない。
 */
export async function requireStaff(): Promise<Extract<Viewer, { signedIn: true }>> {
  const viewer = await requireSignedIn();
  if (!isStaff(viewer.role)) {
    throw new AccessDeniedError({
      currentRole: viewer.role,
      requiredRoleLabel: "管理者 または コアメンバー",
    });
  }
  return viewer;
}

export async function requireAdmin(): Promise<Extract<Viewer, { signedIn: true }>> {
  const viewer = await requireSignedIn();
  if (!isAdmin(viewer.role)) {
    throw new AccessDeniedError({
      currentRole: viewer.role,
      requiredRoleLabel: "管理者",
    });
  }
  return viewer;
}

/**
 * Server Action / Route Handler 用の運営判定。
 *
 * **画面を経由せず直接呼ばれても拒否する**ことが目的（v13 §5.9.3 の二重防御）。
 * `requireStaff()` は `redirect()` を使うためレスポンスを返す経路と相性が悪い。
 * こちらは例外ではなく真偽値で返し、呼び出し側が適切なステータスを返せるようにする。
 */
export async function viewerIsStaff(): Promise<boolean> {
  const viewer = await readViewer();
  return viewer.signedIn && isStaff(viewer.role);
}
