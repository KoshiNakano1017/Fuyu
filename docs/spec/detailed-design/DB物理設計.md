---
title: "詳細設計：DB物理設計（Phase 1）"
doc_type: 設計
status: "詳細設計ドラフト（要オーナーレビュー）"
owner: プロジェクトオーナー
date: "2026-08-16"
updated: 2026-08-22
tags: ["浮遊街アプリ"]
up: "[[浮遊街アプリ 総合要件定義・設計書_v13]]"
---

# DB物理設計（Phase 1）

> 本書は正本 `docs/spec/浮遊街アプリ 総合要件定義・設計書_v13.md`（要件定義レベル）を一段階詳細化した
> **設計ドキュメント**である。**実際のマイグレーション適用・DBプロジェクトの作成は行っていない**（自律ループの
> 安全ルールにより、今回のサイクルではドキュメント作成のみ）。DDLは設計内容を明確にするための記述であり、
> 実装・適用はオーナー承認後に別途行うこと。
>
> 本書は以下2つの既存資料を土台として最大限再利用している（ゼロから書き起こしていない）。
> - `docs/spec/basic-design/backend/ER図_概念データモデル.md`（概念モデル。2026-08-16に本リポジトリへ取り込み済み。
>   2026-08-16に工程×領域の2軸フォルダ構成へ再配置）
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
  -- ▼ 二段階承認（v13 §5.3.2 ／ §9 #34。2026-08-20 追加）
  approval_status    text NOT NULL DEFAULT '報告済み'
                        CHECK (approval_status IN ('報告済み','コアメンバー確認済','承認完了','差戻し')),
  reviewed_by        uuid REFERENCES members(member_id),  -- コアメンバー確認者（1人目の確認で遷移）
  reviewed_at        timestamptz,
  review_skipped     boolean NOT NULL DEFAULT false,      -- 管理者が確認を飛ばして直接承認した場合 true
  approved_by        uuid REFERENCES members(member_id),  -- 最終承認者。adminのみ（RLSで制限）
  approved_at        timestamptz,
  rejected_by        uuid REFERENCES members(member_id),
  rejected_at        timestamptz,
  rejection_reason   text,                                -- 差戻し理由。差戻し時は必須（アプリ層＋CHECKで担保）
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- 差戻しには必ず理由を伴う
  CONSTRAINT ck_worklog_rejection_reason
    CHECK (approval_status <> '差戻し' OR rejection_reason IS NOT NULL)
);
CREATE INDEX ix_worklog_application ON work_logs (application_id);
CREATE INDEX ix_worklog_issue ON work_logs (issue_flag) WHERE issue_flag = true;
-- 承認待ち（コアメンバー確認前／管理者承認前）の抽出用
CREATE INDEX ix_worklog_pending ON work_logs (approval_status)
  WHERE approval_status IN ('報告済み','コアメンバー確認済');

-- 2人目以降の確認ログ（1人目の確認でステータスは遷移するが、追加確認も記録する）
CREATE TABLE work_log_reviews (
  review_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id             uuid NOT NULL REFERENCES work_logs(log_id) ON DELETE CASCADE,
  reviewer_id        uuid NOT NULL REFERENCES members(member_id),
  reviewed_at        timestamptz NOT NULL DEFAULT now(),
  comment            text,
  UNIQUE (log_id, reviewer_id)   -- 同一人物の二重確認は記録しない
);
CREATE INDEX ix_worklog_review_log ON work_log_reviews (log_id);
```

> [!important] 確認者（`reviewed_by`）と承認者（`approved_by`）を同一カラムに統合しないこと
> 「誰が現場を確認し、誰が給付を確定したか」は別の事実です。1カラムに統合すると、後から
> 「確認なしで承認されたのか、確認者と承認者が同じ人だったのか」を区別できなくなります。
> **`review_skipped` も必ず記録**してください（管理者が単独で承認するのは仕様上許容されますが、
> それが常態化しているかどうかは運用の健全性を測る指標になります／v13 §5.3.2）。

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
  -- ▼ 提供ステータス（v13 §5.4.1 ／ §9 #39。2026-08-20 追加）
  --   決済ステータス（status）とは独立した2軸。同一カラムへ統合してはならない。
  serving_status     text NOT NULL DEFAULT '未提供'
                        CHECK (serving_status IN ('未提供','提供済み')),
  served_at          timestamptz,
  served_by          uuid REFERENCES members(member_id),
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
-- 厨房の作業待ち行列（未提供のみ）
CREATE INDEX ix_order_serving ON orders (serving_status) WHERE serving_status = '未提供';
-- 「精算済みだが未提供」＝要注意状態の検出用（v13 §5.4.1 の2軸マトリクス）
CREATE INDEX ix_order_paid_unserved ON orders (created_at)
  WHERE status = '精算済み' AND serving_status = '未提供';

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

### 3-3. ナレッジ・RAG（2026-08-16改訂：line-rag-botへ統合、本リポジトリに新規テーブルなし）

> [!success] 2026-08-16 確定（v13 §9 #31・外部連携設計.md §1）
> ナレッジ・RAG基盤はline-rag-bot（Firestore）へ統合することが確定した。浮遊街アプリ本体は
> `knowledge_items`/`knowledge_embeddings`/`tools`/`recipes`/`unanswered_escalations`に相当する
> テーブルを**持たない**（line-rag-bot側に`recipes_{tenant_id}`/`tools_{tenant_id}`/`escalations`
> として実装済みのものと重複するため）。浮遊街アプリ本体はエンドユーザー向けAIチャットUIも持たず、
> 案内はLINE（line-rag-bot）に一本化する。**2026-08-16再確定：浮遊街アプリ本体とline-rag-botの間に
> API連携は一切実装しない**（読み取り専用も含めて不採用）。浮遊街アプリ側はB9/C5画面に
> 「line-rag-bot管理画面を開く」外部リンクを配置するのみで、ナレッジ登録・編集用のUI・API実装は
> 行わない（詳細は外部連携設計.md §2参照）。当初提案したDDL（pgvector前提）は不採用となったが、
> 経緯を追跡できるよう本書末尾の「§9 参考: 不採用となった設計案」に原文のまま残している。

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

### 3-7. メディアライブラリ（画面設計.md A10。2026-08-16新設・Phase2から前倒し）

> [!success] Phase1へ前倒し（2026-08-16オーナー指示）
> 従来は「Phase2: メディアストレージ」として`media_assets`を未設計のまま据え置いていた（旧§7表）。
> 「動画・写真を用途別にAIソート＋キャプション自動生成する」新規要望に伴いPhase1へ前倒しする。
> `work_logs.before/after_photo_media_id`等の既存UUID参照カラムは、本テーブルの`media_id`を
> 指す想定で設計済みだったため、参照先が「未設計」から「実テーブル」に変わるだけで既存カラムの
> 変更は不要。

```sql
CREATE TABLE media_assets (
  media_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id               uuid NOT NULL REFERENCES members(member_id),  -- アップロード者（全ロール可）
  media_type              text NOT NULL CHECK (media_type IN ('photo','video')),
  storage_path             text NOT NULL,   -- Cloud Storage for Firebase（統一メディア基盤、署名付きURL方式）
  thumbnail_path            text,            -- 動画のサムネイル（静止画は storage_path と同一で可）
  purpose_tags              text[] NOT NULL DEFAULT '{}',  -- 例: ['instagram'], ['資料作成','ブログ']
  place_id                  uuid,            -- 拠点タグ（カフェ／アースバッグ／畑 等）。FEL共通スキーマ側のためFK制約なし
  taken_at                  timestamptz,     -- Exif由来の撮影日時（ユーザーに入力させない）
  geo_location              text,            -- Exif由来の位置情報
  -- ▼ 全ロール開放に伴う項目（v13 §5.11.7 ／ §9 #33。2026-08-20 追加）
  visibility                text NOT NULL DEFAULT '公開'
                              CHECK (visibility IN ('公開','運営のみ')),
  deleted_at                timestamptz,     -- 論理削除。運営措置による非表示化も同経路
  deleted_by                uuid REFERENCES members(member_id),
  delete_reason             text,
  -- ▼ Phase 2 で使用（Phase 1 は値を入れない。後から列を足すと全件の再解析が必要になるため先に用意する）
  ai_caption                text,            -- AI自動生成キャプション案（採用前は未編集の生成結果のまま）
  ai_caption_edited         boolean NOT NULL DEFAULT false,  -- 利用者が編集済みか（生成結果の丸写しと区別）
  ai_purpose_score          jsonb,           -- {"instagram": 0.82, "資料作成": 0.55} 用途タグ別の適合度
  ai_processed_at           timestamptz,     -- AI解析完了時刻。NULLの間は「解析中」表示
  ai_processing_status      text NOT NULL DEFAULT 'pending'
                              CHECK (ai_processing_status IN ('pending','processing','done','failed')),
  linked_quest_id            uuid REFERENCES quests(quest_id),      -- クエスト完了報告からの登録（任意）
  linked_work_log_id         uuid REFERENCES work_logs(log_id),      -- 同上（Before/After写真からの導線）
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- 用途タグは最低1つ必須（Phase 2 の検索・推薦が成立しなくなるため／v13 §5.11.7）
  CONSTRAINT ck_media_purpose_tags_required CHECK (cardinality(purpose_tags) >= 1)
);
CREATE INDEX ix_media_member ON media_assets (member_id);
CREATE INDEX ix_media_purpose_tags ON media_assets USING gin (purpose_tags);
CREATE INDEX ix_media_processing_status ON media_assets (ai_processing_status)
  WHERE ai_processing_status IN ('pending','processing');
-- 一覧表示は削除済みを除外する（論理削除のため常に条件が付く）
CREATE INDEX ix_media_active ON media_assets (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_media_place ON media_assets (place_id) WHERE deleted_at IS NULL;
```

- **AI処理は非同期**：アップロード直後は`ai_processing_status='pending'`で即座に一覧へ反映し、
  Gemini（マルチモーダル、朝会音声処理と同一基盤）のバックグラウンド処理完了後に`done`へ更新する
  （画面応答をブロックしない設計、システムアーキテクチャ.md非機能要件の朝会60秒SLA原則を踏襲）。
- **`ai_purpose_score`はJSONBで柔軟に持つ**：用途タグはユーザーの自由入力を許容するため（マスタ化
  しない）、固定カラムではなくキー可変のJSONBが適切（マスタ値のハードコード禁止の精神とは別軸の判断。
  「用途」はマスタというより利用者ごとの自由記述に近いため）。
- **削除・退会時の扱いは未確定**：`members`削除（存在しない想定だが将来の退会処理）時の
  `media_assets`の扱い（カスケード削除か保持か）は§8オーナー確認事項へ追加。

---

### 3-8. Eumo給付の送付・受領追跡（v13 §5.3.1 ／ §9 #35。2026-08-20 新設）

```sql
CREATE TABLE eumo_grants (
  grant_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id          uuid NOT NULL REFERENCES members(member_id),
  quest_id           uuid REFERENCES quests(quest_id),
  application_id     uuid REFERENCES quest_applications(application_id),
  log_id             uuid REFERENCES work_logs(log_id),   -- 起票元の完了報告
  amount_uii         integer NOT NULL CHECK (amount_uii > 0),
  -- ▼ 「送付した」と「受け取られた」は別の事実。1カラムに統合しない（v13 §5.3.1）
  status             text NOT NULL DEFAULT '未送付'
                        CHECK (status IN ('未送付','送付済','受領確認済','送付失敗')),
  eumo_url           text,
  sent_to            text,                                 -- 送付先（メール／LINE ID）
  sent_channel       text CHECK (sent_channel IN ('email','line','in_person')),
  sent_by            uuid REFERENCES members(member_id),
  sent_at            timestamptz,
  received_confirmed_by uuid REFERENCES members(member_id),  -- Phase1は手動確認（EUMO API連携はPhase2）
  received_confirmed_at timestamptz,
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_eumo_grant_member ON eumo_grants (member_id);
CREATE INDEX ix_eumo_grant_status ON eumo_grants (status);
-- 「誰にいくら送るか」を確定表示するための未送付一覧
CREATE INDEX ix_eumo_grant_unsent ON eumo_grants (created_at) WHERE status = '未送付';
-- 送付済のまま14日超＝滞留の検出（v13 §5.3.1）
CREATE INDEX ix_eumo_grant_stale ON eumo_grants (sent_at) WHERE status = '送付済';
```

> [!important] 給付予定は「最終承認」と同時に起票する
> `work_logs.approval_status = '承認完了'` になった瞬間にのみ `eumo_grants` を作成してください。
> **コアメンバー確認済の段階では起票しない**こと。確認だけで給付リストに載ると、最終承認前の作業に
> 対して送付操作ができてしまいます（v13 §5.3.2 で最終承認を `admin` に限定した意味が失われる）。

### 3-9. カフェメニューマスタ（v13 §5.4.2① ／ §9 #40。2026-08-20 新設）

```sql
CREATE TABLE menu_items (
  menu_item_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  category           text NOT NULL,          -- フード／ドリンク／直売所 等
  unit_price_yen     integer NOT NULL CHECK (unit_price_yen >= 0),
  -- ▲ Uii価格は保存しない。floor(unit_price_yen * 0.8) として都度算出する（v13 §5.5・§5.4.2①）
  description        text,
  image_media_id     uuid REFERENCES media_assets(media_id),
  display_order      integer NOT NULL DEFAULT 0,
  is_sold_out        boolean NOT NULL DEFAULT false,   -- SOLDOUTトグル（コアメンバーも操作可）
  is_published       boolean NOT NULL DEFAULT true,
  available_from     date,
  available_until    date,                              -- 季節メニュー用
  created_by         uuid REFERENCES members(member_id),
  updated_by         uuid REFERENCES members(member_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_menu_published ON menu_items (display_order) WHERE is_published = true;
CREATE INDEX ix_menu_category ON menu_items (category) WHERE is_published = true;
```

### 3-10. 宿泊料金マスタ（v13 §5.4.2② ／ §9 #40。2026-08-20 新設）

```sql
CREATE TABLE accommodation_rates (
  rate_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type          text NOT NULL
                        CHECK (room_type IN ('コテージA','コテージB','アースバッグ',
                                             'テント','車中泊','ゲストハウス','サロン')),
  member_category    text NOT NULL DEFAULT 'member'
                        CHECK (member_category IN ('member','non_member')),
  price_per_night_yen integer NOT NULL CHECK (price_per_night_yen >= 0),
  -- ▼ 料金改定は行の上書きではなく、適用期間を区切って新しい行を追加する（v13 §5.4.2②）
  effective_from     date NOT NULL,
  effective_until    date,                     -- NULL＝現行
  note               text,
  created_by         uuid REFERENCES members(member_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_rate_period CHECK (effective_until IS NULL OR effective_until >= effective_from)
);
-- 同一（部屋タイプ×会員区分）で適用期間が重複しないことを保証する
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE accommodation_rates ADD CONSTRAINT ex_rate_no_overlap
  EXCLUDE USING gist (
    room_type WITH =,
    member_category WITH =,
    daterange(effective_from, effective_until, '[]') WITH &&
  );
CREATE INDEX ix_rate_current ON accommodation_rates (room_type, member_category)
  WHERE effective_until IS NULL;
```

> [!warning] マスタは「これから作る伝票の既定値」であり、過去伝票の参照先ではない
> `menu_items.unit_price_yen` を変更しても、**既存の `order_items.unit_price_yen` は変わりません**
> （注文時点の単価をコピー保持しているため）。この設計を崩して伝票がマスタを参照する形にすると、
> 価格改定のたびに過去の伝票金額が書き換わり、§5.6.5 の遡及修正で差額が誤って算出されます。
> 宿泊料金も同じ理由で**適用期間付きの履歴**とし、過去の予約を当時の料金で再計算できるようにします。

### 3-11. 予約経路の記録（v13 §5.2.4 ／ §9 #36。2026-08-20 追加）

既存の `check_ins`（Vault側 `01_schema.sql` で実装済み）に、以下のカラムを追加する。

```sql
ALTER TABLE check_ins
  ADD COLUMN reservation_source text NOT NULL DEFAULT 'google_form'
    CHECK (reservation_source IN ('google_form','in_app','staff_manual'));

COMMENT ON COLUMN check_ins.reservation_source IS
  '予約経路。google_form=外部フォーム（初回来訪者）／in_app=アプリ内予約（v13 §5.2.4）／staff_manual=運営代理登録。フォーム改修の効果測定とアプリ内予約の利用率評価に使う';

CREATE INDEX ix_checkin_reservation_source ON check_ins (reservation_source);
```

> **入口は2本、正本は1本**：Googleフォーム経由もアプリ内予約も**同一の `check_ins` レコード**として
> 作成し、`reservation_source` で経路だけを区別する。予約テーブルを経路ごとに分けると、
> 宿泊予定カレンダー（§5.2.5②）や残枠算出（§5.2.5①）が経路ごとの UNION になり複雑化するため。

### 3-12. 宿泊枠の残数算出（v13 §5.2.5① ／ §9 #37。2026-08-20 追加）

**残枠は保存カラムを持たず、ビューで都度算出する**（加減算方式はダブルブッキングの温床／v13 §8）。

```sql
-- 日付 × 部屋タイプごとの残枠。予約画面・カレンダー・顧客管理から参照する
CREATE VIEW v_room_availability AS
SELECT
  d.date,
  r.room_type,
  SUM(r.capacity)                                    AS total_capacity,
  COUNT(ra.assignment_id)                            AS occupied,
  SUM(r.capacity) - COUNT(ra.assignment_id)          AS available
FROM generate_series(
       current_date,
       current_date + interval '180 days',
       interval '1 day'
     ) AS d(date)
CROSS JOIN rooms r
LEFT JOIN room_assignments ra
  ON ra.room_id = r.room_id
 AND ra.ended_at IS NULL
 AND d.date >= ra.started_at::date
 AND (ra.scheduled_end_at IS NULL OR d.date < ra.scheduled_end_at::date)
WHERE r.status = '利用可'          -- メンテナンス中・利用停止は分母から除外（v13 §5.2.1）
GROUP BY d.date, r.room_type;
```

- **`rooms.status = '利用可'` 以外は分母に含めない**。メンテナンス中の部屋を空きとして数えると、
  予約できてしまい当日に部屋がない事態になる。
- 予約が `cancelled_at IS NOT NULL` になった時点で `room_assignments` も終了する（§5.2.2）ため、
  キャンセル分は自動的に空き枠へ戻る。本ビューに追加の条件は不要。
- パフォーマンスが問題になる場合のみ、マテリアライズドビュー化を検討する（Phase 1 は素のビューで足りる想定）。

---

## 4. line-rag-bot連携（ナレッジ・RAG）

> [!success] 2026-08-16確定：pgvectorは採用しない
> §3-3で述べたとおり、ナレッジ・RAG基盤はline-rag-bot（Firestore）へ統合されたため、本書は
> pgvector拡張・埋め込みモデル・ベクトルインデックスのいずれも設計しない。埋め込みモデル選定・
> 検索フィルタ実装はline-rag-bot側の設計領域に移った（同リポジトリの `docs/06-マルチテナント設計.md`
> 等を参照）。**2026-08-16再確定：浮遊街アプリ本体からのAPI呼び出しも行わない**（管理画面からの
> 外部リンクのみ）。詳細は `docs/spec/detailed-design/外部連携設計.md` §2を参照。

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
| 9. FAQ・ナレッジ・RAG | なし（浮遊街アプリ側のテーブル・API実装なし） | **2026-08-16再確定：line-rag-bot（Firestore）へ統合、新規テーブル・API連携ともになし**（管理画面への外部リンクのみ。§3-3参照） |
| 10. 既存街人データ移行・名寄せ | `members`等（既存） | 既存（Vault側で実データ検証済み。370名の最終承認はQUESTIONS.md未回答） |
| 12. ゲスト→街人アップグレード導線 | `membership_applications` | **本書で新規提案**（未着手） |
| 13. 管理者ダッシュボード | 専用テーブル不要（既存テーブルの集計ビュー） | ― |
| 14. メディア（画像・動画）アップロード（v13 §5.11.7、2026-08-20 再確定） | `media_assets` | **本書で新規提案**（未着手）。**Phase 1 はアップロードのみ**（全ロール開放・用途タグ必須・論理削除）。**検索とAI推薦は Phase 2** のため `ai_*` 系カラムは用意するが値を入れない。§3-7参照 |
| 15. Eumo給付の送付・受領追跡（v13 §5.3.1、2026-08-20 新設） | `eumo_grants` | **本書で新規提案**（未着手）。最終承認と同時に起票。`送付済` と `受領確認済` を別状態で保持。§3-8参照 |
| 16. マスタ管理（カフェメニュー／宿泊料金）（v13 §5.4.2、2026-08-20 新設） | `menu_items`, `accommodation_rates` | **本書で新規提案**（未着手）。Uii価格は保存せず都度算出。宿泊料金は適用期間付きの履歴管理（`EXCLUDE` 制約で期間重複を防止）。§3-9・§3-10参照 |
| 17. アプリ内からの宿泊予約（v13 §5.2.4、2026-08-20 新設） | `check_ins.reservation_source`（カラム追加） | **本書で新規提案**（未着手）。Googleフォーム経由と同一テーブルに格納し経路のみ区別。§3-11参照 |
| 18. 宿泊枠の残数・カレンダー（v13 §5.2.5、2026-08-20 新設） | `v_room_availability`（ビュー） | **本書で新規提案**（未着手）。**保存カラムを持たず都度算出**（ダブルブッキング防止）。§3-12参照 |
| 19. クエスト承認の二段階化（v13 §5.3.2、2026-08-20 新設） | `work_logs`（カラム追加）, `work_log_reviews` | **本書で新規提案**（未着手）。確認者と承認者を別カラムで保持。§3-1参照 |
| 20. カフェ注文の提供ステータス（v13 §5.4.1、2026-08-20 新設） | `orders.serving_status` 他（カラム追加） | **本書で新規提案**（未着手）。決済ステータスと**独立した2軸**。§3-2参照 |
| Phase2: 会員権失効 | `memberships.expires_on`, `expire_memberships()` | **既に用意済み**（Vault側スキーマに実装済み。§9 #21で確定した「後からカラムを足さない」方針を満たす） |
| Phase2: メディアの検索・AI推薦 | `media_assets.ai_*`（カラムのみ先行用意） | **Phase 1 でスキーマだけ用意**。値の投入・検索実装は Phase 2（v13 §5.11.3） |

---

## 8. オーナー確認事項まとめ

| # | 内容 | 関連QUESTIONS.md項目 |
| --- | --- | --- |
| ~~1~~ | ~~埋め込みモデルの最終選定~~ | **移管済み（2026-08-16）**：line-rag-bot側の設計領域に移った。本リポジトリでは対応不要 |
| 2 | `settlement_adjustments`の免除権限範囲・90日滞留後の挙動 | ✅解消済み（2026-08-16）：Phase1はコアメンバーにも免除許可、90日滞留はフラグのみ。詳細はCONSOLIDATED_DECISIONS.md §8参照 |
| 3 | 370名データの物理設計自体は実行可能な状態だが、最終承認は別軸 | ✅解消済み（2026-08-16）：370名で最終承認済み |
| 4 | 宿泊予約フォーム連携（§3-6）のテーブル設計確定 | ✅5/5点回答済み（2026-08-16）。§3-6は次回サイクルで正式DDL化予定 |
| 5 | `knowledge_items.target_role`を配列化するか単一値のままとするか | **移管済み（2026-08-16）**：`knowledge_items`自体が不要になったため、line-rag-bot側Firestoreスキーマの論点に移った（v13 §9 #29は引き続き未決） |
| 6 | Vault側の実データ（`01_schema.sql`/`03_seed_members.sql`）をこのリポジトリへ取り込むか、個人情報を含むため別管理とするか | （新規発見・本書独自の指摘。未回答のまま） |
| 7 | `media_assets`：退会・アカウント削除時のカスケード削除 or 保持方針（§3-7参照） | 新規（2026-08-16、画面設計.md A10と連動） |
| 8 | `media_assets`：AI解析（Gemini）のコスト・レイテンシ、動画サムネイル生成・保存容量の見積り、肖像権チェックの要否 | 新規（2026-08-16、画面設計.md §6 #5〜#7と同一論点） |

---

## 9. 参考: 不採用となった設計案（解釈B用参考）

> [!note] 2026-08-16 移動
> 以下は初版（同日）で提案した「浮遊街アプリ本体がpgvectorで独自ナレッジ基盤を持つ」案のDDLである。
> 同日中のオーナー回答により解釈A（line-rag-botへ統合）で確定したため不採用となったが、
> 決定の経緯を追跡できるよう原文のまま残す。**このセクションのDDLは実装対象ではない。**

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
  embedding          vector(768),   -- 次元数は採用モデルに依存
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_knowledge_embedding_knowledge ON knowledge_embeddings (knowledge_id);
-- CREATE INDEX ix_knowledge_embedding_ann ON knowledge_embeddings
--   USING hnsw (embedding vector_cosine_ops);

-- レシピ・道具マスタ（line-rag-bot側に recipes_{tenant_id}/tools_{tenant_id} として実装済みのため不要）
CREATE TABLE tools (
  tool_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  category            text,
  usage_steps         jsonb,
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
  ingredients_tools    uuid[],
  steps                jsonb NOT NULL,
  duration_minutes     integer,
  tips                 text,
  failure_patterns     jsonb,
  created_by           uuid REFERENCES members(member_id),
  source_url           text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- 未回答エスカレーション・ログ（line-rag-bot側に escalations コレクションとして実装済みのため不要）
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

（旧§4「pgvector関連設計」の内容：拡張`vector`、埋め込みモデルはGemini `text-embedding-004`
またはVoyage AI `voyage-3`系を提案、インデックスは`hnsw`推奨、検索フィルタは`target_role`のSQL側
事前フィルタ必須——という設計方針だったが、pgvector自体を採用しないため全体が不要となった。）

---

## 改訂履歴

| 日付 | 内容 |
| --- | --- |
| 2026-08-16 | 初版作成。会員まわりはVault側の既存物理設計（実データ検証済み）を採用し、Phase1で未整備の
7領域（クエスト／注文・会計調整／ナレッジ・RAG／朝会／街人登録申込／宿泊予約フォーム連携）を新規に
物理設計として提案。埋め込みモデル未確定等の新規論点を発見しオーナー確認事項として整理。 |
| 2026-08-16（追記） | オーナー回答（ナレッジ・RAG基盤をline-rag-botへ統合、アプリ内チャットUIなし）を
反映。§3-3・§4のpgvector前提の設計（`knowledge_items`/`knowledge_embeddings`/`tools`/`recipes`/
`unanswered_escalations`）を「不採用となった設計案」として§9へ移動し、本文は「line-rag-bot API連携
のみ、新規テーブルなし」に差し替え。§7突合表・§8オーナー確認事項も合わせて更新。 |
| 2026-08-16（再確定） | **API連携ゼロが最終確定**。§3-3・§4の「line-rag-bot APIへ送信」という記述を、
「管理画面からline-rag-bot Streamlitへの外部リンクのみ、API連携なし」に修正。§7突合表の9行目を
更新。読み取り専用APIも含めて浮遊街アプリ側にAPI実装が発生しない点を明記。 |
| 2026-08-16（オーナー指示反映） | **§3-7「メディアライブラリ」を新設**：動画・写真をFirebaseへ格納し、
用途（インスタグラム／資料作成等）入力→AI適合度ソート＋キャプション自動生成する`media_assets`
テーブルを新規提案。旧「Phase2: メディアストレージ」（未設計のまま据え置き）からPhase1へ前倒し。
§7突合表を14番として追加、§8オーナー確認事項に#7・#8を新設（削除方針・AIコスト等）。 |
| **2026-08-20（v13 v1.15.0 反映）** | **8/13レビュー未反映分の一括反映（v13 §9 #33〜#43）に伴うスキーマ改訂**。①**§3-1 二段階承認**：`work_logs.approval_status` を `報告済み/コアメンバー確認済/承認完了/差戻し` へ変更し、`reviewed_by`（確認者）と `approved_by`（最終承認者＝admin）を**別カラムで保持**。`review_skipped`・差戻し理由の CHECK 制約・`work_log_reviews`（2人目以降の確認ログ）を追加。②**§3-2 提供ステータス**：`orders.serving_status`（未提供／提供済み）・`served_at`・`served_by` を追加し、決済ステータスと独立した2軸に。「精算済みだが未提供」検出用の部分インデックスも新設。③**§3-7 メディア**：`visibility`（公開／運営のみ）・`deleted_at`（論理削除・運営措置）・`place_id`・`taken_at`・`geo_location` を追加。**用途タグ最低1つ必須**の CHECK 制約を新設（Phase 2 の検索精度を担保）。`ai_*` 系は Phase 2 用にカラムのみ用意。④**§3-8 `eumo_grants` を新設**：`未送付→送付済→受領確認済` を追跡。送付と受領を別状態で保持。⑤**§3-9 `menu_items` / §3-10 `accommodation_rates` を新設**：Uii価格は保存せず都度算出。宿泊料金は `EXCLUDE USING gist` で適用期間の重複を防止し、過去予約を当時の料金で再計算可能に。⑥**§3-11 `check_ins.reservation_source` を追加**：アプリ内予約とフォーム経由を同一テーブルで扱い経路のみ区別。⑦**§3-12 `v_room_availability` ビューを新設**：残枠を**保存せず都度算出**（ダブルブッキング防止）。§7突合表に15〜20番を追加。 |
