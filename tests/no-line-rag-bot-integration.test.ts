// 「アプリ側に実装しない」ことの受入テスト
// （WBS `9-2` line-rag-bot管理画面への導線（外部リンクのみ）／ Issue #94）。
//
// 固定する完了条件:
//   完了条件5 アプリ側にナレッジ登録フォーム・エスカレーション一覧・line-rag-bot API 呼び出しが
//             存在しない（v13 §9 #31 ／ v13 §5.7.5 の 2026-08-16 再確定の注記 ／
//             `外部連携設計.md` §2-2「Phase 1 では両者の間に API 連携は存在しない」）
//
// これは**書かれていないこと**を固定する条件である。実装が「ついでに」フォームや API 呼び出しを
// 足しても、画面を開いただけでは誰も気づけない。Phase 2 で正式に解禁されるまで機械で押さえる
// （`docs/spec/CONSOLIDATED_DECISIONS.md`「Phase 1 の姿は不変（結合点は外部リンクのみ）」）。

import {
  findSrcFilesMatching,
  findSrcPathsMatching,
  readStaffKnowledgePage,
} from "./helpers/concierge-sources";

describe("ナレッジ登録フォームを持たない（v13 §5.7.5 注記）", () => {
  test("/staff/knowledge のページにフォーム部品が1つも無い", () => {
    // 4ステップフォームは line-rag-bot（Streamlit）側で完結する。
    const page = readStaffKnowledgePage();
    const formElements = ["<form", "<input", "<textarea", "<select"].filter((tag) => page.includes(tag));
    expect(formElements).toEqual([]);
  });

  test("/staff/knowledge のページが fetch を1度も呼ばない", () => {
    // 外部リンク1つだけの画面であり、送信先もデータの越境も無い（画面設計.md §4 B9）。
    expect(readStaffKnowledgePage()).not.toContain("fetch(");
  });
});

describe("line-rag-bot への API 連携を持たない（v13 §9 #31 ／ 外部連携設計.md §2-2）", () => {
  test("アプリのソースが line-rag-bot のエンドポイント設定を読まない", () => {
    // `.env.example` の `LINE_RAG_BOT_ENDPOINT` / `LINE_RAG_BOT_API_KEY` は
    // コメントアウトされた `[P2]`（Phase 2）の予約であり、Phase 1 では誰も読まない。
    expect(findSrcFilesMatching(/LINE_RAG_BOT_/)).toEqual([]);
  });
});

describe("未回答エスカレーション一覧を持たない（v13 §9 #31 ／ 画面設計.md §4 C5）", () => {
  // 日本語の地の文（「エスカレーション一覧はアプリ側に実装しない」という根拠コメント）まで
  // 禁じると意図を書けなくなるため、実装の痕跡である ASCII の識別子・パスだけを見る。
  test("エスカレーション一覧の画面・ルートがアプリに無い", () => {
    expect(findSrcPathsMatching(/escalation/i)).toEqual([]);
  });

  test("エスカレーションを扱う識別子がアプリのソースに無い", () => {
    expect(findSrcFilesMatching(/\bescalations?\b/i)).toEqual([]);
  });
});
