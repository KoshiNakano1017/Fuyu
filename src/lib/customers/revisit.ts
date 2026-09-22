/**
 * 再訪アラート（WBS 10-3 ／ v13 §5.6.6・§5.8.4）。
 *
 * **未処理の差額を持つ会員が滞在に入ったら、運営の画面に出す。**
 * 差額は「次回来訪時に現地で精算する」という前提で繰り越されており（§5.6.6）、
 * 来訪したことに気づけなければ、その前提が成り立たない。
 * 90日の滞留一覧（`is_stale`）は後追いの仕組みであって、**現地で回収する機会はその場にしかない**。
 *
 * 判定そのものは純関数に置く。画面（店員タブレット・管理ダッシュボード）が2つあり、
 * どちらにも同じ条件で出す必要があるためである（条件が2箇所に分かれると片方だけ古くなる）。
 */

/** アラート1件。**実名は含まない**（表示名は `v_member_public` 由来）。 */
export type RevisitAlert = {
  memberId: string;
  memberLabel: string;
  /** 立場（親方／街人／ゲスト）。認可には使わない（v13 §2） */
  memberType: string;
  /** 残りの宿泊券。現地の案内で使う（WBS 10-3） */
  stayTickets: number;
  pendingAdjustmentCount: number;
  /** 符号付きの合計。＋＝追加請求（会員が払う）／−＝返金（運営が返す） */
  pendingAdjustmentYen: number;
};

export type StayingMember = {
  memberId: string;
  memberLabel: string;
  memberType: string;
  stayTickets: number;
};

export type PendingAdjustmentRow = {
  memberId: string;
  amountYen: number;
};

/**
 * 滞在中の会員のうち、未処理の差額を持つ人だけを拾う。
 *
 * ## 返金も出す
 *
 * 追加請求（会員が払う側）だけを出すと、**運営が返すべき差額が現地で返されない**。
 * v13 §5.6.6 の [!warning] が「返金を無期限に繰り越すのは会員の不利益」と明示しているとおり、
 * 返金こそ本人が来ているうちに渡す必要がある。
 *
 * ## 並びは金額の大きい順にしない
 *
 * 金額順にすると、返金（マイナス）が末尾へ沈む。**件数ではなく絶対値**で並べ、
 * 大きい差額から順に片付けられるようにする。
 */
export function selectRevisitAlerts(params: {
  stayingMembers: readonly StayingMember[];
  pendingAdjustments: readonly PendingAdjustmentRow[];
}): RevisitAlert[] {
  const alerts = params.stayingMembers.flatMap((member) => {
    const mine = params.pendingAdjustments.filter((row) => row.memberId === member.memberId);
    if (mine.length === 0) {
      return [];
    }
    return [
      {
        memberId: member.memberId,
        memberLabel: member.memberLabel,
        memberType: member.memberType,
        stayTickets: member.stayTickets,
        pendingAdjustmentCount: mine.length,
        pendingAdjustmentYen: mine.reduce((sum, row) => sum + row.amountYen, 0),
      },
    ];
  });

  return alerts.sort(
    (left, right) =>
      Math.abs(right.pendingAdjustmentYen) - Math.abs(left.pendingAdjustmentYen) ||
      left.memberId.localeCompare(right.memberId),
  );
}

/** アラート1件の要約文。差額の向きを「請求」「返金」と言い切る（符号だけでは現場で読み違える）。 */
export function describeRevisitAlert(alert: RevisitAlert): string {
  const amount = Math.abs(alert.pendingAdjustmentYen).toLocaleString("ja-JP");
  const direction = alert.pendingAdjustmentYen >= 0 ? "追加請求" : "返金";
  return `${direction} ¥${amount}（${alert.pendingAdjustmentCount}件）`;
}
