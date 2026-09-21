// `/staff/knowledge`（B9 店員タブレットのコンシェルジュ導線）の到達性と認可の受入テスト
// （WBS `9-2` line-rag-bot管理画面への導線（外部リンクのみ）／ Issue #94）。
//
// 固定する完了条件:
//   完了条件1 core_member と admin が `/staff/knowledge` を開くと導線ボタンが表示される
//             （v13 §5.9.1「ナレッジ登録フォーム（§5.7）」行 ＝ コアメンバー ◯／運営管理者 ◯、
//              v13 §5.7.1、画面設計.md §4 B9）
//   完了条件3 member・guest はナビに当該領域が描画されず、URL を直接叩いても中身を描画しない
//             （v13 §5.9.2 DOM から除外 ／ §5.9.3 サーバサイド認可の併置 ／ §5.9.4 中身をマウントしない）
//
// CLAUDE.md §4.4「認可に関わるロジックは必ずテストを書く」。許可側と拒否側を対で置く。
// 判定キーは `role` であり `member_type` ではない（CLAUDE.md §4.1 のドメイン用語表）。

import { AREAS, areaForPath, canAccessPath, visibilityFor, visibleAreasFor } from "@/lib/auth/navigation";

import { readStaffKnowledgePage } from "./helpers/concierge-sources";

const KNOWLEDGE_PATH = "/staff/knowledge";
const KNOWLEDGE_AREA_KEY = "knowledgeForm";

describe("経路の対応（v13 §5.9.3 単一のソース・オブ・トゥルース）", () => {
  test(`${KNOWLEDGE_PATH} は ${KNOWLEDGE_AREA_KEY} 領域として解決される`, () => {
    // ナビ定義と画面ガードが同じ表を根拠にしていることの土台。
    // ここがズレると、以降の認可テストが別の領域を検証してしまう。
    expect(areaForPath(KNOWLEDGE_PATH)?.key).toBe(KNOWLEDGE_AREA_KEY);
  });
});

describe("許可側：core_member と admin（完了条件1 ／ v13 §5.9.1）", () => {
  test("コアメンバーは /staff/knowledge へ入れる", () => {
    expect(canAccessPath(KNOWLEDGE_PATH, "core_member")).toBe(true);
  });

  test("運営管理者は /staff/knowledge へ入れる", () => {
    expect(canAccessPath(KNOWLEDGE_PATH, "admin")).toBe(true);
  });

  test("コアメンバーのナビにナレッジ登録の領域が現れる", () => {
    // 画面設計.md §2-4-2 が B9 を 🔴 としていた理由（導線が admin 限定で
    // core_member から到達できない）を、ここで再発させない。
    expect(visibleAreasFor("core_member").map((area) => area.key)).toContain(KNOWLEDGE_AREA_KEY);
  });

  test("運営管理者のナビにナレッジ登録の領域が現れる", () => {
    expect(visibleAreasFor("admin").map((area) => area.key)).toContain(KNOWLEDGE_AREA_KEY);
  });
});

describe("拒否側：member・guest（完了条件3 ／ v13 §5.9.2）", () => {
  const knowledgeArea = () => AREAS.find((area) => area.key === KNOWLEDGE_AREA_KEY)!;

  test("一般会員には非表示である", () => {
    expect(visibilityFor(knowledgeArea(), "member")).toBe("hidden");
  });

  test("ゲストには非表示である", () => {
    expect(visibilityFor(knowledgeArea(), "guest")).toBe("hidden");
  });

  test("一般会員のナビにナレッジ登録の領域が現れない", () => {
    expect(visibleAreasFor("member").map((area) => area.key)).not.toContain(KNOWLEDGE_AREA_KEY);
  });

  test("ゲストのナビにナレッジ登録の領域が現れない", () => {
    expect(visibleAreasFor("guest").map((area) => area.key)).not.toContain(KNOWLEDGE_AREA_KEY);
  });

  test("一般会員は URL を直接叩いても /staff/knowledge へ入れない", () => {
    expect(canAccessPath(KNOWLEDGE_PATH, "member")).toBe(false);
  });

  test("ゲストは URL を直接叩いても /staff/knowledge へ入れない", () => {
    expect(canAccessPath(KNOWLEDGE_PATH, "guest")).toBe(false);
  });

  test("custom も /staff/knowledge へ入れない（権限内容が未定義のため ／ DB物理設計 §6-9⑥）", () => {
    expect(canAccessPath(KNOWLEDGE_PATH, "custom")).toBe(false);
  });
});

describe("サーバサイド認可の併置（完了条件3 ／ v13 §5.9.3・§5.9.4）", () => {
  test("ページがサーバサイドで requireStaff() を呼ぶ", () => {
    // 「DOM非表示は認可ではない」（§5.9.3）。ナビから消えていても URL は叩けるため、
    // ページ側の判定が無いと中身が素通りする。
    expect(readStaffKnowledgePage()).toContain("requireStaff(");
  });

  test("拒否時にアクセス制限画面を返す", () => {
    expect(readStaffKnowledgePage()).toContain("AccessDenied");
  });

  test("認可判定より前にコンシェルジュ導線を描画しない", () => {
    // §5.9.4「認可判定が完了するまで中身をマウントしない」。
    // 認可の呼び出しが導線の描画より後ろに書かれていれば、その時点で先に中身が組まれている。
    const source = readStaffKnowledgePage();
    expect(source.indexOf("requireStaff(")).toBeLessThan(source.indexOf("<ConciergeAdminLink"));
  });
});

describe("導線ボタンの配置（完了条件1 ／ 画面設計.md §4 B9）", () => {
  test("ページがコンシェルジュ管理画面への導線ボタンを描画する", () => {
    expect(readStaffKnowledgePage()).toContain("<ConciergeAdminLink");
  });
});
