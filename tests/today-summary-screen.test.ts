// 「今日の浮遊街サマリー」画面まわりの受入テスト（WBS 13-1 ／ 画面ID C1）。
//
// 固定する完了条件:
//  1 画面は admin 限定（顧客の未会計額・滞在状況を一覧する画面である）
//  2 モック ⑫「本日のオペレーション状況」の4枚が出ている
//  3 ★ ダッシュボードは閾値判断をしない（滞留・要対応の判定を持ち込まない）
//  4 どのカードにも行き先のリンクが付く（数えて終わりにしない）
//  5 ナビへタブを足さない（v13 §5.9.5）
//  6 買い物リストの登録は**モーダル1枚で完結する入口**として置く（§5.12.1）
//
// なぜソースを文字列として読むのか:
//   「閾値判断を持ち込んでいない」は**書かれていないこと**を固定する条件であり、
//   実行時の振る舞いでは捕まえにくい（CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AREAS } from "@/lib/auth/navigation";

import { SRC_DIR } from "./helpers/ai-sources";

const DASHBOARD = join(SRC_DIR, "app", "admin", "page.tsx");

function read(): string {
  return readFileSync(DASHBOARD, "utf8");
}

function readCode(): string {
  return read()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("ダッシュボードは admin 限定（§6-1 ／ §5.9.3）", () => {
  test("`requireAdmin()` を通る", () => {
    expect(readCode()).toContain("requireAdmin()");
  });

  test("権限不足はアクセス制限画面を出す（§5.9.4）", () => {
    expect(readCode()).toContain("<AccessDenied");
  });
});

describe("モック ⑫「本日のオペレーション状況」の4枚が出ている（WBS 13-1 の残り）", () => {
  const page = read();

  test.each([
    "チェックイン／アウト予定",
    "募集中クエスト枠",
    "未送付の Eumo 給付",
    "朝会議事録",
  ])("%s のカードがある", (title) => {
    expect(page).toContain(title);
  });

  test("数え方は純関数から取る（画面側で数えない）", () => {
    const code = readCode();
    for (const fn of [
      "countArrivalsAndDepartures(",
      "countOpenQuests(",
      "countPendingGrants(",
      "isMorningMeetingRecorded(",
      "countUnhandledQuestCandidates(",
    ]) {
      expect(code).toContain(fn);
    }
  });

  test("朝会の表示語は変換表を通す（画面に文字列を書かない）", () => {
    const code = readCode();
    expect(code).toContain("morningMeetingLabel(");
    expect(code).not.toContain('"生成済み"');
  });
});

describe("★ ダッシュボードは閾値判断をしない（判断の出所を2つにしない）", () => {
  const code = readCode();

  test("滞留の判定を持ち込まない（Eumo給付一覧の役目）", () => {
    expect(code).not.toContain("isStaleSentGrant");
  });

  test("★ 日数の閾値をここで書かない", () => {
    // 「14日超」のような判断は `src/lib/eumo/grants.ts` が正本である。
    expect(code).not.toMatch(/>\s*14\b/);
    expect(code).not.toContain("STALE");
  });
});

describe("どのカードにも行き先が付く（数えて終わりにしない）", () => {
  const code = readCode();

  test("カードは `href` と `linkLabel` を必ず受け取る", () => {
    // 省略可にすると「件数だけ出ていてどこへ行けばよいか分からない」カードが作れてしまう。
    expect(code).toContain("href: string;");
    expect(code).toContain("linkLabel: string;");
  });

  test.each(["/staff/checkins", "/staff/orders", "/staff/quests", "/staff/eumo", "/admin/customers"])(
    "%s への導線がある",
    (href) => {
      expect(code).toContain(href);
    },
  );

  test("朝会モジュールへ行ける", () => {
    expect(code).toContain("/admin/morning-meetings");
  });
});

describe("ナビへタブを足さない（v13 §5.9.5）", () => {
  test("`AREAS` に朝会・顧客管理などの経路を足していない", () => {
    const paths = AREAS.map((area) => area.path);
    for (const notInNav of [
      "/admin/morning-meetings",
      "/admin/customers",
      "/admin/membership",
      "/admin/members/link-requests",
    ]) {
      expect(paths).not.toContain(notInNav);
    }
  });
});

describe("買い物リストの登録はモーダル1枚で完結する入口（v13 §5.12.1）", () => {
  test("`ShoppingRegisterForm` を置く（一覧へのリンクで代えない）", () => {
    expect(readCode()).toContain("<ShoppingRegisterForm />");
  });

  test("★ サマリーカードの並びに混ぜない", () => {
    // カードは「今日の実数」を数える器である。登録の入口を同じ並びに置くと、
    // 「数えるだけで判断はしない」の切り分けが崩れる。
    const code = readCode();
    const cards = code.slice(code.indexOf("<SummaryCard"));
    expect(cards).not.toContain("ShoppingRegisterForm");
  });
});
