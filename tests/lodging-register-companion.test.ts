// 同伴者の宿泊者名簿（WBS 3-2 の残り ／ Issue #156 ／ v13 §5.2.7）の受入テスト。
//
// 固定する完了条件（Issue #156 の A 節）:
//  1 同伴者を1名につき1名簿行（`is_representative = false`）として登録できる
//  2 同伴者にも氏名確認・住所・前泊地の必須を課す（同伴者なら省ける抜け道を作らない）
//  3 同伴者の行を代表者の行とは独立に訂正できる
//  4 ★ 訂正の対象が「このチェックインの同伴者行」であることを確かめる
//  5 ★ 同伴者に `member_id` を持たせない（代表者が同伴者の住所を読めるようにしない）
//  6 名簿を消す口を作らない（法定記録）
//  7 作成・訂正は staff 限定
//
// なぜソースを文字列として読むのか:
//   「member_id を入れていない」「削除の口が無い」「所属を確かめている」は、いずれも
//   **書かれていないこと／書かれている1行**を固定する条件であり、DB を立てずに壊れを捕まえたい
//   （CLAUDE.md §4.4 ／ 他の screen テストと同じ考え方）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateLodgingRegisterInput } from "@/lib/lodging/register";

import { SRC_DIR } from "./helpers/ai-sources";

const REGISTER = join(SRC_DIR, "lib", "lodging", "register.ts");
const PAGE_DIR = join(SRC_DIR, "app", "admin", "checkins", "[id]", "lodging-register");
const PAGE = join(PAGE_DIR, "page.tsx");
const SECTION = join(PAGE_DIR, "CompanionRegisterSection.tsx");
const ACTIONS = join(PAGE_DIR, "actions.ts");
const ROUTE = join(SRC_DIR, "app", "api", "checkins", "[id]", "lodging-register", "route.ts");
const BOARD = join(SRC_DIR, "components", "lodging", "CheckInBoard.tsx");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("同伴者にも必須項目を課す（同伴者なら省ける抜け道を作らない）", () => {
  const filled = {
    fullNameConfirmed: true,
    fullNameSnapshot: "テスト 花子",
    address: "テスト県テスト市テスト町1-2-3",
    previousLocation: "テスト県前泊市",
  };

  test("すべて揃っていれば通る", () => {
    expect(validateLodgingRegisterInput(filled)).toEqual({ ok: true });
  });

  test("氏名の確認チェックが無ければ拒否する", () => {
    expect(validateLodgingRegisterInput({ ...filled, fullNameConfirmed: false })).toEqual({
      ok: false,
      reason: "full_name_not_confirmed",
    });
  });

  test("住所が空なら拒否する（旅館業法必須）", () => {
    expect(validateLodgingRegisterInput({ ...filled, address: "  " })).toEqual({
      ok: false,
      reason: "address_blank",
    });
  });

  test("前泊地が空なら拒否する（旅館業法必須）", () => {
    expect(validateLodgingRegisterInput({ ...filled, previousLocation: "" })).toEqual({
      ok: false,
      reason: "previous_location_blank",
    });
  });

  test("★ 同伴者の登録も同じ検証関数を通る（分岐で緩めていない）", () => {
    const code = readCode(REGISTER);
    const companion = code.slice(code.indexOf("export async function submitCompanionRegisterEntry"));
    expect(companion).toContain("validateLodgingRegisterInput(params)");
  });
});

describe("★ 同伴者は会員に紐づけない（代表者が同伴者の住所を読めるようにしない）", () => {
  const code = readCode(REGISTER);
  const companion = code.slice(code.indexOf("export async function submitCompanionRegisterEntry"));

  test("`member_id` に null を入れる", () => {
    expect(companion).toContain("member_id: null");
  });

  test("★ チェックインの `member_id` を写していない", () => {
    // 写すと `lre_select_self`（member_id = current_member_id()）で代表者に読まれる。
    expect(companion).not.toContain("member_id: checkIn.member_id");
  });

  test("`is_representative` を false で保存する", () => {
    expect(companion).toContain("is_representative: false");
  });
});

describe("★ 訂正の対象が「このチェックインの同伴者行」であることを確かめる", () => {
  const code = readCode(REGISTER);
  const companion = code.slice(code.indexOf("export async function submitCompanionRegisterEntry"));

  test("`entry_id` だけで更新しない（checkin_id と is_representative も条件にする）", () => {
    // ここが無いと、細工した entry_id で代表者の行や別のチェックインの名簿を上書きできる。
    const lookup = companion.slice(companion.indexOf('.eq("entry_id", entryId)'));
    expect(lookup).toContain('.eq("checkin_id", params.checkinId)');
    expect(lookup).toContain('.eq("is_representative", false)');
  });

  test("見つからなければ `entry_not_found` を返す（黙って作らない）", () => {
    expect(companion).toContain('reason: "entry_not_found"');
  });

  test("`entryId` 未指定は新規作成にする（訂正と作成を取り違えない）", () => {
    expect(companion).toContain('if (entryId === "")');
  });
});

describe("名簿を消す口を作らない（法定記録 ／ `0010` は DELETE を許していない）", () => {
  test("アプリ層に削除関数が無い", () => {
    expect(readCode(REGISTER)).not.toContain(".delete()");
  });

  test("Server Action に削除が無い", () => {
    expect(readCode(ACTIONS)).not.toContain("delete");
  });

  test("★ 画面に削除ボタンを置かない", () => {
    const section = readCode(SECTION);
    const buttons = section.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).not.toContain("削除");
    }
  });

  test("消せないことを画面に書いておく（運用で訂正へ誘導する）", () => {
    expect(read(SECTION)).toContain("削除できません");
  });
});

describe("画面：1名につき1フォーム（v13 §5.2.7「同伴者も1名につき1名簿行」）", () => {
  test("名簿画面に同伴者セクションが出る", () => {
    expect(readCode(PAGE)).toContain("<CompanionRegisterSection");
  });

  test("登録済みの同伴者ごとにフォームを描く", () => {
    const section = readCode(SECTION);
    expect(section).toContain("companions.map(");
    expect(section).toContain('name="entryId"');
  });

  test("追加用のフォームが常に1枚ある", () => {
    expect(readCode(SECTION)).toContain('companion={null}');
  });

  test("同伴者フォームにも旅館業法の3項目がある", () => {
    const section = readCode(SECTION);
    for (const field of ['name="fullNameSnapshot"', 'name="address"', 'name="previousLocation"']) {
      expect(section).toContain(field);
    }
  });

  test("確認チェックまで送信ボタンを非活性にする（代表者フォームと同じ扱い）", () => {
    const section = readCode(SECTION);
    expect(section).toContain('name="fullNameConfirmed"');
    expect(section).toContain("disabled={!confirmed}");
  });

  test("名簿の枚数と予約人数を並べて出す（足りているかを目で確かめられる）", () => {
    expect(read(SECTION)).toContain("予約人数");
  });
});

describe("到達性：チェックイン一覧の行から名簿画面へ行ける（Issue #156 A ①）", () => {
  test("`checkin_id` を URL へ打ち込む必要がない", () => {
    expect(read(BOARD)).toContain("/lodging-register");
  });
});

describe("作成・訂正は staff 限定（v13 §5.2.7「権限」／ §5.9.3）", () => {
  test("Server Action が `isStaff()` を通す", () => {
    const actions = readCode(ACTIONS);
    const companion = actions.slice(actions.indexOf("submitCompanionRegisterAction"));
    expect(companion).toContain("isStaff(viewer.role)");
  });

  test("API も `isStaff()` を通す", () => {
    expect(readCode(ROUTE)).toContain("isStaff(viewer.role)");
  });
});

describe("API：`is_representative` の既定は代表者（`API設計.md` §3-5）", () => {
  const route = readCode(ROUTE);

  test("★ `false` と明示されたときだけ同伴者として扱う", () => {
    // 未指定を同伴者側へ倒すと、古い呼び出し元が代表者の名簿を作れなくなる。
    expect(route).toContain("body.is_representative === false");
  });

  test("同伴者の訂正は `entry_id` で受ける", () => {
    expect(route).toContain("body.entry_id");
  });

  test("★ 見つからない名簿行は 404 で返す（403 にしない）", () => {
    // 403 にすると「存在はするが権限が無い」と読めて、他人の名簿の存在を当てられる。
    const branch = route.slice(route.indexOf('result.reason === "entry_not_found"'));
    expect(branch.slice(0, 200)).toContain("status: 404");
  });
});
