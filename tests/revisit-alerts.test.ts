// 再訪アラート（WBS 10-3 ／ v13 §5.6.6・§5.8.4）の単体テスト。
//
// 「未処理の差額を持つ会員が滞在に入ったら運営へ出す」という条件が、
// 店員タブレットと管理ダッシュボードで揃っていることを1箇所で固定する。

import { describeRevisitAlert, selectRevisitAlerts } from "@/lib/customers/revisit";

const STAYING = [
  { memberId: "m1", memberLabel: "街人#10001", memberType: "街人（一般）", stayTickets: 2 },
  { memberId: "m2", memberLabel: "街人#10002", memberType: "親方", stayTickets: 0 },
];

describe("アラートの対象（v13 §5.6.6）", () => {
  test("未処理の差額が無い滞在者は出さない", () => {
    const alerts = selectRevisitAlerts({ stayingMembers: STAYING, pendingAdjustments: [] });
    expect(alerts).toEqual([]);
  });

  test("差額を持つ滞在者だけを出す", () => {
    const alerts = selectRevisitAlerts({
      stayingMembers: STAYING,
      pendingAdjustments: [{ memberId: "m2", amountYen: 1200 }],
    });
    expect(alerts.map((alert) => alert.memberId)).toEqual(["m2"]);
  });

  test("滞在していない会員の差額は出さない（現地で精算できないため）", () => {
    const alerts = selectRevisitAlerts({
      stayingMembers: STAYING,
      pendingAdjustments: [{ memberId: "m9", amountYen: 5000 }],
    });
    expect(alerts).toEqual([]);
  });

  test("返金（マイナス）も出す（繰り越し続けると会員の不利益になる）", () => {
    const alerts = selectRevisitAlerts({
      stayingMembers: STAYING,
      pendingAdjustments: [{ memberId: "m1", amountYen: -3000 }],
    });
    expect(alerts[0].pendingAdjustmentYen).toBe(-3000);
  });

  test("同じ会員の複数件はまとめて件数と合計で出す", () => {
    const alerts = selectRevisitAlerts({
      stayingMembers: STAYING,
      pendingAdjustments: [
        { memberId: "m1", amountYen: 500 },
        { memberId: "m1", amountYen: 700 },
      ],
    });
    expect(alerts[0]).toMatchObject({ pendingAdjustmentCount: 2, pendingAdjustmentYen: 1200 });
  });

  test("並びは金額の絶対値が大きい順（返金が末尾へ沈まない）", () => {
    const alerts = selectRevisitAlerts({
      stayingMembers: STAYING,
      pendingAdjustments: [
        { memberId: "m1", amountYen: 800 },
        { memberId: "m2", amountYen: -9000 },
      ],
    });
    expect(alerts.map((alert) => alert.memberId)).toEqual(["m2", "m1"]);
  });
});

describe("アラートの文言", () => {
  const alert = {
    memberId: "m1",
    memberLabel: "街人#10001",
    memberType: "街人（一般）",
    stayTickets: 1,
    pendingAdjustmentCount: 1,
    pendingAdjustmentYen: 1200,
  };

  test("追加請求は「追加請求」と言い切る（符号だけでは現場で読み違える）", () => {
    expect(describeRevisitAlert(alert)).toBe("追加請求 ¥1,200（1件）");
  });

  test("返金は「返金」と言い切る", () => {
    expect(describeRevisitAlert({ ...alert, pendingAdjustmentYen: -3000 })).toBe("返金 ¥3,000（1件）");
  });
});
