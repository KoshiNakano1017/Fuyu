// メディアの運営措置の画面まわりの受入テスト（Issue #150 ／ WBS `14-3` メディアの運営措置）。
//
// 固定する完了条件:
//  1 アップロード画面に「他人が写る写真は本人の同意を得ること」の注意書きがある（v13 §5.11.7 警告2点目）
//  2 措置の操作面が Phase 1 の画面（A10）に存在する（同 警告1点目）
//  3 クライアントへロールを渡していない（判定はサーバ側の `listModerationOffers()` で閉じる）
//  4 措置の経路が `service_role` を使わない（境界は `0027` の RLS である）
//  5 物理削除の経路を持たない（v13 §5.11.7「削除は論理削除」）
//  6 アップロード画面は全ロールへ開いている（ナビの可視性・§5.11.7 ①）
//
// なぜソースを文字列として読むのか:
//   「渡していない」「使っていない」は**書かれていないこと**を固定する条件であり、
//   実行時の振る舞いでは捕まえにくい（`tests/shopping-list-screen.test.ts`・
//   `tests/staff-knowledge-page.test.ts` と同じ手段 ／ CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { visibleAreasFor } from "@/lib/auth/navigation";
import type { Role } from "@/lib/auth/session";

import { SRC_DIR } from "./helpers/ai-sources";

const UPLOAD_PAGE = join(SRC_DIR, "app", "upload", "page.tsx");
const UPLOAD_ACTIONS = join(SRC_DIR, "app", "upload", "actions.ts");
const MODERATION_LIST = join(SRC_DIR, "components", "media", "MediaModerationList.tsx");
const MEDIA_STORE = join(SRC_DIR, "lib", "media", "store.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * コメントを落としたソース。
 *
 * 「〜を呼んでいない」「〜を使っていない」を文字列で見る以上、**説明として名前を挙げた
 * コメントで誤検知する**（本ファイルが検出したいのは実際の呼び出しである）。
 * コメントを削る規約を1箇所に置き、各テストはそれを使う。
 */
function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("アップロード画面の注意書き（v13 §5.11.7 の警告2点目）", () => {
  const source = read(UPLOAD_PAGE);

  test("他の人が写っている場合は同意を得るよう書かれている", () => {
    expect(source).toContain("他の人が写っている写真・動画は、本人の同意を得てから投稿してください");
  });

  test("既定の公開範囲が「公開」であることが書かれている", () => {
    // 既定が公開だと知らずに投稿されるのが、この機能でいちばん困る事故である。
    expect(source).toContain("既定で「公開」");
  });

  test("運営が非表示化・削除することがある旨が書かれている", () => {
    expect(source).toContain("運営が非表示化・削除することがあります");
  });
});

describe("措置の操作面が Phase 1 の画面に存在する（警告1点目）", () => {
  test("アップロード画面が一覧コンポーネントを描画している", () => {
    const source = read(UPLOAD_PAGE);
    expect(source).toContain("<MediaModerationList");
    expect(source).toContain("moderate={moderateMediaAction}");
  });

  test("Server Action が非表示化・公開へ戻す・削除の3操作を受け取る", () => {
    const source = read(UPLOAD_ACTIONS);
    for (const action of ["hide", "unhide", "delete"]) {
      expect(source).toContain(`"${action}"`);
    }
  });
});

describe("判定をクライアントへ持ち出さない", () => {
  const list = readCode(MODERATION_LIST);

  test("一覧コンポーネントがロールを受け取らない", () => {
    // ロールを渡すと、クライアントで書き換えれば操作が出てしまう。
    // 出せる操作はサーバ側（`listModerationOffers()`）が決めた結果だけを渡す。
    expect(list).not.toContain("actorRole");
    expect(list).not.toContain("role:");
  });

  test("一覧コンポーネントが判定関数を呼ばない", () => {
    expect(list).not.toContain("decideModeration");
    expect(list).not.toContain("listModerationOffers");
  });

  test("画面側はサーバで判定してから渡している", () => {
    expect(read(UPLOAD_PAGE)).toContain("listModerationOffers({");
  });
});

describe("認可の実体は RLS である（v13 §5.11.2 ／ CLAUDE.md §3.2）", () => {
  test("メディアの読み書きに service_role を使わない", () => {
    const store = readCode(MEDIA_STORE);
    expect(store).not.toContain("createAdminSupabaseClient");
    expect(store).toContain("createServerSupabaseClient");
  });

  test("物理削除の経路を持たない（論理削除だけ）", () => {
    const store = readCode(MEDIA_STORE);
    expect(store).not.toContain(".delete()");
    expect(store).toContain("deleted_at");
    expect(store).toContain("deleted_by");
  });

  test("措置した人を必ず記録する", () => {
    // `0027` の CHECK が「`deleted_at` があるなら `deleted_by` も要る」を強制している。
    expect(read(UPLOAD_ACTIONS)).toContain("deletedBy: viewer.memberId");
  });
});

describe("アップロード画面は全ロールへ開いている（v13 §5.11.7 ①）", () => {
  const roles: Role[] = ["admin", "core_member", "member", "guest"];

  for (const role of roles) {
    test(`${role} のナビにアップロードが出る`, () => {
      const paths = visibleAreasFor(role).map((area) => area.path);
      expect(paths).toContain("/upload");
    });
  }
});
