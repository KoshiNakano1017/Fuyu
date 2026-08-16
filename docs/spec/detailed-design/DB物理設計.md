---
title: "詳細設計：DB物理設計（Phase 1）"
date: "2026-08-16"
status: "詳細設計ドラフト（要オーナーレビュー）"
up: "[[浮遊街アプリ 総合要件定義・設計書_v13]]"
---

# DB物理設計（Phase 1）

> 本書は正本 `docs/spec/浮遊街アプリ 総合要件定義・設計書_v13.md`（要件定義レベル）を一段階詳細化した
> **設計ドキュメント**である。**実際のマイグレーション適用・DBプロジェクトの作成は行っていない**（自律ループの
> 安全ルールにより、今回のサイクルではドキュメント作成のみ）。DDLは設計内容を明確にするための記述であり、
> 実装・適用はオーナー承認後に別途行うこと。
>
> 本書は以下2つの既存資料を土台として最大限再利用している（ゼロから書き起こしていない）。
> - `docs/spec/ER図_概念データモデル.md`（概念モデル。2026-08-16に本リポジトリへ取り込み済み）
> - `C:\Users\user\Documents\MyVault\Myvault\Knowledge\浮遊街アプリ\migration\01_schema.sql`
>   （会員まわりの物理スキーマ。**Vault側で実データ370名分の投入・検算まで完了済み**の高精度な既存設計。
>   このリポジトリへは未コピー・未コミットであり、あくまで参照のみ）

---

## 1. 設計方針・不可侵ルール

既存の会員系DDL（`01_schema.sql`）の設計方針を、DB全体の共通ルールとして踏襲する。

1. **残高・集計値の正本は取引明細**。マスタ側の残高カラム（`stay_tickets`／`total_stay_days`／`uii_balance`等）は**集計キャッシュ**であり、アプリからの直接UPDATEを禁止し、トリガーでのみ再計算する。
2. **認可は`role`のみで判定する**。`member_type`（親方／街人コア等）は表示・呼称専用であり、RLSポリシー・アプリの認可ロジックには使用しない（v13 §2）。
3. **失効・取消・キャンセルは行削除せず、必ずトランザクション（取引明細行）または論理削除（`cancelled_at`等）として計上する**。物理削除は監査証跡を失うため原則禁止。
4. **マスタ値のハードコード禁止**。宿泊券付与枚数・料金等は`membership_plans`のようなマスタテーブルを参照し、画面・コードに直書きしない（v13 §9 #15）。
5. 全テーブルで `created_at timestamptz NOT NULL DEFAULT now()` を基本とし、更新のあるテーブルには `updated_at` を付与する。
6. 主キーは `gen_random_uuid()`（`pgcrypto`拡張）による UUID を標準とする。

---

## 2. 会員まわり（既存物理設計・実データ検証済み）

Vault側 `migration/01_schema.sql` で既に設計・実装され、実データ（街びと327件＋親方衆44件、統合後370名）の
投入・検算まで完了している。本書では**そのまま採用**し、詳細はそちらを正とする。以下は本書の文脈で
参照するための要約。

| テーブル | 役割 | 特記事項 |
| --- | --- | --- |
| `members` | 会員マスタ | `role`／`member_type`／`account_status`を分離。残高3カラムは集計キャッシュ |
| `member_identifiers` | 名寄せキー（email/phone/line/discord） | 検証済み識別子のみ`(kind, value)`一意。未検証は重複許容 |
| `membership_plans` | 会員プランマスタ | 料金・付与泊数・付与Uii・権利期間をマスタ化（直書き禁止の担保） |
| `memberships` | 会員権 | 開始日・満了日・ステータス。親方衆44名には作成しない（宿泊券0泊） |
| `stay_ticket_transactions` | 宿泊券取引明細 | **Phase1で稼働する唯一の取引テーブル**。トリガーで`members.stay_tickets`等へ反映 |
| `uii_transactions` | Uii取引明細 | 定義のみ先行。Phase1では移行・稼働しない（個人残高管理はPhase2） |
| `member_notes` | 運営メモ | `core_only`/`admin_only`の可視性制御 |
| `check_ins` | チェックイン/アウト | 論理削除によるキャンセル・ノーショー対応（`cancelled_at`等） |
| `rooms` / `room_assignments` | 部屋台帳・部屋割当 | `capacity`保持、部屋移動は履歴として追加（物理上書きなし） |

検証済み実績（2026-08-15実行、Vault側）: `members` 370件／`memberships` 327件／`stay_ticket_transactions` 400件
（`initial_grant` 2,050泊／`consume` 266泊 → 未使用1,784泊）。この実績値はv13 §9 #14の経営報告用数値と整合する。

> [!warning] このリポジトリへの取り込みについて
> `01_schema.sql`・実データ（`03_seed_members.sql`）はオーナーのVault側にのみ存在し、本リポジトリ
> （`fuyuugai-app`）にはコピー・コミットしていない。実データ（会員個人情報）を含むため、リポジトリへの
> 取り込み要否・格納方法（`.gitignore`対象にする等）は別途オーナー判断が必要。

> [!note] 親方・街人リストの最終承認について
> 上記の370名という移行対象数は、Vault側で実際に投入・検算まで完了している（技術的には実行可能な状態）。
> ただし、この370名という重複統合結果（中野裕士氏の親方兼街人統合等）について**クライアントの正式な
> 最終承認が得られているかは、QUESTIONS.mdの「親方・街人リスト受領後の最終データレビューは完了しているか」
> が未回答のままである**。技術的な実行可能性と、業務上の最終承認は別軸である点に注意。

---

## 3. Phase 1で新規に物理設計が必要な領域（本書で新規提案）

会員まわり以外のPhase1機能領域には、まだDDLが存在しない。ER図_概念データモデル.md の概念エンティティと
v13 §7データ要件・WBS_Phase1.mdの各作業パッケージを突き合わせ、本書で物理設計を新規に提案する。
**未適用のドラフトであり、実装着手前にレビューを要する。**

### 3-1. クエスト管理（WBS §5：クエスト管理）

```sql
CREATE TABLE work_categories (
  category_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_no         integer NOT NULL,          -- 15業務ドメインの通し番号
  name              text NOT NULL,
  parent_category_id uuid REFERENCES work_categories(category_id),
  agent_type        text,                       -- ランド／ホスピタリティ／イベント等（[[業務カテゴリ体系とAIエージェント設計]]）
  rag_structure_type text CHECK (rag_structure_type IN ('recipe','judgment','regulation')),
  is_tenant_specific boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_work_category_parent ON work_categories (parent_category_id);

CREATE TABLE quests (
  quest_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL,
  description          text,
  category_id          uuid REFERENCES work_categories(category_id),
  difficulty            text,
  base_hours           numeric,
  recruit_count         integer NOT NULL DEFAULT 1,
  place_id              uuid,                    -- Place（拠点）参照。FEL共通スキーマ側のためFK制約なし
  origin_type           text NOT NULL DEFAULT 'manual'
                          CHECK (origin_type IN ('manual','morning_meeting_auto')),
  execution_mode         text NOT NULL DEFAULT 'onsite'
                          CHECK (execution_mode IN ('onsite','remote','hybrid')),
  required_certification text[],                 -- 重機／チェーンソー／食品衛生 等
  guest_allowed          boolean NOT NULL DEFAULT false,  -- ゲスト開放判定は本フラグのみで行う（カテゴリ等から自動導出しない）
  reward_uii             integer,
  status                 text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','closed','archived')),
  created_by             uuid REFERENCES members(member_id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_quest_status ON quests (status);
CREATE INDEX ix_quest_guest_allowed ON quests (guest_allowed) WHERE status = 'open';

CREATE TABLE quest_applications (
  application_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id           uuid NOT NULL REFERENCES quests(quest_id) ON DELETE CASCADE,
  member_id          uuid NOT NULL REFERENCES members(member_id),
  status             text NOT NULL DEFAULT '申請中'
                        CHECK (status IN ('申請中','承認','差戻し','完了','キャンセル')),
  applied_at         timestamptz NOT NULL DEFAULT now(),
  reviewed_by        uuid REFERENCES members(member_id),
  reviewed_at        timestamptz,
  reward_uii_actual  integer,      -- Phase1は募集人数内で均等割り（按分ロジックはPhase2）
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_quest_app_quest  ON quest_applications (quest_id);
CREATE INDEX ix_quest_app_member ON quest_applications (member_id);

CREATE TABLE work_logs (
  log_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL REFERENCES quest_applications(application_id) ON DELETE CASCADE,
  member_id          uuid NOT NULL REFERENCES members(member_id),
  quest_id           uuid NOT NULL REFERENCES quests(quest_id),
  worked_at          timestamptz NOT NULL DEFAULT now(),
  work_hours         numeric,
  before_photo_media_id uuid,      -- メディアアセット参照（§3-6）
  after_photo_media_id  uuid,
  notes              text,
  issue_flag         boolean NOT NULL DEFAULT false,   -- トラブル・失敗発生フラグ（RAG failure_patterns連携の起点）
  issue_note         text,
  approval_status    text NOT NULL DEFAULT '未承認'
                        CHECK (approval_status IN ('未承認','承認','差戻し')),
  approved_by        uuid REFERENCES members(member_id),
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_worklog_application ON work_logs (application_id);
CREATE INDEX ix_worklog_issue ON work_logs (issue_flag) WHERE issue_flag = true;
```

> [!note] Phase2送りの機能は物理設計に含めない
> クエストの反復実行・複数人按分・スキル連動報酬はPhase2送りで確定済み（QUESTIONS.md回答済み）。
> `quest_applications.reward_uii_actual` は「募集人数内で均等割り」というPhase1のシンプル運用のみを
> 前提にしており、按分ロジック用のカラムは意図的に持たせていない。

### 3-2. 注文管理・会計調整（WBS §6・§7・§8）

```sql
CREATE TABLE orders (
  order_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id         uuid NOT NULL REFERENCES check_ins(checkin_id),
  purchaser_id       uuid NOT NULL REFERENCES members(member_id),  -- チェックイン会員限定
  order_channel      text NOT NULL DEFAULT 'self'
                        CHECK (order_channel IN ('self','staff_proxy')),
  order_source       text NOT NULL DEFAULT 'cafe' CHECK (order_source IN ('cafe','shop')),
  status             text NOT NULL DEFAULT '未会計'
                        CHECK (status IN ('未会計','精算済み','取消')),
  total_amount_yen   integer NOT NULL DEFAULT 0,
  total_amount_uii   integer NOT NULL DEFAULT 0,   -- floor(単価×0.8)を明細行ごとに丸めて合算（伝票合計への一括掛け算は禁止）
  settled_at         timestamptz,
  settlement_qr_token text,
  created_by         uuid REFERENCES members(member_id),  -- 代理注文時の店員ID
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_order_purchaser ON orders (purchaser_id);
CREATE INDEX ix_order_status ON orders (status);

CREATE TABLE order_items (
  item_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_name       text NOT NULL,
  unit_price_yen     integer NOT NULL,
  unit_price_uii     integer NOT NULL,  -- floor(unit_price_yen * 0.8)
  quantity           integer NOT NULL DEFAULT 1,
  sold_out_at_order  boolean NOT NULL DEFAULT false,
  edited_by          uuid REFERENCES members(member_id),  -- 顧客管理画面からの手動編集者
  edit_reason        text,             -- 編集理由必須ルール（v13 §5.6.4）
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_order_item_order ON order_items (order_id);

-- 差額精算（v13 §5.6.6／§9 #7・#17）
CREATE TABLE settlement_adjustments (
  adjustment_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(order_id),
  amount_yen         integer NOT NULL,    -- + 追加請求 / - 返金
  amount_uii         integer NOT NULL DEFAULT 0,
  category            text NOT NULL CHECK (category IN ('追加請求','返金')),
  reason             text NOT NULL,
  status             text NOT NULL DEFAULT '未処理'
                        CHECK (status IN ('未処理','精算済み','免除')),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  settled_by         uuid REFERENCES members(member_id),
  waived_by          uuid REFERENCES members(member_id),  -- 免除操作者（権限範囲はQUESTIONS.md未回答）
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_settlement_adj_order  ON settlement_adjustments (order_id);
CREATE INDEX ix_settlement_adj_status ON settlement_adjustments (status) WHERE status = '未処理';
-- 90日滞留アラート用（v13 §5.6.6）
CREATE INDEX ix_settlement_adj_stale ON settlement_adjustments (occurred_at) WHERE status = '未処理';
```

> [!warning] オーナー確認待ち（QUESTIONS.md参照）
> `settlement_adjustments.waived_by` の**権限範囲**（管理者のみか、コアメンバーにも許すか）と、
> **90日滞留後の自動免除／督促の挙動**は、QUESTIONS.md「差額繰越（返金・免除運用）の詳細」が未回答のため
> 確定していない。上記DDLは「誰が免除したかを記録できる」構造のみを用意しており、免除権限のRLS制御・
> 自動処理バッチの仕様は別途確定後に設計する。

### 3-3. ナレッジ・RAG（pgvector）（WBS §9）

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_items (
  knowledge_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_format   text NOT NULL DEFAULT 'faq' CHECK (knowledge_format IN ('faq','manual')),
  category_id        uuid REFERENCES work_categories(category_id),
  agent_type         text,                         -- ホスピタリティ／ランド 等（Phase1は2系統のみ実装）
  target_role        text NOT NULL CHECK (target_role IN ('guest','member','core_member')),
  -- ▲ 単一値のアクセス制御キー（v13 §5.7.2・§5.7.5の確定仕様）。
  --   複数ロール同時公開を許す配列化案は§9 #29として未決（保留中の未コミットドラフトのみに存在）。
  --   正式決定が出るまで、本書は配列化を採用しない。
  question           text,
  answer             text,
  body               text,
  usage_scene        text[],
  keywords           text[],
  attachments        uuid[],                       -- メディアアセットID配列
  review_status      text NOT NULL DEFAULT 'draft'
                        CHECK (review_status IN ('draft','published','needs_review')),
  source_type        text NOT NULL DEFAULT 'manual'
                        CHECK (source_type IN ('manual','unanswered_log','morning_meeting','mobile_field')),
  created_by         uuid REFERENCES members(member_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_knowledge_target_role ON knowledge_items (target_role);
CREATE INDEX ix_knowledge_review_status ON knowledge_items (review_status);

-- チャンク単位のベクトル格納（1ナレッジが複数チャンクに分割される場合に対応）
CREATE TABLE knowledge_embeddings (
  embedding_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id       uuid NOT NULL REFERENCES knowledge_items(knowledge_id) ON DELETE CASCADE,
  chunk_index        integer NOT NULL DEFAULT 0,
  chunk_text         text NOT NULL,
  embedding          vector(768),   -- 次元数は採用モデルに依存。§4「pgvector関連設計」を参照（要確定）
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_knowledge_embedding_knowledge ON knowledge_embeddings (knowledge_id);
-- ベクトル近似検索用インデックス（データ量が増えてから作成する運用でも可。詳細は§4）
-- CREATE INDEX ix_knowledge_embedding_ann ON knowledge_embeddings
--   USING hnsw (embedding vector_cosine_ops);

-- レシピ・道具マスタ（運営サポート機能）
CREATE TABLE tools (
  tool_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  category            text,                 -- 農機具／調理器具／建築工具 等
  usage_steps         jsonb,                -- ステップ配列
  required_consumables text,
  safety_notes        text,
  requires_certification boolean NOT NULL DEFAULT false,
  safety_level        text CHECK (safety_level IN ('low','medium','high')),
  storage_location    text,
  maintenance_interval text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recipes (
  recipe_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category             text CHECK (category IN ('調理','クエスト作業')),
  title                text NOT NULL,
  ingredients_tools    uuid[],               -- tools.tool_id 配列
  steps                jsonb NOT NULL,       -- [{order, text}]
  duration_minutes     integer,
  tips                 text,
  failure_patterns     jsonb,                -- [{symptom, cause, solution, condition}]
  created_by           uuid REFERENCES members(member_id),
  source_url           text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- 未回答エスカレーション・ログ
CREATE TABLE unanswered_escalations (
  escalation_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_text       text NOT NULL,
  asked_by_role       text CHECK (asked_by_role IN ('guest','member','core_member')),
  confidence_score    numeric,
  escalated_at        timestamptz NOT NULL DEFAULT now(),
  notified_line       boolean NOT NULL DEFAULT false,
  resolved_knowledge_id uuid REFERENCES knowledge_items(knowledge_id),
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_escalation_unresolved ON unanswered_escalations (escalated_at)
  WHERE resolved_knowledge_id IS NULL;
```

### 3-4. 朝会・議事録データ（WBS §4）

```sql
CREATE TABLE morning_meetings (
  meeting_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  held_on             date NOT NULL,
  audio_storage_path  text NOT NULL,        -- Cloud Storage for Firebase（統一メディア基盤）
  transcript_text     text,
  summary_text        text,
  extracted_quest_candidates jsonb,          -- [{title, headcount, hours, candidate_assignee}]
  created_by          uuid REFERENCES members(member_id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_morning_meeting_date ON morning_meetings (held_on);
```

### 3-5. 街人登録申込（WBS §12）

```sql
CREATE TABLE membership_applications (
  application_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id           uuid NOT NULL REFERENCES members(member_id),
  applied_at           timestamptz NOT NULL DEFAULT now(),
  billed_amount_yen    integer NOT NULL DEFAULT 30000,
  granted_nights       integer,             -- membership_plansを参照して決定。直書き禁止
  status               text NOT NULL DEFAULT '申込中'
                          CHECK (status IN ('申込中','QR送付済み','承認済み','却下','保留')),
  qr_token             text,
  qr_issued_by         uuid REFERENCES members(member_id),
  qr_issued_at         timestamptz,
  qr_delivery_channel  text CHECK (qr_delivery_channel IN ('line','in_app','in_person')),
  qr_expires_at        timestamptz,
  payment_confirmed_by uuid REFERENCES members(member_id),
  approved_at          timestamptz,
  role_upgraded_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_membership_app_member ON membership_applications (member_id);
CREATE INDEX ix_membership_app_status ON membership_applications (status);
COMMENT ON TABLE membership_applications IS
  '決済はアプリ外（QR経由）で完結するため、決済トランザクションそのものは保持しない（正本 §7）';
```

### 3-6. 宿泊予約フォーム連携・宿泊予定カレンダー（WBS §3-5・3-6）

> [!warning] このセクションはドラフト段階（v13 §5.2.3が未コミットのため）
> v13 §5.2.3（宿泊予約フォーム連携のAS-IS/TO-BE）は本書作成時点でリポジトリに**未コミット**であり、
> §9 #30として5点の未確定事項（部屋タイプ選択肢差分・宿泊法必須項目未収集・自動確定判定基準・
> 自動返信メール発信主体・カレンダーUI粒度）が残っている。以下は現時点で読み取れる範囲での
> **概念レベルの設計メモ**であり、正式なDDLとしての確定は避ける。

- Googleフォームの回答を受け取るための中間テーブル（例：`reservation_form_submissions`）を設け、
  フォームの生回答（部屋タイプ・備考欄含む）をそのまま保持し、`check_ins`（`pre_registered`状態）と
  1:1で紐付ける設計が考えられる。備考欄の空判定ロジック（§9 #30-③）が未確定のため、判定結果
  （自動確定／要確認）を表すステータスカラムは`check_ins`側に追加する形が妥当と思われるが、
  カラム名・値の確定は§9 #30の決着後に行う。
- 「宿泊予定カレンダー」は独立テーブルを持たず、`check_ins` × `room_assignments` × `rooms` の
  ビュー（`v_current_room_assignments`に類似）で表現可能と見込まれる。表示粒度（§9 #30-⑤）が
  未確定のため、追加のUI専用テーブルが必要かは詳細UI確定後に判断する。

---

## 4. pgvector関連設計

| 項目 | 内容 |
| --- | --- |
| 拡張 | `CREATE EXTENSION IF NOT EXISTS vector;`（Supabaseは標準サポート） |
| 埋め込みモデル | **未確定・本書での提案**：Claude APIには埋め込み専用エンドポイントが無いため、既にスタックに含まれる**Gemini API の `text-embedding-004`（768次元）**を暫定推奨する（朝会音声処理で既にGemini呼び出しがあり、追加のベンダー契約が不要なため）。代替案として、Anthropic公式が推奨する Voyage AI の埋め込みモデル（`voyage-3`系、1024次元）も選択肢になる。**コスト・精度要件を踏まえた最終選定はオーナー確認が望ましい**（次元数はテーブル定義に直結するため、着手前に確定すること） |
| インデックス方式 | データ量が少ないPhase1初期は逐次スキャンでも許容範囲。件数が数千を超えた段階で `hnsw`（推奨）または `ivfflat` を追加する運用とする |
| 検索フィルタ | `target_role` によるメタデータ事前フィルタを**必ずSQL側（WHERE句）で行う**。ベクトル類似検索の後段でアプリ側フィルタするのではなく、`WHERE target_role = :role AND review_status = 'published'` を先に絞り込んでから類似検索する（プロンプト指示に頼らない、という正本の不可侵ルールをDB設計でも担保） |

---

## 5. インデックス方針（横断ルール）

- 外部キー列には原則インデックスを張る（JOIN・カスケード削除のパフォーマンス確保）。
- ステータス列で絞り込みが頻発するテーブル（`orders.status`、`settlement_adjustments.status`等）は部分インデックス（`WHERE status = '...'`）を優先する。
- 「現在有効な1件」を返す必要があるテーブル（`room_assignments`の`ended_at IS NULL`等）は、一意制約付き部分インデックスで整合性を保証する（既存`uq_room_assign_active`のパターンを踏襲）。

## 6. RLS（Row Level Security）方針（DB観点の概要）

詳細な権限マトリクスは v13 §6 および今後作成する画面設計・API設計ドキュメントに譲るが、DB設計上の原則を以下に示す。

- 全テーブルでRLSを有効化し、`role`（`members.role`）に基づくポリシーを設定する。`member_type`はポリシー条件に一切使用しない。
- 個人情報を含むテーブル（`members`本体の氏名・住所等）は、本人 (`member_id = auth.uid()相当`) と管理者・コアメンバーのみ参照可能とする。
- `member_notes`はテーブル自体に`visibility`（`core_only`/`admin_only`）カラムを持つため、RLSポリシーはこのカラムと`role`の両方を条件に含める。
- Cloud Storage for Firebase（メディア）への署名付きURL発行はSupabase Edge Function経由に一元化し、Firebase Security Rules側には認可ロジックを置かない（v13 §5.11.2・§9 #9、システムアーキテクチャ.md参照）。

---

## 7. Phase 1スコープとの突合（過不足整理）

| WBS機能領域 | 対応テーブル | 状態 |
| --- | --- | --- |
| 2. 認証・アカウント基盤 | `members`, `member_identifiers` | 既存（Vault側で実装・検証済み） |
| 3. 予約・チェックイン・宿泊管理 | `rooms`, `room_assignments`, `check_ins` | 既存（同上）。宿泊予約フォーム連携部分（3-5・3-6）は**ドラフト段階**（§3-6参照） |
| 4. 朝会・議事録・クエスト自動起案 | `morning_meetings` | **本書で新規提案**（未着手） |
| 5. クエスト管理 | `quests`, `quest_applications`, `work_logs`, `work_categories` | **本書で新規提案**（未着手） |
| 6. 注文管理・店舗オペレーション | `orders`, `order_items` | **本書で新規提案**（未着手） |
| 7. Uii会計・決済 | `uii_transactions`（定義のみ）、`orders.total_amount_uii`等 | 換算ロジック自体はテーブル不要（アプリ層で算出） |
| 8. 顧客管理画面・会計調整 | `settlement_adjustments` | **本書で新規提案**（未着手。免除権限はQUESTIONS.md未回答でブロック） |
| 9. FAQ・ナレッジ・RAG | `knowledge_items`, `knowledge_embeddings`, `tools`, `recipes`, `unanswered_escalations` | **本書で新規提案**（未着手。埋め込みモデル未確定） |
| 10. 既存街人データ移行・名寄せ | `members`等（既存） | 既存（Vault側で実データ検証済み。370名の最終承認はQUESTIONS.md未回答） |
| 12. ゲスト→街人アップグレード導線 | `membership_applications` | **本書で新規提案**（未着手） |
| 13. 管理者ダッシュボード | 専用テーブル不要（既存テーブルの集計ビュー） | ― |
| Phase2: メディアストレージ | `media_assets`（未設計） | Phase1では`work_logs.before/after_photo_media_id`等がUUID参照のみ持つ想定。テーブル自体はPhase2着手時に設計 |
| Phase2: 会員権失効 | `memberships.expires_on`, `expire_memberships()` | **既に用意済み**（Vault側スキーマに実装済み。§9 #21で確定した「後からカラムを足さない」方針を満たす） |

---

## 8. オーナー確認事項まとめ

| # | 内容 | 関連QUESTIONS.md項目 |
| --- | --- | --- |
| 1 | 埋め込みモデルの最終選定（次元数がテーブル定義に直結） | （新規発見・本書独自の技術提案。QUESTIONS.md未登録） |
| 2 | `settlement_adjustments`の免除権限範囲・90日滞留後の挙動 | 差額繰越（返金・免除運用）の詳細 |
| 3 | 370名データの物理設計自体は実行可能な状態だが、最終承認は別軸 | 親方・街人リスト受領後の最終データレビューは完了しているか |
| 4 | 宿泊予約フォーム連携（§3-6）のテーブル設計確定 | 宿泊予約フォーム連携の未確定事項5点（§9 #30） |
| 5 | `knowledge_items.target_role`を配列化するか単一値のままとするか | ナレッジ登録UIのtarget_audience/target_role整合（§9 #29） |
| 6 | Vault側の実データ（`01_schema.sql`/`03_seed_members.sql`）をこのリポジトリへ取り込むか、個人情報を含むため別管理とするか | （新規発見・本書独自の指摘） |

---

## 改訂履歴

| 日付 | 内容 |
| --- | --- |
| 2026-08-16 | 初版作成。会員まわりはVault側の既存物理設計（実データ検証済み）を採用し、Phase1で未整備の
7領域（クエスト／注文・会計調整／ナレッジ・RAG／朝会／街人登録申込／宿泊予約フォーム連携）を新規に
物理設計として提案。埋め込みモデル未確定等の新規論点を発見しオーナー確認事項として整理。 |
