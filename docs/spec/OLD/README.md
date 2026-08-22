---
title: OLD（旧版アーカイブ）
doc_type: 索引
status: 運用中
owner: プロジェクトオーナー
date: 2026-08-22
updated: 2026-08-22
tags: ["浮遊街アプリ", "アーカイブ", "旧版"]
---

# OLD — 旧版アーカイブ

> [!danger] ⛔ ここは**参照専用**です。この配下を根拠に実装判断をしてはいけません
> `CLAUDE.md` §1.3 の規定に基づき、版として更新された／無効化されたドキュメントを
> **削除せずに退避**する場所です。「なぜその設計を捨てたか」を追跡するためだけに存在します。

## 運用ルール（`CLAUDE.md` §1.3）

1. ファイル名は `YYYY-MM-DD_旧ファイル名_OLD.md`（日付は **OLD へ移した日**）
2. 冒頭に「このファイルは旧版。現行版は `<パス>`」の注記を必ず入れる
3. Obsidian のウィキリンク衝突を避けるため、**末尾に `_OLD` を付ける**
4. **Google Drive のサイトマップには載せない**（`docs/SITEMAP.md` の対象外）

## アーカイブ一覧

| 退避日 | ファイル | 旧の場所 | 廃止理由 | 現行版 |
|---|---|---|---|---|
| 2026-08-22 | `2026-08-22_RAGシステム仕様_OLD.md` | `basic-design/ai-rag/` | pgvector を本体に持つ前提が 2026-08-16 に全面無効化（正本 §9 #31） | [[Projects/fuyuugai-app/docs/RAG基盤_line-rag-bot概要.md\|RAG基盤 / line-rag-bot 概要]] ／ [[Projects/line-rag-bot/docs/08-浮遊街RAG詳細設計.md\|08-浮遊街RAG詳細設計]] |
| 2026-08-22 | `2026-08-22_ナレッジ登録UIコンポーネント_KnowledgeRegistrationForm_OLD.md` | `docs/spec/` 直下 | 「アプリ側にナレッジ登録UIは作らない」と確定済み（§9 #31）。実装されない機能の参照実装（React 560行） | 登録経路は line-rag-bot の **Streamlit 管理画面のみ** |
| 2026-08-22 | `2026-08-22_line-rag-bot_浮遊街統合設計の考慮事項_OLD.md` | `docs/spec/` 直下 | どこからもリンクされない孤児ノート（§1.2 違反）。撤回済みの「アプリ内ナレッジ登録UI」記述を含む。未決事項は `QUESTIONS.md` へ移管済み | [[Projects/fuyuugai-app/docs/RAG基盤_line-rag-bot概要.md\|RAG基盤 / line-rag-bot 概要]] ／ [[Projects/fuyuugai-app/QUESTIONS.md\|QUESTIONS.md]] |

> [!note] スタブを残しているケース
> `basic-design/ai-rag/RAGシステム仕様.md` は**12件のリンク元がある**ため、
> 全文を OLD へ退避したうえで、元の場所には**現行版への転送スタブ**を置いています。
> リンクを切らずに旧内容を流通から外すための措置です。
