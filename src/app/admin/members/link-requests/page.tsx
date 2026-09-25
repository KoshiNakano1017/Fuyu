import Link from "next/link";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { LinkRequestQueue } from "@/components/members/LinkRequestQueue";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { fetchLinkRequests } from "@/lib/members/link-queue-store";
import { matchKindLabel, type MatchKind } from "@/lib/members/matching";

import { approveLinkRequestAction, rejectLinkRequestAction } from "./actions";

/**
 * 名寄せ 運営承認キュー（WBS 10-2 ／ v13 §5.8.3 ①）。
 *
 * ## ★ この画面は照合キー（PII-A）を出す
 *
 * どのメール・電話で一致したのかが分からないと運営は判断できない。
 * したがって **staff 限定**（`member_identifiers`（`0025`）と同じ幅）であり、
 * `0039` の RLS も同じ条件で行を絞っている（一般会員には1行も返らない）。
 *
 * ## 候補は毎回引き直す
 *
 * キューへ積んだ時点の候補は保存していない。その間に結合された会員・本登録済みになった会員が
 * 混ざるため、**運営が見るのは常に「いまの候補」**である（`fetchLinkRequests()`）。
 *
 * ## ナビへタブを足さない
 *
 * §5.9.5（管理者に12タブを平置きしない）に従い、到達経路は管理ダッシュボードからのリンクにする
 * （`/admin/customers`・`/admin/membership` と同じ扱い）。
 */
export default async function LinkRequestsPage() {
  try {
    await requireStaff();
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return (
        <AccessDenied
          currentRole={error.denial.currentRole}
          requiredRoleLabel={error.denial.requiredRoleLabel}
        />
      );
    }
    throw error;
  }

  const requests = await fetchLinkRequests();
  const kinds: MatchKind[] = ["email", "phone", "line", "discord"];
  const kindLabels = Object.fromEntries(kinds.map((kind) => [kind, matchKindLabel(kind)]));

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Link href="/admin" className="text-sm underline">
        ← 管理ダッシュボードへ戻る
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">名寄せ 運営承認キュー</h1>
        <p className="text-sm text-neutral-600">
          事前登録の会員データと、ログインした利用者を突き合わせた結果です。
          <strong>候補が複数見つかった場合は自動で連携せず、ここへ回ります</strong>
          （同姓同名・家族間での連絡先共有があるため）。
        </p>
        <p className="text-xs text-red-800">
          ⚠️ 連携を承認すると、その会員の<strong>宿泊券・Uii残高・XP・街人ステータスが引き継がれます</strong>。
          本人であることを確認してから承認してください（判断の根拠は監査ログに残ります）。
        </p>
      </div>

      <LinkRequestQueue
        requests={requests}
        kindLabels={kindLabels}
        approve={approveLinkRequestAction}
        reject={rejectLinkRequestAction}
      />
    </main>
  );
}
