// 街人登録モーダルの画面まわりの受入テスト（Issue #87 ／ WBS `12-1` ロック中クエストの施錠表示・登録モーダル）。
//
// 固定する完了条件:
//  1 施錠カードからモーダルを起動する（v13 §5.10.6）
//  2 2段（入力 → 確認）である（§5.10.3「誤タップによる申請を防止」）
//  3 Step 1 の入力欄を**送らない**（2026-09-25 オーナー決定 A ／ Issue #87）
//  4 申請の Server Action がフォームの値を読まない（申請者は `auth.uid()` から引く）
//  5 `service_role` を使わない（境界は `0037` の RLS とトリガー）
//  6 金額・付与泊数を INSERT に含めない（トリガーがプランから写す）
//
// なぜソースを文字列として読むのか:
//   「送っていない」「読んでいない」は**書かれていないこと**を固定する条件であり、
//   実行時の振る舞いでは捕まえにくい（`tests/shopping-list-screen.test.ts` と同じ手段 ／ CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SRC_DIR } from "./helpers/ai-sources";

const MODAL = join(SRC_DIR, "components", "membership", "RegistrationModal.tsx");
const BOARD = join(SRC_DIR, "components", "quests", "QuestBoardWithRegistration.tsx");
const CARD = join(SRC_DIR, "components", "quests", "QuestCard.tsx");
const ACTIONS = join(SRC_DIR, "app", "quests", "actions.ts");
const STORE = join(SRC_DIR, "lib", "membership", "store.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** コメントを落としたソース。説明として名前を挙げたコメントで誤検知しないため。 */
function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("施錠カードからモーダルを起動する（v13 §5.10.6）", () => {
  test("施錠カードだけが起動ボタンを出す", () => {
    const card = readCode(CARD);
    expect(card).toContain("item.opensRegistrationModal");
    expect(card).toContain("onOpenRegistration");
  });

  test("モーダルの状態は一覧側が1つだけ持つ", () => {
    const board = readCode(BOARD);
    expect(board).toContain("useState(false)");
    // カードごとにモーダルを描かない（閉じ忘れ・二重表示の温床になる）
    expect((board.match(/<RegistrationModal/g) ?? []).length).toBe(1);
  });

  test("登録導線が不要な相手にはモーダルを渡さない", () => {
    expect(readCode(BOARD)).toContain("offer === null");
  });
});

describe("2段（入力 → 確認）である（v13 §5.10.3）", () => {
  const modal = readCode(MODAL);

  test("Step 1 と Step 2 を持つ", () => {
    expect(modal).toContain("function Step1(");
    expect(modal).toContain("function Step2(");
  });

  test("Step 1 の次へは submit ではなく画面遷移である（1枚で確定させない）", () => {
    expect(modal).toContain("登録内容を確認する");
    expect(modal).toContain("setStep(2)");
  });

  test("Step 2 から戻れる", () => {
    expect(modal).toContain("setStep(1)");
  });
});

describe("★ Step 1 の入力欄を送らない（決定 A ／ Issue #87）", () => {
  const modal = read(MODAL);

  test("入力欄が form の中に無い（submit に含まれない）", () => {
    // Step 1 は `fieldset` に入力欄を置くが、`form` を持たない。
    // Step 2 の `form` には hidden も含めて入力欄を1つも置かない。
    const step2 = modal.slice(modal.indexOf("function Step2("));
    expect(step2).not.toContain('name="nickname"');
    expect(step2).not.toContain('name="contact"');
    expect(step2).not.toContain('name="birthMonth"');
    expect(step2).not.toContain("<input type=\"hidden\"");
  });

  test("保存しないことを画面に書いている（黙って捨てない）", () => {
    expect(modal).toContain("この画面では保存しません");
  });
});

describe("申請の Server Action が受け取る入力が無い（他人名義の申請を作れない）", () => {
  const actions = readCode(ACTIONS);
  // 同じファイルには受注申請（WBS 5-2 ／ `questId` を受け取る）も居るため、
  // 街人登録の Action の本体だけを切り出して見る。
  const membershipAction = actions.slice(
    actions.indexOf("export async function applyForMembershipAction"),
    actions.indexOf("export async function applyToQuestAction") === -1
      ? undefined
      : actions.indexOf("export async function applyToQuestAction"),
  );

  test("フォームの値を読まない", () => {
    expect(membershipAction).not.toContain("formData.get");
    // 引数そのものを取らない形にしてある（受け取る口を用意しない）
    expect(membershipAction).toContain("applyForMembershipAction(): Promise<SubmitState>");
  });

  test("申請者はセッションから引く", () => {
    expect(membershipAction).toContain("readViewer()");
    expect(membershipAction).toContain("insertMembershipApplication(viewer.memberId)");
  });
});

describe("認可と金額の実体は DB 側である（`0037`）", () => {
  const store = readCode(STORE);

  test("service_role を使わない", () => {
    expect(store).not.toContain("createAdminSupabaseClient");
    expect(store).toContain("createServerSupabaseClient");
  });

  test("★ 申請の INSERT にプラン・状態を含めない（トリガーが決める）", () => {
    // `insert({...})` に渡している中身だけを見る（関数の外の型定義まで含めない）。
    const from = store.indexOf("insertMembershipApplication");
    const body = store.slice(from, store.indexOf("return error === null;", from));
    expect(body).not.toContain("plan_id");
    expect(body).not.toContain("status");
    // 送っているのは会員IDと、トリガーが上書きする NOT NULL の2列だけである。
    expect(body).toContain("member_id: memberId");
  });

  test("申込中として扱う状態が部分一意索引と同じ3値である", () => {
    expect(store).toContain('"申込中"');
    expect(store).toContain('"QR送付済み"');
    expect(store).toContain('"保留"');
  });

  test("現行プランは is_current_signup_plan で引く（年会費額では引かない）", () => {
    expect(store).toContain('eq("is_current_signup_plan", true)');
  });
});
