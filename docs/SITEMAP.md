---
title: 浮遊街プロジェクト ドキュメント・サイトマップ
description: 全ドキュメントの所在と役割の一覧。Google Drive 配布用の唯一の入口
doc_type: 索引
status: 運用中
owner: プロジェクトオーナー
date: 2026-08-22
updated: 2026-08-22
tags:
  - 浮遊街アプリ
  - line-rag-bot
  - サイトマップ
  - 索引
---

# 浮遊街プロジェクト ドキュメント・サイトマップ

**最終更新: 2026-08-22**

このページは、浮遊街プロジェクトの**全ドキュメントの所在と役割**を1枚にまとめた案内図です。

**このファイルは Google Drive にも置かれます。** そのため次のルールで書かれています。

- リンクはすべて **GitHub の絶対URL**（Obsidian の `[[wikilink]]` は Drive で機能しないため使いません）
- **Mermaid 図を使いません**（Drive のプレビューでは描画されないため）
- Obsidian・GitHub・Google Drive の**どこで開いても同じように読めます**

> **2つのリポジトリはどちらも public（全世界に公開）です**
>
> - `fuyuugai-app` — https://github.com/KoshiNakano1017/Fuyu
> - `line-rag-bot` — https://github.com/KoshiNakano1017/line-rag-bot
>
> したがって、本ページのリンクは **GitHub アカウントが無くても開けます。**
> Drive でこのページを共有すれば、相手はそのまま全ドキュメントを読めます。
>
> **同時に、これは「push した内容は誰でも読める」ということでもあります。**
> 一度 push した情報は、後から削除しても private 化しても取り消せません
> （既にクローン・キャッシュされた分が残るため）。
> **コミット前に気づけなければ手遅れ**という前提で運用してください。
> 禁止事項は各リポジトリの `CLAUDE.md`（機密情報の節）にあります。

---

## 0. 目的別クイックアクセス

**「今なにをしたいか」から入るための早見表です。**

| やりたいこと | 開くもの |
| --- | --- |
| **プロジェクトを10分で把握したい** | [オンボーディング資料](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/オンボーディング資料_新規メンバー向け概要.md) |
| **仕様の正解を確かめたい** | [総合要件定義・設計書 v13（正本）](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/浮遊街アプリ%20総合要件定義・設計書_v13.md) |
| **コードを書く前のルールを知りたい** | [CLAUDE.md（開発ルール正本）](https://github.com/KoshiNakano1017/Fuyu/blob/main/CLAUDE.md) |
| **「なぜそう決まったか」を知りたい** | [CONSOLIDATED_DECISIONS](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/CONSOLIDATED_DECISIONS.md) |
| **まだ決まっていないことを知りたい** | [QUESTIONS.md](https://github.com/KoshiNakano1017/Fuyu/blob/main/QUESTIONS.md) |
| **自分のタスクを探したい** | [WBS_Phase1](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/WBS_Phase1.md) / [TASKS.md](https://github.com/KoshiNakano1017/Fuyu/blob/main/TASKS.md) |
| **RAG / LINEボットを触りたい** | [RAG基盤 / line-rag-bot 概要](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/RAG基盤_line-rag-bot概要.md) |

### 新規メンバーの読む順番

1. **オンボーディング資料**（本プロジェクトの地図）
2. **CLAUDE.md** §1・§3・§4（ドキュメント運用・機密情報・コーディング規約）
3. **正本 v13** §1〜§4 のみ（§5 以降は必要な章を都度引く）
4. **QUESTIONS.md**（未回答の論点。**勝手に確定扱いしない**）
5. 自分の担当領域の設計書（→ 本ページ §3）

---

## 1. ドキュメントの分類（この体系の読み方）

すべてのドキュメントは、**役割**によって次の8層のどれか1つに属します。重複はありません。

| 層 | 役割 | 答える問い |
| --- | --- | --- |
| **A. 入口** | 案内・索引 | どこに何がある？ |
| **B. 規範** | ルールと正本 | 何が正しい？ |
| **C. 要件** | What | 何を作る？ |
| **D. 設計** | How | どう作る？ |
| **E. 計画・進捗** | When / Who | いつ、誰が？ |
| **F. 決定・未決** | Why | なぜそう決めた？何が未決？ |
| **G. 一次資料** | 出典 | 元ネタは？（**読むだけ・編集しない**） |
| **H. アーカイブ** | 廃棄済み | 何を捨てた？（**参照専用・本ページ非掲載**） |

**迷ったときの原則**

- **記述が食い違ったら、常に「正本」が勝ちます**（B層）。他のドキュメントを正本に合わせて直します
- **仕様の正本は `docs/spec/` 配下のみ**。ボルト内の他の場所に仕様書を置きません
- **未回答の論点（F層）を、勝手に確定事項として扱いません**

---

## 2. A層：入口・索引

| ドキュメント | 役割 | 対象読者 |
| --- | --- | --- |
| **[SITEMAP.md（本書）](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/SITEMAP.md)** | 全ドキュメントの所在。**Drive 配布用の唯一の入口** | 全員 |
| [オンボーディング資料_新規メンバー向け概要](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/オンボーディング資料_新規メンバー向け概要.md) | プロジェクト全体像を10分で把握。5つの柱・スケジュール・リスク・初日の行動 | 新規参画者 全員 |
| [浮遊街アプリ 統合ナレッジベース (Master Index)](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/浮遊街アプリ%20統合ナレッジベース%20%28Master%20Index%29.md) | 仕様の章立てと子ノートへの入口（**Obsidian 内での回遊用**） | 仕様を書く人 |
| [line-rag-bot / docs/README](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/README.md) | line-rag-bot 側ドキュメントの索引 | AI/RAG 担当 |

> **A層の使い分け**
> **Drive から入る人は本書**、**Obsidian で仕様を回遊する人は Master Index**、
> **プロジェクトを理解したい人はオンボーディング資料**。3つは競合せず役割が違います。

---

## 3. B層：規範（ルールと正本）

**この2つが最上位です。他のすべてはこれに従います。**

| ドキュメント | 役割 | 更新時の注意 |
| --- | --- | --- |
| [CLAUDE.md](https://github.com/KoshiNakano1017/Fuyu/blob/main/CLAUDE.md) | **開発ルールの正本**。ドキュメント運用・機密情報・コーディング規約・Git・CI/CD | ルールを書く場所は**このファイル1箇所のみ** |
| [浮遊街アプリ 総合要件定義・設計書_v13](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/浮遊街アプリ%20総合要件定義・設計書_v13.md) | **仕様の正本**。全ての判断の最終根拠（2,243行） | 改訂したら**末尾の改訂履歴に1行追加**する |
| [line-rag-bot / CLAUDE.md](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/CLAUDE.md) | line-rag-bot 側の開発ルール | ロール定義は**先に v13 §2 を改訂**してから追従させる |

---

## 4. C層：要件（何を作るか）

すべて `docs/spec/requirements/` 配下。

| ドキュメント | 内容 |
| --- | --- |
| [プロジェクトの背景と目的](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/プロジェクトの背景と目的.md) | なぜこのプロジェクトが必要か |
| [機能要件定義](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/機能要件定義.md) | 機能の一覧と優先度 |
| [クエストシステム仕様](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/クエストシステム仕様.md) | 柱② クエスト制 |
| [朝会議事録自動生成システム仕様](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/朝会議事録自動生成システム仕様.md) | 柱① 運営オペレーションの自動化 |
| [Uii経済圏とeumo連携](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/Uii経済圏とeumo連携.md) | 柱④ 注文・会計と地域通貨 |
| [カフェメニュー](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/カフェメニュー.md) | メニューマスタの実データ要件 |
| [業務カテゴリ体系とAIエージェント設計](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/業務カテゴリ体系とAIエージェント設計.md) | 全15業務ドメインとAIエージェント構想 |
| [gap_analysis_hotel_fb](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/requirements/gap_analysis_hotel_fb.md) | 宿泊・飲食の業界標準とのギャップ分析 |

---

## 5. D層：設計（どう作るか）

### 5-1. 基本設計 `docs/spec/basic-design/`

| 領域 | ドキュメント | 内容 |
| --- | --- | --- |
| frontend | [UI_UX設計指針](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/frontend/UI_UX設計指針.md) | 画面設計の原則・摩擦ゼロUI |
| frontend | [HTMLモック_v13](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/frontend/HTMLモック_v13.md) | 画面モック |
| backend | [会員データモデル_ユーザーテーブル定義](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/backend/会員データモデル_ユーザーテーブル定義.md) | **会員スキーマの正**（実データ準拠・7テーブル構成） |
| backend | [ER図_概念データモデル](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/backend/ER図_概念データモデル.md) | **概念**レベルのエンティティ整理 |
| infra | [システムアーキテクチャ](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/infra/システムアーキテクチャ.md) | 全体構成・技術スタック |
| infra | [FEL連携アーキテクチャ](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/infra/FEL連携アーキテクチャ.md) | Phase 3 の FEL 連携構想 |
| ai-rag | [RAGシステム仕様](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/ai-rag/RAGシステム仕様.md) | ⛔ **廃止・転送スタブ**。現行版は §7 を参照 |

### 5-2. 詳細設計 `docs/spec/detailed-design/`

| ドキュメント | 内容 |
| --- | --- |
| [画面設計](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/detailed-design/画面設計.md) | 全画面の仕様とロール別表示制御 |
| [API設計](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/detailed-design/API設計.md) | エンドポイント定義 |
| [DB物理設計](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/detailed-design/DB物理設計.md) | **カラム定義・型・制約の正**。RLS ポリシー |
| [外部連携設計](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/detailed-design/外部連携設計.md) | line-rag-bot・LINE・eumo・Googleフォームとの連携 |
| [非機能要件詳細](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/detailed-design/非機能要件詳細.md) | 性能・セキュリティ・可用性 |

### 5-3. 図（`docs/spec/` 直下）

| ドキュメント | 内容 |
| --- | --- |
| [データモデル図_ER_Diagram](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/データモデル図_ER_Diagram.md) | **論理**データモデル（Mermaid ER図） |
| [ユースケース図_Usecase_Diagram](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/ユースケース図_Usecase_Diagram.md) | アクター別ユースケース |

> **ER図が3つある理由（混同しないこと）**
> **概念**＝[ER図_概念データモデル](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/backend/ER図_概念データモデル.md)（エンティティの洗い出し） →
> **論理**＝[データモデル図_ER_Diagram](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/データモデル図_ER_Diagram.md)（リレーション可視化） →
> **物理**＝[DB物理設計](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/detailed-design/DB物理設計.md)（**実装はこれに従う**）。
> 会員まわりだけは [会員データモデル_ユーザーテーブル定義](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/basic-design/backend/会員データモデル_ユーザーテーブル定義.md) が正です。

---

## 6. E層：計画・進捗

| ドキュメント | 内容 | 更新頻度 |
| --- | --- | --- |
| [WBS_Phase1](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/WBS_Phase1.md) | Phase 1 のタスク分解（45パッケージ）と進捗 | 随時 |
| [TASKS.md](https://github.com/KoshiNakano1017/Fuyu/blob/main/TASKS.md) | 作業中タスクの分割管理 | 随時 |
| [LOOP_LOG.md](https://github.com/KoshiNakano1017/Fuyu/blob/main/LOOP_LOG.md) | 調査メモ・作業ログの追記先 | 随時 |
| [line-rag-bot / IMPLEMENTATION_STATUS](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/IMPLEMENTATION_STATUS.md) | **RAG 側の進捗の正本**・残タスク・既知の制限 | 随時 |
| [line-rag-bot / TASKS.md](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/TASKS.md) | RAG 側のタスク | 随時 |
| [line-rag-bot / LOOP_LOG.md](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/LOOP_LOG.md) | RAG 側の作業ログ | 随時 |

---

## 7. F層：決定・未決

| ドキュメント | 役割 | 使い方 |
| --- | --- | --- |
| [CONSOLIDATED_DECISIONS](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/CONSOLIDATED_DECISIONS.md) | **確定方針の索引**。意思決定ログを兼ねる | 「なぜそう決めたか」はここ。決定を覆すときは**取り消し線**で残す |
| [QUESTIONS.md](https://github.com/KoshiNakano1017/Fuyu/blob/main/QUESTIONS.md) | **未決事項**。人間への確認待ち | 仕様の矛盾を見つけたら**推測で実装せず**ここへ起票して `BLOCKED` にする |

---

## 8. RAG / line-rag-bot（柱⑤）

**浮遊街アプリ本体と line-rag-bot は API 連携しません。** 結合点は管理画面からの外部リンクのみです。

| ドキュメント | 内容 |
| --- | --- |
| **[RAG基盤 / line-rag-bot 概要](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/RAG基盤_line-rag-bot概要.md)** | **まずここ**。位置づけ・アーキテクチャ・ロール接点・実装状況・既知の制限 |
| [08-浮遊街RAG詳細設計](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/08-浮遊街RAG詳細設計.md) | レシピ／道具マスタ・失敗パターン・エスカレーションの詳細設計 |
| [01-仕様](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/01-仕様.md) | 機能・API・RAG・環境変数 |
| [02-構成図](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/02-構成図.md) / [03-データフロー図](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/03-データフロー図.md) / [04-インフラ構成図](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/04-インフラ構成図.md) / [05-ユースケース図](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/05-ユースケース図.md) | 各種図 |
| [06-マルチテナント設計](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/06-マルチテナント設計.md) | Firestore 構造・feature_flags |
| [07-ブランチ戦略](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/07-ブランチ戦略.md) | クライアント別ブランチを作らない理由 |
| [09-初期ナレッジ登録候補と出典](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/09-初期ナレッジ登録候補と出典.md) | 初期ナレッジの供給源 |
| [10-現場ヒアリングシート](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/docs/10-現場ヒアリングシート.md) | ナレッジ収集用 |

### 運用手順書

| ドキュメント | 用途 |
| --- | --- |
| [README](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/README.md) | セットアップ・管理画面の使い方 |
| [DEPLOY.md](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/DEPLOY.md) | Cloud Run へのデプロイ手順 |
| [KNOWLEDGE_REGISTRATION_GUIDE](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/KNOWLEDGE_REGISTRATION_GUIDE.md) | ナレッジ登録の運用手順 |
| [INITIAL_KNOWLEDGE_DEPLOYMENT_GUIDE](https://github.com/KoshiNakano1017/line-rag-bot/blob/main/INITIAL_KNOWLEDGE_DEPLOYMENT_GUIDE.md) | 初期ナレッジ投入の手順 |

---

## 9. G層：一次資料（読むだけ・編集しない）

`docs/spec/background/` に **AI との会話ログ24件**が保存されています（2026-07-06 〜 2026-08-03）。
意思決定の根拠を追跡するための**一次資料**です。

- **編集しません。** 内容の訂正が必要な場合も、正本側を直します
- 会話ログの原本はボルト側 `AI-Conversations/06_浮遊街アプリ・FELプロジェクト/` にあります
- 一覧は [background/00_MOC](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/background/00_MOC_浮遊街アプリ・FELプロジェクト.md) を参照

---

## 10. H層：アーカイブ（本ページ非掲載）

`docs/spec/OLD/` に**廃止済みドキュメント**が退避されています。

**この配下を根拠に実装判断をしてはいけません。** 一覧と廃止理由は
[OLD/README](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/OLD/README.md) にあります。

**Google Drive へは配布しません。**

---

## 11. このサイトマップの保守ルール

> **ドキュメントを追加・移動・廃止したら、必ず本ページを更新してください。**

| 操作 | やること |
| --- | --- |
| **新規作成** | まず `CLAUDE.md` §1.2（新規ドキュメントを作らない原則）を再読し、既存への追記で済まないか検討する。作った場合は本ページの該当層へ追加し、Master Index にも登録する |
| **移動** | 本ページのURLを更新し、リンク元を全て張り替える |
| **廃止** | `docs/spec/OLD/YYYY-MM-DD_ファイル名_OLD.md` へ退避し、本ページから削除、OLD/README の一覧へ追加する。リンク元が多い場合は元の場所に**転送スタブ**を残す |
| **Drive 更新** | 本ページを再アップロードする。**Drive に置くのは本ページ1枚だけ**で、実体は GitHub 側を正とする |

**Drive に本ページ1枚だけを置く理由**: 実ドキュメントを Drive へミラーすると、
GitHub 側と Drive 側で**版がズレて「どちらが正か分からない」状態**になります。
過去に旧版が新版として参照される事故が起きているため、**実体は1箇所（GitHub）に固定**します。

---

**関連**: [オンボーディング資料](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/オンボーディング資料_新規メンバー向け概要.md) ／ [CLAUDE.md](https://github.com/KoshiNakano1017/Fuyu/blob/main/CLAUDE.md) ／ [Master Index](https://github.com/KoshiNakano1017/Fuyu/blob/main/docs/spec/浮遊街アプリ%20統合ナレッジベース%20%28Master%20Index%29.md)
