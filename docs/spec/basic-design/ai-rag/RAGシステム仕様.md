---
title: RAGシステム仕様
doc_type: リダイレクト
status: 廃止（現行版へ転送）
owner: プロジェクトオーナー
date: 2026-08-08
updated: 2026-08-22
supersedes: OLD/2026-08-22_RAGシステム仕様_OLD.md
tags: ["浮遊街", "RAG", "AI", "廃止"]
---

# RAGシステム仕様（このノートは廃止されました）

> [!danger] ⚠️ **廃止の根拠が 2026-09-11 に反転した（読む前に必ず確認すること）**
> 本ノートを廃止した根拠は「**pgvector を浮遊街アプリ本体に持たない**」という 2026-08-16 の決定だった。
> **2026-09-11 のオーナー決定でこの前提は反転し、ベクトル基盤は Supabase pgvector へ一本化された**
> （v13 §9 #31 限定改訂・v1.26.0 ／ `CONSOLIDATED_DECISIONS.md` §17）。
> 2026-08-16 の却下理由は「無料枠 DB 500MB 制約」であり、**2026-09-08 の有料プラン決定で失効していた**。
>
> | 本ノート内の記述 | 2026-09-11 以降 |
> | --- | --- |
> | 本体に pgvector を持つのは ❌ 破棄 | **✅ 採用**。アプリと浮遊街コンシェルジュが同一のベクトル空間 `public.knowledge_chunks` を共有する |
> | ベクトル基盤は `line-rag-bot`（Firestore）のみ | Firestore は bot の**会話履歴・エスカレーション・テナント設定のみ** |
>
> ⚠️ **`supabase/migrations/0100_rag_pgvector_knowledge_chunks.sql` を「不要」と判断して削除しないこと。**
> 同ファイルは §17 の決定に基づく実装である。
>
> **本スタブを廃止解除するか作り直すかの判断は未了**（§17 が「⚠️ 未反映」として明記）。
> それまでは、以下の内容を**この警告を通して**読むこと。

> [!danger] ⛔ このノートは**廃止**されました。ここを根拠に実装判断をしないでください
> 本ノートの内容は **pgvector を浮遊街アプリ本体に持つ前提**で書かれており、
> **2026-08-16 のオーナー最終判断（正本 v13 §9 #31）で全面的に無効化**されています。
>
> - 全文は [[Projects/fuyuugai-app/docs/spec/OLD/2026-08-22_RAGシステム仕様_OLD.md|OLD/2026-08-22_RAGシステム仕様_OLD]] に退避しました（**参照専用**）
> - このファイルは、既存の12件のリンクを切らないための**転送用スタブ**です

## 🧭 現行版はこちら

| 知りたいこと | 現行の正本 |
|---|---|
| **RAG基盤の全体像**（アーキテクチャ・ロール接点・実装状況・既知の制限） | [[Projects/fuyuugai-app/docs/RAG基盤_line-rag-bot概要.md\|RAG基盤 / line-rag-bot 概要]] |
| **RAG の詳細設計**（レシピ／道具マスタ・失敗パターン・エスカレーション） | [[Projects/line-rag-bot/docs/08-浮遊街RAG詳細設計.md\|line-rag-bot / 08-浮遊街RAG詳細設計]] |
| **実装の進捗・残タスク** | [[Projects/line-rag-bot/IMPLEMENTATION_STATUS.md\|line-rag-bot / IMPLEMENTATION_STATUS]] |
| **アプリ側から見た連携仕様** | [[Projects/fuyuugai-app/docs/spec/detailed-design/外部連携設計.md\|外部連携設計]] |
| **決定の根拠**（pgvector を一度捨て、2026-09-11 に戻した経緯） | 正本 v13 §9 #31 ／ [[Projects/fuyuugai-app/docs/spec/CONSOLIDATED_DECISIONS.md\|CONSOLIDATED_DECISIONS]] §17 |

## ⚠️ 特に無効になった記述

旧ノートに書かれていた次の内容は、**いずれも実装してはいけません**。

| 旧ノートの記述 | 現在の確定方針 |
|---|---|
| 浮遊街アプリ本体に pgvector でベクトルDBを持つ | 🔄 **2026-09-11 に反転（冒頭の警告を参照）**。~~❌ 破棄。ベクトル基盤は `line-rag-bot`（Firestore）のみ~~ → **✅ 採用。Supabase pgvector へ一本化**（`CONSOLIDATED_DECISIONS.md` §17） |
| アプリ内にナレッジ登録画面（4ステップフォーム）を作る | ❌ 作らない。登録経路は **Streamlit 管理画面のみ**。アプリ側は外部リンクを置くだけ |
| アプリから line-rag-bot API へ送信する | ❌ **API連携は一切実装しない**（読み取り専用APIも含む） |
| アプリ内 AI チャットUI（コンシェルジュ）を持つ | ❌ 持たない。エンドユーザーへの AI 応答は **LINE に一本化** |
| `target_role` は4値（guest/member/core_member/admin） | 🔄 **LINE 側は2値**（`guest`/`member`）へ統合。アプリ側は5値のまま（非対称は意図的／正本 v13 §2） |

> [!note] なお「まだ生きている」内容もあります
> 旧ノートのうち**レシピマスタ・道具マスタ・失敗パターン・業務ドメイン別ナレッジ設計・エージェント別ルーティング**の
> 考え方自体は破棄されていません。ただし**実装先が `line-rag-bot` 側に移った**ため、
> 現行の記述は [[Projects/line-rag-bot/docs/08-浮遊街RAG詳細設計.md\|08-浮遊街RAG詳細設計]] を参照してください。
