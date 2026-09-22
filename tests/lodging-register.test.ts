// チェックイン時の宿泊者名簿（WBS 3-2 ／ v13 §5.2.7）の入力検証テスト。
//
// v13 §5.2.7「本人の自己申告のみでは確定させない」を、値の出所ではなく
// 「氏名・カナを本人へ提示し確認した」申告（fullNameConfirmed）の有無で担保する。
// 画面のチェックボックスだけに頼ると、API を直接叩く経路で未確認のまま確定できてしまうため、
// アプリ層（Server Action ／ Route Handler の双方が呼ぶ）に同じ規則を固定する（v13 §5.9.3 の二重防御）。
//
// DB 側の検証（RLS・NOT NULL 制約）は `tests/db/lodging-register.test.ts` の担当。

import { validateLodgingRegisterInput } from "@/lib/lodging/register";

const VALID_INPUT = {
  fullNameConfirmed: true,
  fullNameSnapshot: "テスト 太郎",
  address: "テスト県テスト市テスト町1-2-3",
  previousLocation: "テスト県前泊市",
};

describe("本人確認申告が無ければ拒否する（v13 §5.2.7）", () => {
  test("有効な入力は受け付ける", () => {
    expect(validateLodgingRegisterInput(VALID_INPUT)).toEqual({ ok: true });
  });

  test("fullNameConfirmed が false なら、他の項目が揃っていても拒否する", () => {
    expect(validateLodgingRegisterInput({ ...VALID_INPUT, fullNameConfirmed: false })).toEqual({
      ok: false,
      reason: "full_name_not_confirmed",
    });
  });
});

describe("旅館業法必須項目が空なら拒否する（API設計.md §3-5）", () => {
  test("氏名が空なら拒否する", () => {
    expect(validateLodgingRegisterInput({ ...VALID_INPUT, fullNameSnapshot: "" })).toEqual({
      ok: false,
      reason: "full_name_blank",
    });
  });

  test("氏名が空白文字だけなら拒否する", () => {
    expect(validateLodgingRegisterInput({ ...VALID_INPUT, fullNameSnapshot: "　 " })).toEqual({
      ok: false,
      reason: "full_name_blank",
    });
  });

  test("住所が空なら拒否する", () => {
    expect(validateLodgingRegisterInput({ ...VALID_INPUT, address: "" })).toEqual({
      ok: false,
      reason: "address_blank",
    });
  });

  test("前泊地が空なら拒否する", () => {
    expect(validateLodgingRegisterInput({ ...VALID_INPUT, previousLocation: "" })).toEqual({
      ok: false,
      reason: "previous_location_blank",
    });
  });
});

describe("検証の優先順位（本人確認の欠落を最優先で報告する）", () => {
  test("fullNameConfirmed が false かつ住所も空なら、confirmed 未チェックの理由を返す", () => {
    expect(
      validateLodgingRegisterInput({ ...VALID_INPUT, fullNameConfirmed: false, address: "" }),
    ).toEqual({ ok: false, reason: "full_name_not_confirmed" });
  });
});
