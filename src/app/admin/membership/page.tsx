import Link from "next/link";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { ApplicationBoard } from "@/components/membership/ApplicationBoard";
import { AccessDeniedError, requireAdmin } from "@/lib/auth/guard";
import { PAYMENT_METHOD_LABELS, QR_DELIVERY_CHANNEL_LABELS } from "@/lib/membership/approval";
import { fetchApplications } from "@/lib/membership/approval-store";

import {
  approveApplicationAction,
  issueMembershipQrAction,
  recordPaymentAction,
  rejectApplicationAction,
} from "./actions";

/**
 * 街人登録 申請一覧（画面ID C7 ／ WBS 12-2 ／ v13 §5.10.4 Step 3〜5）。
 *
 * ## ★ この画面は admin 限定である（v13 §6）
 *
 * 伝票まわり（`7-2`）はコアメンバーにも開いているが、**申請一覧は admin のみ**。
 * `0037` の RLS も `membership_app_select_admin` / `_update_admin` で揃えてあり、
 * 承認の RPC（`0038`）は申告された操作者の role を自分でも確かめる。
 *
 * ## ナビへタブを足さない
 *
 * §5.9.5 は「管理系メニューを横スクロールに埋もれさせない」「管理者に12タブを平置きしない」
 * ことを要件にしている。到達経路は**管理ダッシュボード（C1）からのリンク**とし、
 * `/admin/customers` と同じ扱いにする（`AREAS` へは足さない）。
 */
export default async function MembershipApplicationsPage() {
  try {
    await requireAdmin();
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

  const applications = await fetchApplications();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Link href="/admin" className="text-sm underline">
        ← 管理ダッシュボードへ戻る
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">街人登録 申請一覧</h1>
        <p className="text-sm text-neutral-600">
          申請 → 決済QRの送付 or 現金の受領 → 入金確認 → 承認、の順に進めます。
          <strong>承認した時点で登録が成立</strong>し、街人へ昇格して宿泊券とキャッシュバックの
          発行依頼が起票されます（取り消せません）。
        </p>
      </div>

      <ApplicationBoard
        applications={applications}
        paymentMethodLabels={PAYMENT_METHOD_LABELS}
        qrChannelLabels={QR_DELIVERY_CHANNEL_LABELS}
        issueQr={issueMembershipQrAction}
        recordPayment={recordPaymentAction}
        approve={approveApplicationAction}
        reject={rejectApplicationAction}
      />

      <p className="text-xs text-neutral-500">
        決済はアプリ外（QRコード決済・現金・Uii）で完結します。この画面が記録するのは
        「どの手段で・いつ・誰が受け取り、誰が承認したか」です（v13 §5.10.4・§5.10.7）。
      </p>
    </main>
  );
}
