// Eumo給付の判定（WBS 5-5・5-7・12-4）の単体テスト。
//
// 根拠: v13 §5.3.1（発行依頼→発行済み未受領→受領済み ／ 滞留14日）、
//       v13 §5.10.8（初回来訪キャッシュバックの判定と二重付与の防止）、
//       `CONSOLIDATED_DECISIONS.md` 2026-09-22（#59 全面決着：判定が疑わしい会員は「要確認」）。
//
// 金額の付与に関わる判定であり、CLAUDE.md §4.4 が「必ずテストを書く」と定める領域である。
// ⚠️ eumo の送金はアプリ外で行われるため、**二重に起票すると取り消せない**。

import {
  buildQuestRewardGrant,
  decideConfirmReceipt,
  decideManualGrant,
  decideMarkFailed,
  decideSend,
  isStaleSentGrant,
  judgeFirstVisitCashback,
  visitBadgeLabel,
} from "@/lib/eumo/grants";

describe("送付の記録（v13 §5.3.1）", () => {
  test("発行依頼（未送付）を送付済みにできる", () => {
    expect(decideSend({ actorRole: "admin", status: "未送付", sentChannel: "email" })).toEqual({
      allowed: true,
    });
  });

  test("送付済みのものを再度送付済みにはできない（滞留の起算点が押し戻されるため）", () => {
    expect(decideSend({ actorRole: "admin", status: "送付済", sentChannel: "email" })).toEqual({
      allowed: false,
      reason: "already_sent",
    });
  });

  test("送付失敗からは送り直せる", () => {
    expect(decideSend({ actorRole: "core_member", status: "送付失敗", sentChannel: "line" })).toEqual({
      allowed: true,
    });
  });

  test("一般会員は送付を記録できない", () => {
    expect(decideSend({ actorRole: "member", status: "未送付", sentChannel: "email" })).toEqual({
      allowed: false,
      reason: "not_staff",
    });
  });

  test("値域にない送付経路は受け付けない", () => {
    expect(decideSend({ actorRole: "admin", status: "未送付", sentChannel: "carrier_pigeon" })).toEqual({
      allowed: false,
      reason: "blank_channel",
    });
  });
});

describe("受領確認（v13 §5.3.1）", () => {
  test("送る前に受領確認済みにはできない", () => {
    expect(decideConfirmReceipt({ actorRole: "admin", status: "未送付" })).toEqual({
      allowed: false,
      reason: "not_sent_yet",
    });
  });

  test("送付済みなら受領確認できる", () => {
    expect(decideConfirmReceipt({ actorRole: "core_member", status: "送付済" })).toEqual({
      allowed: true,
    });
  });

  test("本人の受領報告でも受領確認済みにできる（v13 §5.3.1 拡張）", () => {
    expect(
      decideConfirmReceipt({ actorRole: "member", status: "送付済", isRecipientSelf: true }),
    ).toEqual({ allowed: true });
  });

  test("他人の給付を一般会員が受領確認することはできない", () => {
    expect(decideConfirmReceipt({ actorRole: "member", status: "送付済" })).toEqual({
      allowed: false,
      reason: "not_staff",
    });
  });
});

describe("送付失敗・手動起票", () => {
  test("理由のない失敗は記録できない（再送の判断ができなくなる）", () => {
    expect(decideMarkFailed({ actorRole: "admin", status: "送付済", failureReason: "  " })).toEqual({
      allowed: false,
      reason: "blank_reason",
    });
  });

  test("用途のない手動起票は受け付けない", () => {
    expect(decideManualGrant({ actorRole: "admin", amountUii: 5000, purpose: "" })).toEqual({
      allowed: false,
      reason: "blank_purpose",
    });
  });

  test("0 Uii の給付は起こせない", () => {
    expect(decideManualGrant({ actorRole: "admin", amountUii: 0, purpose: "過去分" })).toEqual({
      allowed: false,
      reason: "invalid_amount",
    });
  });
});

describe("送付済みの滞留（v13 §5.3.1：14日）", () => {
  const now = new Date("2026-09-22T00:00:00.000Z");

  test("送付から15日経った給付は滞留として拾う", () => {
    expect(isStaleSentGrant({ status: "送付済", sentAt: "2026-09-06T00:00:00.000Z", now })).toBe(true);
  });

  test("送付から13日なら滞留ではない", () => {
    expect(isStaleSentGrant({ status: "送付済", sentAt: "2026-09-09T00:00:00.000Z", now })).toBe(false);
  });

  test("受領確認済みは滞留にしない", () => {
    expect(isStaleSentGrant({ status: "受領確認済", sentAt: "2026-01-01T00:00:00.000Z", now })).toBe(
      false,
    );
  });
});

describe("クエスト報酬の給付（WBS 5-5）", () => {
  const base = { memberId: "m1", questId: "q1", questTitle: "薪割り", logId: "l1" };

  test("報酬額が設定されていれば給付行を作る", () => {
    expect(buildQuestRewardGrant({ ...base, rewardUii: 800 })).toEqual({
      member_id: "m1",
      quest_id: "q1",
      log_id: "l1",
      amount_uii: 800,
      grant_type: "quest_reward",
      purpose: "クエスト報酬「薪割り」",
    });
  });

  test("報酬額が未設定のクエストでは起票しない（0 Uii の給付を一覧へ並べない）", () => {
    expect(buildQuestRewardGrant({ ...base, rewardUii: null })).toBeNull();
  });
});

describe("初回来訪キャッシュバックの判定（v13 §5.10.8 ／ #59）", () => {
  const base = {
    memberType: "街人（一般）",
    visitCount: 1,
    existingCashbackStatus: null,
    isImportedMember: false,
    planCashbackUii: 5000,
  };

  test("アプリ登録の街人の初回来訪は自動で起票できる", () => {
    expect(judgeFirstVisitCashback(base)).toEqual({ kind: "auto_draft", amountUii: 5000 });
  });

  test("移行データ由来の街人は自動起票せず「要確認」にする（#59 論点2）", () => {
    const judgement = judgeFirstVisitCashback({ ...base, isImportedMember: true });
    expect(judgement.kind).toBe("needs_review");
  });

  test("既にキャッシュバックがある会員には起票しない（二重付与の防止）", () => {
    expect(judgeFirstVisitCashback({ ...base, existingCashbackStatus: "送付済" })).toEqual({
      kind: "already_issued",
      status: "送付済",
    });
  });

  test("再訪は対象外である", () => {
    const judgement = judgeFirstVisitCashback({ ...base, visitCount: 3 });
    expect(judgement.kind).toBe("not_applicable");
  });

  test("ゲストは対象外である", () => {
    const judgement = judgeFirstVisitCashback({ ...base, memberType: "ゲスト" });
    expect(judgement.kind).toBe("not_applicable");
  });

  test("プランを判別できなければ額を決めずに「要確認」にする", () => {
    const judgement = judgeFirstVisitCashback({ ...base, planCashbackUii: null });
    expect(judgement.kind).toBe("needs_review");
  });
});

describe("来訪バッジ（v13 §5.10.8 ①）", () => {
  test("初回来訪は「初回」と出す", () => {
    expect(visitBadgeLabel(1)).toContain("初回来訪");
  });

  test("再訪は通算回数を添える", () => {
    expect(visitBadgeLabel(4)).toBe("再訪（通算4回目）");
  });
});
