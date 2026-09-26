// 投影の判断（WBS 9-1 ／ `src/lib/knowledge/projection.ts`）の単体テスト。
//
// 固定する完了条件:
//  1 Tier の割り当て（クエストだけが Tier 1。写真・議事録・作業ログは Tier 2）
//  2 チャンク分割は段落の途中で切らない／1段落が長すぎるときだけ文字数で割る
//  3 差分検知のハッシュは空白の揺れで変わらない（毎回再埋め込みしない）
//  4 LINE 書き出し可否は Tier・走査状態・公開範囲の3つが揃ったときだけ true
//  5 投影元の値域に運営メモ・会員の連絡先が入っていない
//
// ⚠️ ここは「LINE へ何が出るか」を決める判断を含む。Tier 2（個人に紐づく実績）が
//    Tier 1 へ混ざると、`0102` の LINE 経路の条件を通ってしまう。

import {
  CHUNK_MAX_CHARS,
  KNOWLEDGE_SOURCE_TYPES,
  contentHashOf,
  isExportableToLine,
  splitIntoChunks,
  tierFor,
} from "@/lib/knowledge/projection";

describe("Tier の割り当て（`0100` の定義）", () => {
  test("クエストは Tier 1（やり方の知識であって個人の実績ではない）", () => {
    expect(tierFor("quest")).toBe(1);
  });

  test.each(["media", "morning_meeting", "work_log"] as const)(
    "★ %s は Tier 2（誰が何をしたかが本文に残る）",
    (sourceType) => {
      expect(tierFor(sourceType)).toBe(2);
    },
  );
});

describe("投影元の値域（§17-6 #6「危うい情報」は索引へ入れない）", () => {
  test("4値だけである", () => {
    expect([...KNOWLEDGE_SOURCE_TYPES]).toEqual(["media", "morning_meeting", "work_log", "quest"]);
  });

  test("★ 運営メモ・会員の連絡先が入っていない", () => {
    const values: readonly string[] = KNOWLEDGE_SOURCE_TYPES;
    expect(values).not.toContain("member_note");
    expect(values).not.toContain("member_identifier");
    expect(values).not.toContain("member_profile");
  });
});

describe("チャンク分割は段落の途中で切らない", () => {
  test("短い本文は1チャンク", () => {
    expect(splitIntoChunks("薪を割って乾かす")).toEqual(["薪を割って乾かす"]);
  });

  test("空行区切りの段落を束ねる（上限に収まるなら1チャンク）", () => {
    expect(splitIntoChunks("前半の説明\n\n後半の説明")).toEqual(["前半の説明\n\n後半の説明"]);
  });

  test("★ 上限を超えたら段落の境目で次のチャンクへ送る", () => {
    const paragraph = "あ".repeat(60);
    const chunks = splitIntoChunks(`${paragraph}\n\n${paragraph}`, 100);
    expect(chunks).toEqual([paragraph, paragraph]);
  });

  test("★ 1段落が単独で上限を超えるときだけ文字数で割る", () => {
    // 割らずに入れると埋め込みの入力上限に当たり、投影がそこで止まる。
    const chunks = splitIntoChunks("あ".repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });

  test("空白だけの段落は落とす（空チャンクを索引へ入れない）", () => {
    expect(splitIntoChunks("本文\n\n   \n\nつづき")).toEqual(["本文\n\nつづき"]);
  });

  test("本文が空なら0チャンク", () => {
    expect(splitIntoChunks("   ")).toEqual([]);
  });

  test("既定の上限は文字数で決めてある（日本語は1文字の情報量が大きい）", () => {
    expect(CHUNK_MAX_CHARS).toBe(800);
  });
});

describe("差分検知のハッシュ（`0100` の `content_hash`）", () => {
  test("同じ本文なら同じ値", () => {
    expect(contentHashOf("薪を乾かす")).toBe(contentHashOf("薪を乾かす"));
  });

  test("★ 前後の空白・改行の揺れでは変わらない（毎回再埋め込みしない）", () => {
    expect(contentHashOf("薪を乾かす")).toBe(contentHashOf("  薪を乾かす\n"));
  });

  test("本文が変われば変わる", () => {
    expect(contentHashOf("薪を乾かす")).not.toBe(contentHashOf("薪を割る"));
  });
});

describe("★ LINE 書き出し可否（`0100` の CHECK ＋ `0102` の LINE 条件の写し）", () => {
  const exportable = { tier: 1, scanStatus: "clean", visibility: "公開" } as const;

  test("Tier 1・走査通過・公開なら true", () => {
    expect(isExportableToLine(exportable)).toBe(true);
  });

  test("伏字化済みでも true（走査を通っていれば出せる）", () => {
    expect(isExportableToLine({ ...exportable, scanStatus: "redacted" })).toBe(true);
  });

  test("★ Tier 2 は false（個人に紐づく実績を LINE へ出さない）", () => {
    expect(isExportableToLine({ ...exportable, tier: 2 })).toBe(false);
  });

  test("★ 走査を通っていなければ false", () => {
    expect(isExportableToLine({ ...exportable, scanStatus: "pending" })).toBe(false);
    expect(isExportableToLine({ ...exportable, scanStatus: "blocked" })).toBe(false);
  });

  test("★ 「運営のみ」は false（Tier 1 でも出さない）", () => {
    expect(isExportableToLine({ ...exportable, visibility: "運営のみ" })).toBe(false);
  });
});
