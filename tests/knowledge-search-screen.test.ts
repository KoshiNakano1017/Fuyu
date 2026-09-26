// 横断セマンティック検索のアプリ層・画面まわりの受入テスト（WBS 9-1 ／ v13 §9 #31）。
//
// 固定する完了条件:
//  1 ★ スコープをアプリ側で再実装しない（渡せるのはチャネルと件数だけ）
//  2 ★ チャネルは `app` に固定（フォーム・引数から `line` を渡せる口を作らない）
//  3 ★ 埋め込むのは伏字化後のテキスト（生テキストを埋め込まない）
//  4 検索は staff 限定（索引には Tier 2 が入っている）
//  5 エンドユーザー向け AI チャット UI にしない（§9 #31 は維持されている）
//  6 ナビへタブを足さない（v13 §5.9.5）
//  7 エラー文・ログへ検索語や本文を載せない（PII がログへ漏れる経路を作らない）
//
// なぜソースを文字列として読むのか:
//   「条件を足していない」「生テキストを渡していない」は**書かれていないこと**を固定する
//   条件であり、実行時の振る舞いでは捕まえにくい（CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AREAS } from "@/lib/auth/navigation";
import { similarityLabel, sourceTypeLabel } from "@/lib/knowledge/search";

import { SRC_DIR } from "./helpers/ai-sources";

const SEARCH = join(SRC_DIR, "lib", "knowledge", "search.ts");
const STORE = join(SRC_DIR, "lib", "knowledge", "projection-store.ts");
const ACTIONS = join(SRC_DIR, "app", "staff", "knowledge", "actions.ts");
const PAGE = join(SRC_DIR, "app", "staff", "knowledge", "page.tsx");
const COMPONENT = join(SRC_DIR, "components", "knowledge", "KnowledgeSearch.tsx");
const MIGRATION = join(SRC_DIR, "..", "supabase", "migrations", "0103_knowledge_projection.sql");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("★ スコープをアプリ側で再実装しない（§17-6 #5）", () => {
  const code = readCode(SEARCH);

  test("検索は DB 関数を呼ぶだけ（`knowledge_chunks` を直接読まない）", () => {
    // 直接読むと Tier・公開範囲・削除追随の条件を自分で書くことになり、
    // 「スコープが2箇所にある」状態になる。片方だけ直したとき広い方が勝つ。
    expect(code).toContain('supabase.rpc("search_knowledge"');
    expect(code).not.toContain('from("knowledge_chunks")');
  });

  test("★ Tier・公開範囲・削除状態の条件を書いていない", () => {
    for (const forbidden of ["tier", "exportable_to_line", "source_deleted", "visibility"]) {
      // 戻り値の読み替え（`row.tier`）は許すが、絞り込みの条件としては現れない。
      expect(code).not.toContain(`.eq("${forbidden}"`);
    }
  });

  test("`public.search_knowledge` は条件を足さない薄いラッパである", () => {
    const sql = read(MIGRATION);
    const wrapper = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.search_knowledge"),
      sql.indexOf("COMMENT ON FUNCTION public.search_knowledge"),
    );
    expect(wrapper).toContain("RETURN QUERY SELECT * FROM rag.search_knowledge(");
    expect(wrapper).not.toContain("WHERE");
  });
});

describe("★ チャネルは `app` に固定する（§16-2 #61：判定軸はチャネル）", () => {
  test("検索モジュールが `app` を直接渡す", () => {
    expect(readCode(SEARCH)).toContain('p_channel: "app"');
  });

  test("★ 呼び出し側からチャネルを渡せない", () => {
    const code = readCode(SEARCH);
    // 引数は問い合わせ語と件数だけ。`channel` を受ける口が型に無いことを固定する。
    expect(code).toContain("params: { query: string; limit?: number }");
    expect(code).not.toContain("channel?:");
    expect(code).not.toContain("channel: string");
    // `line` を渡す経路をこの層に持たない（LINE 側は line-rag-bot が自分で指定する）。
    expect(code).not.toContain('"line"');
  });

  test("Server Action もチャネルをフォームから受け取らない", () => {
    expect(readCode(ACTIONS)).not.toContain('formData.get("channel")');
  });
});

describe("★ 埋め込むのは伏字化後のテキスト（§17-6 #6）", () => {
  const code = readCode(STORE);

  test("DB が返した `text_to_embed` を埋め込む", () => {
    expect(code).toContain("row.text_to_embed");
  });

  test("★ 生テキスト（`chunkText`）を埋め込みへ渡していない", () => {
    // 生を埋め込むと、本文は伏字なのにベクトルだけが PII を含む状態になる。
    const pushLine = code.slice(code.indexOf("pending.push("), code.indexOf("pending.push(") + 200);
    expect(pushLine).not.toContain("chunkText");
  });

  test("`blocked` のチャンクには埋め込みを付けない", () => {
    expect(code).toContain('row.scan_status === "blocked"');
  });

  test("走査より先に埋め込みを付けない（RPC が2段に分かれている）", () => {
    expect(code.indexOf('rpc("upsert_knowledge_chunk"')).toBeLessThan(
      code.indexOf('rpc("set_knowledge_chunk_embedding"'),
    );
  });
});

describe("検索は staff 限定（索引には Tier 2 が入っている ／ v13 §5.9.3）", () => {
  test("Server Action が `isStaff()` を通す", () => {
    expect(readCode(ACTIONS)).toContain("isStaff(viewer.role)");
  });

  test("画面が `requireStaff()` を通る", () => {
    expect(readCode(PAGE)).toContain("requireStaff()");
  });

  test("DB 側の入口は `service_role` だけに GRANT する", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION public.search_knowledge");
    expect(sql).toContain("GRANT  EXECUTE ON FUNCTION public.search_knowledge");
    expect(sql).toContain("TO service_role");
  });
});

describe("★ エンドユーザー向け AI チャット UI にしない（v13 §9 #31 は維持）", () => {
  const component = readCode(COMPONENT);

  test("会話の体裁を持たない（吹き出し・履歴・追問を作らない）", () => {
    for (const forbidden of ["messages", "conversation", "assistant", "chatHistory"]) {
      expect(component).not.toContain(forbidden);
    }
  });

  test("入力は語句1つだけ", () => {
    expect(component).toContain('name="query"');
  });

  test("類似度を数字で見せる（遠いものを運営が判断できる）", () => {
    expect(component).toContain("similarityLabel(");
  });

  test("★ 閾値で切って隠さない（何が切られたか分からない状態を作らない）", () => {
    expect(component).not.toContain("similarity >");
    expect(component).not.toContain("similarity <");
  });
});

describe("出すのは伏字化後の本文だけ（`0100`）", () => {
  test("画面は `chunkText` を出し、投影元を引き直さない", () => {
    const component = readCode(COMPONENT);
    expect(component).toContain("hit.chunkText");
    expect(component).not.toContain("fetchMedia");
    expect(component).not.toContain("transcript");
  });

  test("種別は日本語の表示名へ直す（内部識別子を出さない ／ CLAUDE.md §4.1）", () => {
    expect(sourceTypeLabel("morning_meeting")).toBe("朝会議事録");
    expect(sourceTypeLabel("media")).toBe("写真・動画");
  });

  test("類似度は百分率で読める形にする", () => {
    expect(similarityLabel(0.8123)).toBe("81%");
  });
});

describe("ナビへタブを足さない（v13 §5.9.5）", () => {
  test("既存の `/staff/knowledge` に同居させる", () => {
    const paths = AREAS.map((area) => area.path);
    expect(paths).toContain("/staff/knowledge");
    expect(paths).not.toContain("/staff/knowledge/search");
  });

  test("画面に検索が載っている", () => {
    expect(readCode(PAGE)).toContain("<KnowledgeSearch />");
  });
});

describe("★ 検索語・本文をエラー文へ載せない（CLAUDE.md §3.2）", () => {
  test("検索の例外にクエリを入れない", () => {
    const code = readCode(SEARCH);
    const thrown = code.slice(code.indexOf("検索に失敗しました"), code.indexOf("検索に失敗しました") + 120);
    expect(thrown).not.toContain("query");
  });

  test("投影の例外に本文を入れない", () => {
    const code = readCode(STORE);
    const thrown = code.slice(code.indexOf("チャンクの投影に失敗しました"));
    expect(thrown.slice(0, 200)).not.toContain("chunkText");
  });

  test("Server Action は例外の中身を画面へ出さない", () => {
    const actions = readCode(ACTIONS);
    expect(actions).toContain("} catch {");
    expect(actions).not.toContain("String(error)");
  });
});
