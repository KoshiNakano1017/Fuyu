// 予約のキャンセル・ノーショー（WBS 3-3）の入力検証テスト。
//
// v13 §5.2.2「理由入力は**必須**」。種別の選択だけでは足りず自由記述も要る
// （§5.6.4 の編集理由必須ルールに準拠）。
// 画面のバリデーションだけに頼ると、API を直接叩く経路で理由なしの取消が通る。
//
// DB 側の検証（`chk_check_ins_cancel_complete`）は `tests/db/` の担当であり、
// ここはアプリ層が同じ規則を持っていることを固定する（v13 §5.9.3 の二重防御）。

import { CANCEL_REASON_TYPES, validateCancellation } from "@/lib/lodging/cancellation";

describe("キャンセル理由の種別（v13 §7）", () => {
  test("種別は会員都合・ノーショー・運営都合の3値である", () => {
    expect(CANCEL_REASON_TYPES).toEqual(["会員都合", "ノーショー", "運営都合"]);
  });

  test("会員都合は受け付ける", () => {
    expect(validateCancellation({ reasonType: "会員都合", reason: "急用のため" })).toEqual({ ok: true });
  });

  test("ノーショーは受け付ける", () => {
    expect(validateCancellation({ reasonType: "ノーショー", reason: "当日連絡なく未着" })).toEqual({
      ok: true,
    });
  });

  test("運営都合は受け付ける", () => {
    expect(validateCancellation({ reasonType: "運営都合", reason: "設備点検のため" })).toEqual({
      ok: true,
    });
  });

  test("値域外の種別は受け付けない", () => {
    expect(validateCancellation({ reasonType: "その他", reason: "理由あり" })).toEqual({
      ok: false,
      reason: "invalid_reason_type",
    });
  });
});

describe("理由の自由記述は必須である（v13 §5.2.2）", () => {
  test("自由記述が空なら受け付けない", () => {
    expect(validateCancellation({ reasonType: "会員都合", reason: "" })).toEqual({
      ok: false,
      reason: "blank_reason",
    });
  });

  test("自由記述が空白文字だけなら受け付けない", () => {
    expect(validateCancellation({ reasonType: "ノーショー", reason: "　 " })).toEqual({
      ok: false,
      reason: "blank_reason",
    });
  });
});
