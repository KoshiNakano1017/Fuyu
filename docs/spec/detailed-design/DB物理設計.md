---
title: "詳細設計：DB物理設計（Phase 1）"
doc_type: 設計
status: "詳細設計ドラフト（要オーナーレビュー）"
owner: プロジェクトオーナー
date: "2026-08-16"
updated: 2026-09-05
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
7. **個人情報カラムは、表示用カラムと同じ行に置かない**（2026-09-05 オーナー承認・A案）。氏名・カナ・住所・出身地・誕生年月は `member_profiles_private` へ、連絡先は `member_identifiers` へ、運営メモは `member_notes` へ分離する。RLS は**行**にしか効かないため、同居させると列単位のマスキングが必要になり、保護がエンドポイントごとの実装依存になる（§6-0）。
8. **全テーブルで `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` を必須**とする。ポリシーを1本も定義しないテーブルは「全拒否」として扱う（§6-7）。**RLS を有効化していないテーブルを1つでも作った時点で、そのテーブルはインターネットへ全開になる**（`anon` キーはクライアントJSに埋め込まれる公開情報である／v13 §9 F-9）。

---

## 2. 会員まわり（既存物理設計・実データ検証済み）

Vault側 `migration/01_schema.sql` で既に設計・実装され、実データ（街びと327件＋親方衆44件、統合後370名）の
投入・検算まで完了している。本書では**そのまま採用**し、詳細はそちらを正とする。以下は本書の文脈で
参照するための要約。

| テーブル | 役割 | 特記事項 |
| --- | --- | --- |
| `members` | 会員マスタ | `role`／`member_type`／`account_status`を分離。残高3カラムは集計キャッシュ。**2026-09-05：個人情報カラムを `member_profiles_private` へ移し、`auth_user_id` を新設**（§6-0） |
| **`member_profiles_private`** | **個人情報（氏名・カナ・住所・出身地・誕生年月）** | **2026-09-05 新設。`member_id` を PK 兼 FK とする1対1。`ON DELETE CASCADE`。本人＋`admin`/`core_member` のみ（§6-2）** |
| `member_identifiers` | 名寄せキー（email/phone/line/discord） | 検証済み識別子のみ`(kind, value)`一意。未検証は重複許容。**`member_profiles_private` と同一の保護区分** |
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

> [!important] 2026-09-05：会員まわりのスキーマに2点の変更が入った（A案）
> §2 は従来「Vault 側 `01_schema.sql` をそのまま採用する」としていたが、**2026-09-05 オーナー承認により
> 以下2点は `01_schema.sql` から変更**される。移行実装時は本書と [[会員データモデル_ユーザーテーブル定義]] §5.2・§5.2b を正とすること。
>
> 1. **`members` から個人情報カラム（`full_name`・`full_name_kana`・`address`・`hometown`・`birth_ym`）を除去**し、
>    新テーブル `member_profiles_private` へ移す
> 2. **`members` へ `auth_user_id uuid UNIQUE NULL REFERENCES auth.users(id)` を新設**する
>    （これが無いと RLS の本人ポリシーが書けない／§6-3）
>
> ```sql
> ALTER TABLE members ADD COLUMN auth_user_id uuid UNIQUE REFERENCES auth.users(id);
> COMMENT ON COLUMN members.auth_user_id IS
>   'Supabase Auth との結合キー。NULL = アプリ未登録（account_status = pre_registered）。'
>   'RLS の本人判定はこの列のみを根拠にする。一般会員に UPDATE 権限を与えてはならない（§6-6）';
>
> ALTER TABLE members
>   DROP COLUMN full_name, DROP COLUMN full_name_kana,
>   DROP COLUMN address,   DROP COLUMN hometown, DROP COLUMN birth_ym;
> ```
>
> ⚠️ `01_schema.sql` は Vault 側で実データ370名の投入まで完了しているため、**この2点は「初期スキーマの修正」**
> として扱う（既存マイグレーションの書き換えではない。本リポジトリには `supabase/migrations/` がまだ存在しない）。

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

### 3-6. ~~宿泊予約フォーム連携~~ → **公開予約ページ・事前予約注文**（2026-08-23 全面改訂 ／ v13 §9 #46・#48）

> [!important] ~~中間テーブル `reservation_form_submissions` を設ける~~ → **撤回（2026-08-23）**
> 旧ドラフトは「Googleフォームの生回答を保持する中間テーブルを設け、`check_ins` と 1:1 で紐付ける」設計を
> 想定していたが、**フォームを廃止し公開予約ページ `/reserve` へ置き換える決定**（v13 §5.2.3）により、
> **保持すべき「外部フォームの生回答」が存在しなくなった**ため撤回する。
> 予約は最初から正規化された形で `check_ins` へ直接記録される。

**① 予約本体**

`check_ins`（`pre_registered` 状態）へ直接記録する。経路は `reservation_source = 'web_public'`（§3-11）。
同意記録として `consent_version`（同意した「浮遊街に宿泊される方へ」の版数）を保持する。

**② カフェの事前予約注文（v13 §5.4.1b ／ §9 #48）**

```sql
CREATE TABLE meal_reservations (
  meal_reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id          uuid NOT NULL REFERENCES check_ins(checkin_id) ON DELETE CASCADE,
  served_on           date NOT NULL,                    -- 提供日。チェックイン当日を含む滞在日
  meal_slot           text NOT NULL CHECK (meal_slot IN ('breakfast','lunch','dinner')),
  menu_item_id        uuid NOT NULL REFERENCES menu_items(menu_item_id),
  quantity            integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- 提供操作で orders へ変換した際に、変換先の伝票を記録する（二重変換の防止）
  converted_order_id  uuid REFERENCES orders(order_id),
  converted_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkin_id, served_on, meal_slot, menu_item_id)
);

CREATE INDEX ix_meal_res_date ON meal_reservations (served_on, meal_slot)
  WHERE cancelled_at IS NULL AND converted_at IS NULL;   -- 日別食数サマリー（仕込み数量）の算出用

COMMENT ON TABLE meal_reservations IS
  '宿泊予約時のカフェ事前予約注文。目的は仕込み数量の把握であり、予約時点では orders を作らない。提供操作時に orders へ変換する（v13 §5.4.1b）';
COMMENT ON COLUMN meal_reservations.converted_order_id IS
  '提供時に変換した伝票。NULL のまま滞在が終わった行は「予約されたが提供されなかった食事」として運用で検知できる';
```

> [!warning] 事前予約の時点で `orders` を作らない
> 予約時に伝票を起票すると、**まだ来訪も提供もしていない金額が未会計請求（v13 §5.6）へ前倒しで載り**、
> 顧客管理画面の「未会計額」が実態とズレる。v13 §5.4.1 が分離した「会計ステータス × 提供ステータス」の2軸にも、
> **存在しない第3の状態（予約済・未来訪）**が混ざる。
> `meal_reservations` を独立に持ち、**提供操作の時点で `orders` へ変換する**こと。

**③ 公開予約ページの OTP（v13 §5.2.3② ／ §5.8.3 の本人確認要件）**

```sql
CREATE TABLE reservation_otps (
  otp_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  code_hash     text NOT NULL,                 -- 平文のコードは保存しない
  expires_at    timestamptz NOT NULL,          -- 短命（数分）
  attempt_count integer NOT NULL DEFAULT 0,    -- 総当たり防止。上限超過で無効化する
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_reservation_otps_email ON reservation_otps (email, created_at DESC);
```

- **平文コードを保存しない**（`code_hash` のみ）。ログにも出力しない（`CLAUDE.md` §3.2）。
- 期限切れ・消費済みの行は定期的に削除する。**メールアドレスは個人情報**であり、不要な保持期間を作らない。

**④ 宿泊予定カレンダー**

独立テーブルを持たず、`check_ins` × `room_assignments` × `rooms` × `meal_reservations` のビューで表現する。
表示粒度は v13 §9 #30-⑤（Googleカレンダー同等の操作感）で確定済み。日別の食数サマリーを併記する（§5.4.1b）。

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
  ~~Gemini（マルチモーダル、朝会音声処理と同一基盤）~~ → **Claude（マルチモーダル。2026-08-29 オーナー決定／v13 §9 #56）** のバックグラウンド処理完了後に`done`へ更新する
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
  category           text NOT NULL,          -- フード／ドリンク／直売所／送迎・オプション（v13 §5.4.2③）
  unit_price_yen     integer NOT NULL CHECK (unit_price_yen >= 0),
  -- ▲ Uii価格は保存しない。floor(unit_price_yen * 0.8) として都度算出する（v13 §5.5・§5.4.2①）
  description        text,
  image_media_id     uuid REFERENCES media_assets(media_id),
  display_order      integer NOT NULL DEFAULT 0,
  is_sold_out        boolean NOT NULL DEFAULT false,   -- SOLDOUTトグル（コアメンバーも操作可）
  is_published       boolean NOT NULL DEFAULT true,
  available_from     date,
  available_until    date,                              -- 季節メニュー用
  -- ▼ 宿泊予約時の事前予約注文（v13 §5.4.1b ／ §9 #48。2026-08-23 追加）
  is_pre_orderable   boolean NOT NULL DEFAULT false,   -- 宿泊予約画面の選択肢に出すか
  meal_slot          text CHECK (meal_slot IN ('breakfast','lunch','dinner')),  -- 朝／昼／夜。NULL = 時間帯を問わない
  created_by         uuid REFERENCES members(member_id),
  updated_by         uuid REFERENCES members(member_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_menu_published ON menu_items (display_order) WHERE is_published = true;
CREATE INDEX ix_menu_category ON menu_items (category) WHERE is_published = true;
CREATE INDEX ix_menu_pre_orderable ON menu_items (meal_slot) WHERE is_pre_orderable = true AND is_published = true;

COMMENT ON COLUMN menu_items.is_pre_orderable IS
  '宿泊予約時に事前予約できる商品か（朝ごはん・昼・夜のプレートごはん）。v13 §5.4.1b';
COMMENT ON COLUMN menu_items.category IS
  '送迎は専用マスタを作らず本テーブルのカテゴリ「送迎・オプション」として登録する。単価1,900円＝1,520Uii・片道。SOLDOUTトグルで対応不可時間帯を表現できるため（v13 §5.4.2③）';
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
-- 2026-08-23 改訂（v13 §9 #46）：Googleフォーム廃止に伴い 'web_public' を追加し、既定値を変更。
-- 'google_form' は過去データの経路を表す値として残す（削除すると既存行が CHECK 違反になるため）
ALTER TABLE check_ins
  ADD COLUMN reservation_source text NOT NULL DEFAULT 'web_public'
    CHECK (reservation_source IN ('web_public','in_app','staff_manual','google_form'));

COMMENT ON COLUMN check_ins.reservation_source IS
  '予約経路。web_public=公開予約ページ（未ログイン。v13 §5.2.3）／in_app=ログイン済のアプリ内予約（§5.2.4）／staff_manual=運営代理登録／google_form=【廃止】旧Googleフォーム経由の過去データ。web_public と in_app を分けるのは、未ログイン予約がどれだけ会員登録へ転換したかを評価するため';

CREATE INDEX ix_checkin_reservation_source ON check_ins (reservation_source);
```

> **入口は2本、正本は1本**：Googleフォーム経由もアプリ内予約も**同一の `check_ins` レコード**として
> 作成し、`reservation_source` で経路だけを区別する。予約テーブルを経路ごとに分けると、
> 宿泊予定カレンダー（§5.2.5②）や残枠算出（§5.2.5①）が経路ごとの UNION になり複雑化するため。

### 3-12. 宿泊枠の残数算出（v13 §5.2.5① ／ §9 #37。2026-08-20 追加 ／ **2026-08-23 算出元を全面改訂・§9 #47**）

**残枠は保存カラムを持たず、ビューで都度算出する**（加減算方式はダブルブッキングの温床／v13 §8）。この原則は変更しない。
**変わったのは「何から数えるか」である。**

> [!important] 算出元を `room_assignments` → `check_ins` へ変更した理由
> 旧ビューは `room_assignments`（部屋番号の割当）の件数から残枠を算出していた。
> しかし v13 §5.2.3 は**備考欄が空の予約をシステムが自動確定する**と定めており、
> 自動確定では部屋割当が作られない（部屋割当の権限は管理者・コアメンバーのみ／v13 §6）。
> つまり**自動確定した予約は残枠を1つも減らさず**、担当者が手で部屋を割り当てるまで
> 画面が「空いている」と表示し続けた。**「人手の転記をなくす」という目的が、そのままダブルブッキングの原因**になっていた。
>
> `rooms` / `room_assignments` は**部屋番号の割当という役割に限定**し、残枠計算からは切り離す。

> [!warning] ★ 占有量の数え方は形態によって2通りある
> **人数で数える形態と、棟で数える形態が混在している。一律の式では必ず破綻する。**
>
> - **人数枠型（`per_person`）**：ドミトリー(16)／キャンプサイト(10)／車中泊(30) → 残枠 = 定員 − **予約人数の合計**
> - **棟貸型（`per_unit`）**：コテージ(3棟)／アースバッグ(1棟)／サロン(1室) → 残枠 = **棟数 − 占有棟数**（1予約が最低1棟を占有）
>
> コテージを人数で数えると、**1名の予約が3件入った時点で実際は3棟すべて埋まっているのに「残り3名」と表示**される。
> 逆にドミトリーを件数で数えると、16床あるのに数件で満室扱いになり枠を使い切れない。

```sql
-- 宿泊形態マスタ（占有量の数え方を保持する。v13 §5.4.2・§9 #47）
-- ▲ 収容枠も数え方も「コードに直書きしない」ためにマスタ化する（v13 §5.4.2 実装上の注意）
CREATE TABLE accommodation_types (
  room_type       text PRIMARY KEY,        -- dormitory / cottage / campsite / car / earthbag / salon
  display_name    text NOT NULL,           -- ドミトリー／コテージ／キャンプサイト／車中泊／アースバッグ／サロン
  allocation_mode text NOT NULL CHECK (allocation_mode IN ('per_person','per_unit')),
  display_order   integer NOT NULL DEFAULT 0
);
```

```sql
-- 日付 × 宿泊形態ごとの残枠。公開予約ページ・アプリ内予約・カレンダー・顧客管理から参照する
CREATE VIEW v_room_availability AS
WITH cal AS (
  SELECT d::date AS date
  FROM generate_series(current_date, current_date + interval '180 days', interval '1 day') AS d
),
cap AS (
  SELECT
    r.room_type,
    SUM(r.capacity) AS total_capacity,   -- 人数枠型の分母
    COUNT(*)        AS total_units,      -- 棟貸型の分母
    MAX(r.capacity) AS unit_capacity     -- 棟貸型の1棟あたり定員（コテージ等は2）
  FROM rooms r
  WHERE r.status = '利用可'              -- メンテナンス中・利用停止は分母から除外（v13 §5.2.1）
  GROUP BY r.room_type
),
booked AS (
  SELECT
    ci.room_type,
    cal.date,
    SUM(ci.adults_count + ci.children_count) AS booked_persons,
    SUM(CEIL((ci.adults_count + ci.children_count)::numeric
             / NULLIF(cap.unit_capacity, 0)))  AS booked_units   -- 定員超過分は複数棟を消費する
  FROM check_ins ci
  JOIN cap ON cap.room_type = ci.room_type
  JOIN cal ON cal.date >= ci.check_in_date
          AND cal.date <  ci.check_out_date          -- チェックアウト日は専有しない
  WHERE ci.cancelled_at IS NULL                      -- キャンセル・ノーショーは専有しない（v13 §5.2.2）
    AND ci.status IN ('pre_registered','confirmed','staying')
  GROUP BY ci.room_type, cal.date
)
SELECT
  cal.date,
  t.room_type,
  t.allocation_mode,
  CASE t.allocation_mode
    WHEN 'per_person' THEN cap.total_capacity
    ELSE cap.total_units
  END AS total,
  CASE t.allocation_mode
    WHEN 'per_person' THEN COALESCE(b.booked_persons, 0)
    ELSE COALESCE(b.booked_units, 0)
  END AS occupied,
  GREATEST(
    CASE t.allocation_mode
      WHEN 'per_person' THEN cap.total_capacity - COALESCE(b.booked_persons, 0)
      ELSE cap.total_units - COALESCE(b.booked_units, 0)
    END, 0) AS available
FROM cal
CROSS JOIN accommodation_types t
JOIN cap ON cap.room_type = t.room_type
LEFT JOIN booked b ON b.room_type = t.room_type AND b.date = cal.date;
```

- **`rooms.status = '利用可'` 以外は分母に含めない**。メンテナンス中の部屋を空きとして数えると、予約できてしまい当日に部屋がない事態になる。
- **チェックアウト日は専有しない**（`cal.date < check_out_date`）。ここを `<=` にすると、退去日と次の到着日が重なる予約が入らなくなり、稼働率が落ちる。
- キャンセル分は `cancelled_at IS NULL` の条件で自然に除外される。**`room_assignments` の終了処理に依存しない**のが旧ビューとの差である。
- パフォーマンスが問題になる場合のみ、マテリアライズドビュー化を検討する（Phase 1 は素のビューで足りる想定）。

> [!note] 列名は既存スキーマとの突合が必要
> `check_ins` は Vault 側 `01_schema.sql` で実装済みであり、本書は列名を
> `room_type` / `check_in_date` / `check_out_date` / `adults_count` / `children_count` / `status` / `cancelled_at` と仮定している。
> **実装着手時に実スキーマと突合すること。** 差異があれば本ビューの定義を実スキーマ側へ合わせる
> （データモデル図_ER_Diagram.md では予約が `BOOKINGS` という別エンティティとして描かれており、
> `check_ins` との関係が図とテキストで食い違っている。この整合も同時に取る必要がある）。

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

## 6. RLS（Row Level Security）— ポリシー設計と実装

> [!danger] 本節の位置づけ
> [[非機能要件詳細]] §7-3 の **F-6「RLSポリシーのDDLが未作成（本書 §6 は方針4行のみ）」** に対応する節である。
> v13 §9 F-9 が指摘するとおり、**インターネットと会員370名の個人情報の間に立っているのは RLS 1枚のみ**であり、
> [[システムアーキテクチャ]] は「RLS は最後の砦ではなく**唯一の砦**」と書いている。
> [[API設計]] §1 の原則①により、**単純な CRUD は Supabase クライアントから RLS 越しに直接アクセス**する設計であるため、
> API層の認可を通らないトラフィックが常に存在する。**ここが抜けると、他に受け止める層は無い。**
>
> 本節は**設計であり、適用ではない**。`supabase/migrations/` の作成は Supabase プロジェクト未作成のため行っていない（本書冒頭の注記と同じ扱い）。

### 6-0. 前提：A案（個人情報の別テーブル分離）がRLSを単純にする

2026-09-05 のオーナー承認により、`members` から個人情報カラムを `member_profiles_private` へ分離した（§2・[[会員データモデル_ユーザーテーブル定義]] §5.2b）。**この分離は RLS のためのものである。**

| | 分離前 | 分離後（A案） |
| --- | --- | --- |
| `members` に氏名・住所 | **ある** | ない |
| 「他人の行を読める」ポリシーを書くと | **氏名・住所まで返る** | 返らない（別の行にある） |
| 必要な防御 | 行単位RLS ＋ **列単位のマスキング**（ロール別DTO・ビュー） | **行単位RLSのみ** |
| 漏れる余地 | エンドポイントを1本足すたびに発生 | ポリシー1本で閉じる |

> [!important] PostgreSQL の RLS は「行」にしか効かない
> `CREATE POLICY` の `USING` 句が判定するのは**その行を見せてよいか**だけであり、**どの列を返すか**は制御できない。
> 「一般会員は他人の氏名を見られないが、ニックネームは見られる」を1つのテーブルで実現するには、
> 列単位の権限（`GRANT SELECT (col)`）かビューが要る。**保護対象を別の行へ移せば、この問題そのものが消える。**

オーナーが示した前提を、DB設計上の規則として次のとおり固定する。

1. **個人情報保護が必要なテーブルについては、一般会員は自分の行のみ**参照できる
2. **それ以外のテーブルは個人情報を持たない**
3. クエストボードで受注者を表示する際は**ニックネーム**を使う（実体は §6-4 の `v_member_public`）

### 6-1. Phase 1 全テーブルの個人情報区分とアクセス規則

**保護区分**の定義:

| 区分 | 意味 | 既定のアクセス規則 |
| :---: | --- | --- |
| **PII-A** | 氏名・連絡先・住所・運営メモ。v13 §8「一般会員・ゲスト向けAPIレスポンスに含めない」の直接対象 | 本人 ＋ `admin`／`core_member`。**運営メモのみ本人も不可** |
| **PII-B** | 個人の行動・金額・自由記述の履歴。氏名は含まないが `member_id` 経由で個人に紐づく | 本人（自分の行のみ）＋ `admin`／`core_member` |
| **非PII** | マスタ・区分値。誰の情報でもない | `authenticated` 全員が SELECT 可。更新は `admin`（一部 `core_member`） |
| **全拒否** | サーバサイド専用。クライアントから触らせない | ポリシーを1本も作らない＝`service_role` のみ |

> [!warning] §7 の突合表からテーブル一覧を拾うと漏れる
> 本書 §7 の突合表は §3 の追加に追いついておらず、**`member_notes`・`meal_reservations`・`reservation_otps`・
> `accommodation_types`・`membership_plans`・`memberships`・`stay_ticket_transactions` が現れない**。
> 下表は §2（会員まわり）＋§3（新規提案）の**DDL 実体**から起こしたものであり、**こちらを RLS 適用の正とする。**

| # | テーブル / ビュー | 保護区分 | 個人情報カラム | 誰がどの行を読めるか | 書き込み |
| ---: | --- | :---: | --- | --- | --- |
| 1 | `members` | 非PII（**ただし残高を含むため他者非公開**） | なし（A案で除去済） | 本人の行 ＋ `admin`/`core_member` は全行。**他者向けは `v_member_public` 経由**（§6-4） | 本人は §6-6 の列のみ。`role`/`account_status`/`auth_user_id`/集計キャッシュは `service_role` |
| 2 | **`member_profiles_private`** | **PII-A** | `full_name`, `full_name_kana`, `address`, `hometown`, `birth_ym` | 本人の行 ＋ `admin`/`core_member` は全行 | 本人（自分の行）＋ `admin`/`core_member` |
| 3 | `member_identifiers` | **PII-A** | `value`（メール／電話／LINE ID／Discord ID の実値） | 同上 | INSERT は本人＋staff。**`is_verified` の UPDATE は staff のみ**（§6-2③） |
| 4 | `member_notes` | **PII-A** | `body`（運営メモ）, `author_id` | **`core_only` → `admin`/`core_member` ／ `admin_only` → `admin` のみ。本人も読めない** | `admin`/`core_member` |
| 5 | `check_ins` | PII-B | 滞在日・宿泊形態・人数・キャンセル理由。**宿泊法の住所/前泊地/後泊地の格納先は未定義（§6-9 ①）** | 本人の行 ＋ `admin`/`core_member` | 本人（アプリ内予約／v13 §5.2.4）＋ staff |
| 6 | `reservation_otps` | **全拒否** | `email`（平文）, `code_hash` | **誰も読めない。** OTP 発行・検証は Edge Function（`service_role`）のみ | 同左 |
| 7 | `member_import_links` / `import_jobs` | PII-B | 取込元ファイル名・照合根拠 | `admin` のみ | `admin`（実体は `service_role`） |
| 8 | `memberships` | PII-B | `fee_amount_actual`（個人の実支払額）, `note`（例外理由） | 本人 ＋ staff | staff |
| 9 | `stay_ticket_transactions` | PII-B | `reason`（贈与・調整の自由記述）, `operator_id` | 本人 ＋ staff | staff（`staff_adjust` は理由必須／v13 §5.8.5） |
| 10 | `uii_transactions` | PII-B | `memo`, `operator_id` | 本人 ＋ staff | staff。**Phase 1 では稼働しない**が RLS は先に張る |
| 11 | `room_assignments` | PII-B | 誰がどの部屋に泊まったか, `room_name_snapshot` | 本人（自分の `check_in` 経由）＋ staff | staff のみ（v13 §6） |
| 12 | `orders` | PII-B | `purchaser_id`, `edited_by`, `edit_reason` | 本人 ＋ staff | 本人は自分の注文の INSERT。編集・キャンセルは staff |
| 13 | `order_items` | PII-B | 個人の飲食内容（嗜好） | 親 `orders` に従う | 同上 |
| 14 | `settlement_adjustments` | PII-B | `reason`（未払い理由の自由記述）, `waived_by` | 本人 ＋ staff | staff（免除は v13 §9 #2 で core_member にも許可） |
| 15 | `meal_reservations` | PII-B | `checkin_id` 経由で個人の食事内容が復元可能 | 本人 ＋ staff | 本人＋staff |
| 16 | `membership_applications` | PII-B | `qr_token`（決済QR）, `billed_amount_yen` | 本人 ＋ `admin`。**`core_member` は不可**（v13 §6：申請一覧は admin のみ） | 本人が申請 INSERT。QR発行・承認は `admin` |
| 17 | `eumo_grants` | **PII-A** | **`sent_to`（送付先＝メール／LINE ID）**, `eumo_url` | 本人（自分の給付）＋ staff | staff |
| 18 | `work_logs` | PII-B | `notes`, `issue_note`, `rejection_reason`, Before/After 写真 | 本人（申請者）＋ staff | 本人が報告 INSERT。確認・承認は staff／`admin` |
| 19 | `work_log_reviews` | PII-B | `comment`（評価コメント） | **staff のみ**（被評価者に見せない） | staff |
| 20 | `quest_applications` | PII-B | 誰がどのクエストに申請したか | 本人 ＋ staff。**受注確定後の受注者は `v_member_public` 経由で全員に見える**（§6-4） | 本人が INSERT。審査は staff |
| 21 | `morning_meetings` | **PII-A** | **`transcript_text`／`summary_text`（会話の全文文字起こし＝個人の発言）** | **staff のみ**（v13 §6：朝会は admin/core_member） | `admin` |
| 22 | `media_assets` | PII-B | `member_id`（投稿者）, **`geo_location`（Exif 位置情報）**, `ai_caption` | 投稿者本人 ＋ staff は全件。一般会員・ゲストは**「公開」のもののみ**（v13 §6） | 全ロールが自分の投稿を INSERT。非表示化・削除は staff |
| 23 | `quests` | 非PII | ― | `authenticated` 全員（`guest_allowed=false` はゲスト除外） | `admin`/`core_member` |
| 24 | `work_categories` | 非PII | ― | `authenticated` 全員 | `admin` |
| 25 | `menu_items` | 非PII | ― | `authenticated` 全員 | `admin` |
| 26 | `accommodation_rates` | 非PII | ― | `authenticated` 全員 | `admin` |
| 27 | `accommodation_types` | 非PII | ― | `authenticated` 全員 | `admin` |
| 28 | `membership_plans` | 非PII | ― | `authenticated` 全員 | `admin` |
| 29 | `rooms` | 非PII | ― | `authenticated` 全員（残枠表示のため） | `admin`/`core_member` |
| 30 | `v_room_availability`（ビュー） | 非PII | ― | `authenticated` 全員。**個人を含む列を持たせない**（日付×形態×残数のみ） | ― |
| 31 | **`v_member_public`（ビュー・新設）** | 非PII | ― | `authenticated` 全員。**`member_id`・`display_name`・`member_type` のみ**（§6-4） | ― |

> [!note] `member_type` はこの表のどこにも認可条件として現れない
> v13 §2 の不可侵ルール（`member_type` を認可に使わない）を、**ポリシー条件に `member_type` を一切書かない**という形で担保している。
> 表に現れる `member_type` は §6-4 の**表示名の接頭辞決定**のみであり、行の可視性判定には使っていない。

### 6-2. 個人情報テーブル（PII-A）のポリシー DDL

#### ① 共通ヘルパ関数（§6-3 で方式選定の理由を述べる）

```sql
-- 現在のセッションに対応する members.member_id を返す。未登録・退会済みなら NULL。
CREATE OR REPLACE FUNCTION public.current_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''          -- search_path 乗っ取りの防止（SECURITY DEFINER の必須作法）
AS $$
  SELECT m.member_id
  FROM   public.members m
  WHERE  m.auth_user_id = auth.uid()
    AND  m.account_status <> 'withdrawn'
$$;

-- 現在のセッションの role（members.role）を返す。v13 §5.9.3：認可は role のみで判定する。
CREATE OR REPLACE FUNCTION public.current_member_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.role
  FROM   public.members m
  WHERE  m.auth_user_id = auth.uid()
    AND  m.account_status <> 'withdrawn'
$$;

CREATE OR REPLACE FUNCTION public.is_staff()      -- admin または core_member
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT public.current_member_role() IN ('admin', 'core_member') $$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT public.current_member_role() = 'admin' $$;

-- 実行権限は authenticated に限定する。anon から呼べる必要はない。
REVOKE EXECUTE ON FUNCTION
  public.current_member_id(), public.current_member_role(),
  public.is_staff(), public.is_admin()
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION
  public.current_member_id(), public.current_member_role(),
  public.is_staff(), public.is_admin()
  TO authenticated;
```

> [!danger] `members` に `FORCE ROW LEVEL SECURITY` を付けてはならない
> 上記の関数は `SECURITY DEFINER` によりテーブル所有者権限で走り、所有者は RLS を迂回する。
> **これが無限再帰を避けている唯一の仕組みである。** `ALTER TABLE members FORCE ROW LEVEL SECURITY`
> を付けると所有者にも RLS が適用され、`members` のポリシー → `is_staff()` → `members` のポリシー → …
> と再帰して `infinite recursion detected in policy for relation "members"`（42P17）で全クエリが落ちる。

> [!note] `(SELECT ...)` で包む理由
> ポリシー中で `(SELECT public.is_staff())` のように包むと、PostgreSQL が **InitPlan として1回だけ評価**する。
> 裸で書くと**行ごとに関数が呼ばれる**。370名規模では体感差は出ないが、`orders`・`stay_ticket_transactions`
> のように行数が伸びるテーブルで効く。全ポリシーでこの書き方に統一する。

#### ② `members`

```sql
ALTER TABLE members ENABLE ROW LEVEL SECURITY;

-- SELECT：本人は自分の行。staff は全行。
CREATE POLICY members_select_self ON members
  FOR SELECT TO authenticated
  USING ( auth_user_id = (SELECT auth.uid()) );

CREATE POLICY members_select_staff ON members
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- UPDATE：本人は自分の行のみ。WITH CHECK で「更新後も自分の行であること」を強制し、
-- auth_user_id を他人の値へ書き換えて行を乗っ取ることを防ぐ。
CREATE POLICY members_update_self ON members
  FOR UPDATE TO authenticated
  USING       ( auth_user_id = (SELECT auth.uid()) )
  WITH CHECK  ( auth_user_id = (SELECT auth.uid()) );

CREATE POLICY members_update_staff ON members
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- INSERT：ポリシーを作らない＝全拒否。
--   会員行の生成は「リスト取込（§6.2b）」と「名寄せ成立時の結合」だけであり、
--   いずれも service_role のサーバサイド処理。クライアントから会員を作れてはならない。
-- DELETE：ポリシーを作らない＝全拒否。
--   §1-3（物理削除の原則禁止）。退会は account_status = 'withdrawn' の論理削除、
--   30日後の匿名化は service_role の定期ジョブが UPDATE で行う（v13 §2）。
```

> [!danger] `members` の UPDATE は RLS だけでは守れない — 列単位 `GRANT` が必須
> `members_update_self` は「自分の行だけ更新できる」ことしか保証しない。
> **自分の行の `role` を `'admin'` に書き換える**のは、RLS 的には完全に正当な操作である。
> 防ぐ手段は RLS ではなく**列単位の権限**であり、§6-6 の `GRANT UPDATE (...)` が本体である。
> ここを `GRANT UPDATE ON members TO authenticated`（全列）にした瞬間、
> **全会員が自力で管理者に昇格できる**。

#### ③ `member_profiles_private`（PII-A）

```sql
ALTER TABLE member_profiles_private ENABLE ROW LEVEL SECURITY;

CREATE POLICY mpp_select_self ON member_profiles_private
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY mpp_select_staff ON member_profiles_private
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- INSERT：本人（初回登録で自分の氏名・住所を入れる）と staff（現地代理入力）。
CREATE POLICY mpp_insert_self ON member_profiles_private
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY mpp_insert_staff ON member_profiles_private
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY mpp_update_self ON member_profiles_private
  FOR UPDATE TO authenticated
  USING       ( member_id = (SELECT public.current_member_id()) )
  WITH CHECK  ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY mpp_update_staff ON member_profiles_private
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない＝全拒否。
--   退会30日後の匿名化は「行を消す」のではなく「値をダミーへ UPDATE する」ことで行う。
--   行を消すと ON DELETE CASCADE は逆向き（members → profiles）のため members 側は残り、
--   宿泊法の保存義務（旅館業法：宿泊者名簿3年）との整合も取れなくなる（§6-9 ③）。
```

#### ④ `member_identifiers`（PII-A）

```sql
ALTER TABLE member_identifiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY mid_select_self ON member_identifiers
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY mid_select_staff ON member_identifiers
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- INSERT：本人は自分の識別子を追加できるが、is_verified = true では入れられない。
CREATE POLICY mid_insert_self ON member_identifiers
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id())
               AND is_verified = false );

CREATE POLICY mid_insert_staff ON member_identifiers
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- UPDATE：staff のみ。本人には許可しない（下の danger を参照）。
CREATE POLICY mid_update_staff ON member_identifiers
  FOR UPDATE TO authenticated
  USING      ( (SELECT public.is_staff()) )
  WITH CHECK ( (SELECT public.is_staff()) );

-- DELETE：admin のみ。主連絡先を本人に消させると、運営から到達できない会員が生まれる。
CREATE POLICY mid_delete_admin ON member_identifiers
  FOR DELETE TO authenticated
  USING ( (SELECT public.is_admin()) );
```

> [!danger] `is_verified` を本人が書ける状態にしない
> §5.3 のユニークは `WHERE is_verified = true` の**部分**ユニークである。
> 本人が `is_verified = true` を自由に立てられると、**他人のメールアドレスを検証済みとして登録**でき、
> v13 §5.8.3 の名寄せ（＝他人の宿泊券・Uii残高・XPの引き継ぎ）を正面から突破できる。
> `is_verified = true` を書けるのは、**対面入力した staff と OTP 検証を通した Edge Function だけ**である。

#### ⑤ `member_notes`（PII-A・**本人にも見せない**）

```sql
ALTER TABLE member_notes ENABLE ROW LEVEL SECURITY;

-- SELECT：visibility と role の両方を条件に含める（旧 §6 の方針を DDL 化したもの）。
--   本人ポリシーは「意図的に書かない」。運営が本人について書いた申し送りだからである。
CREATE POLICY mnote_select_core ON member_notes
  FOR SELECT TO authenticated
  USING ( visibility = 'core_only' AND (SELECT public.is_staff()) );

CREATE POLICY mnote_select_admin ON member_notes
  FOR SELECT TO authenticated
  USING ( visibility = 'admin_only' AND (SELECT public.is_admin()) );

-- INSERT：staff のみ。author_id の詐称を防ぐため、自分自身の member_id しか書けない。
CREATE POLICY mnote_insert_staff ON member_notes
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff())
               AND author_id = (SELECT public.current_member_id()) );

-- UPDATE：staff。ただし visibility を下げる（admin_only → core_only）のは admin のみ。
CREATE POLICY mnote_update_staff ON member_notes
  FOR UPDATE TO authenticated
  USING      ( visibility = 'core_only' AND (SELECT public.is_staff()) )
  WITH CHECK ( visibility = 'core_only' AND (SELECT public.is_staff()) );

CREATE POLICY mnote_update_admin ON member_notes
  FOR UPDATE TO authenticated
  USING      ( (SELECT public.is_admin()) )
  WITH CHECK ( (SELECT public.is_admin()) );

-- DELETE：admin のみ。誤記入の撤回手段は残すが、通常は追記で対応する（§1-3）。
CREATE POLICY mnote_delete_admin ON member_notes
  FOR DELETE TO authenticated
  USING ( (SELECT public.is_admin()) );
```

> [!warning] `visibility` の値域は未確定
> 本書 §2 は `core_only`/`admin_only` の2値、[[会員データモデル_ユーザーテーブル定義]] §5.7 は `core_only` を既定と書く。
> `CREATE TABLE member_notes` の実体は Vault 側 `01_schema.sql` にのみ存在し、本リポジトリからは確認できない。
> **上記は2値を前提に書いている。値域の確定は要オーナー確認**（§6-9 ⑤）。
> なお `CHECK (visibility IN ('core_only','admin_only'))` を付けておけば、
> 想定外の値の行が「どのポリシーにも一致せず誰にも見えない」＝**安全側に倒れる**。

#### ⑥ `eumo_grants`（PII-A：`sent_to` が送付先メール／LINE ID）

```sql
ALTER TABLE eumo_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY eumo_select_self ON eumo_grants
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY eumo_select_staff ON eumo_grants
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY eumo_insert_staff ON eumo_grants
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY eumo_update_staff ON eumo_grants   -- 送付済 → 受領確認済（v13 §5.3.1）
  FOR UPDATE TO authenticated
  USING      ( (SELECT public.is_staff()) )
  WITH CHECK ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない＝全拒否（給付の証跡を消させない／§1-3）。
```

#### ⑦ `morning_meetings`（PII-A：全文文字起こし）

```sql
ALTER TABLE morning_meetings ENABLE ROW LEVEL SECURITY;

-- 本人ポリシーを書かない。朝会の閲覧は admin/core_member のみ（v13 §6）。
-- 発言者本人であっても「自分の行」という概念が無い（1レコード＝1回の朝会全体）。
CREATE POLICY mm_select_staff ON morning_meetings
  FOR SELECT TO authenticated USING ( (SELECT public.is_staff()) );

CREATE POLICY mm_insert_admin ON morning_meetings
  FOR INSERT TO authenticated WITH CHECK ( (SELECT public.is_admin()) );

CREATE POLICY mm_update_admin ON morning_meetings
  FOR UPDATE TO authenticated
  USING ( (SELECT public.is_admin()) ) WITH CHECK ( (SELECT public.is_admin()) );

-- DELETE：ポリシーを作らない＝全拒否。
```

#### ⑧ `reservation_otps`（全拒否）

```sql
-- RLS を有効化し、ポリシーを1本も作らない。これで authenticated / anon からは
-- SELECT / INSERT / UPDATE / DELETE のすべてが 0 行になる（§6-7）。
ALTER TABLE reservation_otps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reservation_otps FROM anon, authenticated;

COMMENT ON TABLE reservation_otps IS
  'RLS 全拒否。OTP の発行・検証は Edge Function（service_role）でのみ行う。'
  'email を平文で保持するため、クライアントからの参照経路を一切作らない（v13 §5.2.3②）';
```

> [!important] 公開予約ページ（`/reserve`）は未ログイン＝`anon` だが、`anon` に権限を与えて解決しない
> [[非機能要件詳細]] §2-2b が「**`anon` キーに `check_ins` 等の INSERT 権限を与えない**」と定めている。
> `/reserve` からの予約は **Edge Function（`service_role`）が受け取って書き込む**。
> `anon` へ INSERT を開けると、RLS の緩みがそのまま**個人情報テーブルへの書き込み口**になる。
> `anon` に必要なのは「OTP を送ってもらう」ことだけであり、それは関数呼び出しであってテーブル権限ではない。

### 6-3. ロール判定の方式選定 — `SECURITY DEFINER` 関数を採る

`members.role` を参照して認可するとき、**素朴に書くと無限再帰する**。

```sql
-- ❌ 絶対に書いてはいけない例
CREATE POLICY members_select_staff ON members
  FOR SELECT TO authenticated
  USING ( EXISTS (SELECT 1 FROM members m2
                  WHERE m2.auth_user_id = auth.uid()
                    AND m2.role IN ('admin','core_member')) );
-- → members のポリシー評価が members の SELECT を呼び、そのポリシー評価がまた members を呼ぶ。
--    ERROR: infinite recursion detected in policy for relation "members" (42P17)
```

検討した3方式:

| 方式 | 再帰回避 | 権限変更の即時性 | コスト | 評価 |
| --- | --- | --- | --- | --- |
| **A. `SECURITY DEFINER` 関数**（採用） | ○ 所有者権限で走り RLS を迂回する | **○ 即時**（毎回 DB を読む） | 1クエリあたり InitPlan 1回 | **採用** |
| B. JWT カスタムクレーム（Custom Access Token Hook で `app_role` を埋め、`auth.jwt()` から読む） | ○ テーブルを読まない | **× 最大1時間の遅延**（トークン期限まで古い `role` が有効） | 最速（ゼロクエリ） | 不採用（下記） |
| C. `user_roles` 別テーブル（`members` と分離し、そこにはポリシーを張らない） | ○ | ○ | 1クエリ | 不採用（`role` の正本が2箇所になる） |

> [!important] B（JWTクレーム）を採らない理由
> Supabase の一般的な推奨は B（性能）だが、本プロジェクトでは **A を採る。**
>
> 1. **権限剥奪が即時に効かない。** JWT に焼き込んだ `role` は、トークンが失効するまで有効である。
>    退会（`withdrawn`）・ロール降格・**名寄せ事故の緊急切り離し**を行っても、**最大1時間は
>    古い権限で個人情報を読み続けられる。** v13 §9 F-9 が「RLS が唯一の砦」と書いている状況で、
>    その砦に最大1時間の時間差を持ち込む判断はしない。
> 2. **`role` の正本は DB である。** v13 §2・§5.9.3 は「認可は `members.role` のみで判定する」と定めている。
>    JWT クレームは発行時点のコピーであり、正本ではない。v13 §9 #31・#61 は
>    「自己申告のロールを信用しない」という判断を LINE 側で既に下しており、同じ考え方に揃える。
> 3. **性能上の必要が無い。** 会員は370名、Phase 1 の同時接続は現場スタッフ＋滞在者規模である。
>    `(SELECT public.is_staff())` は InitPlan として1クエリ1回しか評価されない。
>
> **将来 B へ移る場合の条件**：①実測でポリシー評価がボトルネックになったこと ②
> `role` 変更時にセッションを強制失効させる仕組み（`auth.refresh_tokens` の失効）が実装済みであること。
> この2つが揃うまで B へ移らない。

`SECURITY DEFINER` を安全に使うための必須作法（上記 DDL に反映済み）:

- **`SET search_path = ''` を必ず付け、全オブジェクトをスキーマ修飾する。** 付けないと、呼び出し側が
  `search_path` を差し替えて偽の `members` テーブルを掴ませることができる（権限昇格の古典的手口）。
- **`STABLE` を付ける。** InitPlan 化の前提になる。
- **`REVOKE EXECUTE ... FROM PUBLIC` する。** 定義しただけでは誰でも実行できる。
- **`members` に `FORCE ROW LEVEL SECURITY` を付けない**（§6-2① の danger）。

### 6-4. 他者向け表示は `v_member_public` ビューに閉じる

オーナー前提③「クエストボードで受注者を表示する際は**ニックネーム**を使う」を DB 側で担保する。
`members` 本体は残高を含むため他者に開けられない（§6-1 #1）。そこで**露出してよい列だけのビュー**を作る。

```sql
CREATE VIEW v_member_public
WITH (security_invoker = false)   -- ビュー所有者権限で実行＝members の RLS を意図的に迂回する
AS
SELECT
  m.member_id,
  COALESCE(
    NULLIF(btrim(m.nickname), ''),
    (CASE WHEN m.member_type = 'ゲスト' THEN 'ゲスト#' ELSE '街人#' END) || m.legacy_member_no,
    (CASE WHEN m.member_type = 'ゲスト' THEN 'ゲスト#' ELSE '街人#' END) || left(m.member_id::text, 8)
  ) AS display_name,
  m.member_type          -- 画面上のバッジ表示用。認可には使わない（v13 §2）
FROM public.members m
WHERE m.account_status <> 'withdrawn';

REVOKE ALL   ON v_member_public FROM anon;
GRANT  SELECT ON v_member_public TO authenticated;

COMMENT ON VIEW v_member_public IS
  '他者向けに露出してよい会員情報はこの3列のみ。氏名・住所・連絡先・残高・XP を絶対に追加しない。'
  'display_name のフォールバック規則は 会員データモデル §5.2c の不可侵ルール（本名へ落とさない）';
```

> [!danger] このビューに列を足すときは §5.2c の不可侵ルールを読み直すこと
> `security_invoker = false` は **`members` の RLS を意図的に迂回する**。
> つまり「このビューに書いた列は、ログインしている全員に見える」。
> **`full_name` を JOIN して足した瞬間に、A案の分離は無意味になる。**
> `member_profiles_private` を FROM 句に含めてはならない。

> [!note] `display_name` を DB 側に置く理由
> フロントで `nickname ?? full_name` と書かれるのを防ぐには、**フロントに `full_name` を渡さない**のが唯一確実な方法である。
> [[非機能要件詳細]] §7-3 F-3 が指摘する Realtime 配信（再訪アラート）のように、表示層を経由しない
> 配信経路が存在するため、表示層での対処は原理的に漏れる。

### 6-5. 管理者・コアメンバー画面で JOIN が必要になる箇所（見取り）

A案により、**氏名を出す画面はすべて `members` × `member_profiles_private` の JOIN が必要**になる。
該当するのは v13 §6 の権限マトリクスで「氏名・連絡先・運営メモの閲覧 ＝ 管理者・コアメンバーのみ」と
された画面群であり、具体的には **顧客管理画面（[[画面設計]] B3／v13 §5.6：氏名・カナ・住所・連絡先・
未会計額・宿泊履歴を一覧表示）・再訪アラート（B6／v13 §5.8.4：氏名＋運営メモ＋残チケットをポップアップ）・
チェックイン画面（店員タブレット：宿泊者の氏名照合と「連絡先未登録」バッジ）・宿泊予定カレンダー
（`GET /api/admin/stay-calendar`：宿泊者名の表示）・会員データ取込／名寄せ承認画面（v13 §5.8.2・§5.8.3：
氏名＋誕生年月の第2キー照合）・街人登録申請一覧（v13 §5.10.4：申請者の本人確認）・宿泊者名簿の法定出力
（旅館業法対応／v13 §5.2）**の7系統である。API 上は `GET /api/admin/members`・`GET /api/admin/members/{id}`・
`GET /api/admin/stay-calendar`・`POST /api/members/link-identifier`・`GET /api/admin/membership-applications`
がこれに当たり、いずれも `admin`／`core_member` 限定であるため **RLS 越しの素の JOIN で成立する**
（両テーブルとも staff には全行が見えるため、追加の権限設計は要らない）。
一方、**一般会員・ゲスト向けの画面は1つも JOIN を必要としない** — クエストボード・注文履歴・
マイログはいずれも `v_member_public.display_name` で足りる。**JOIN の要否が、そのまま認可境界と一致している**
状態が保たれているかどうかが、A案が機能しているかの点検指標になる。

### 6-6. GRANT 方針（`anon` / `authenticated` / `service_role`）

> [!important] RLS と GRANT は別の関門であり、両方が必要
> PostgREST 経由のアクセスは **①ロールへの `GRANT` → ②RLS ポリシー**の順に2つの関門を通る。
> `GRANT` が無ければポリシーを書いても届かず、ポリシーが無ければ `GRANT` があっても0行になる。
> **Supabase は新規テーブルへ既定で `anon`/`authenticated` に広い権限を与える**ため、明示的に絞る。

```sql
-- ① anon：アプリケーションテーブルへは一切触らせない（公開予約は Edge Function 経由／§6-2⑧）
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM anon;
-- 今後追加されるテーブルにも自動で適用する（「新テーブルを作ったら全開だった」を防ぐ）
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ② authenticated：SELECT はテーブル単位、書き込みは列単位で与える
GRANT SELECT ON members, member_profiles_private, member_identifiers,
                check_ins, orders, order_items, quests, v_member_public,
                v_room_availability, menu_items, accommodation_rates,
                accommodation_types, membership_plans, rooms
  TO authenticated;
GRANT SELECT ON member_notes, morning_meetings, work_log_reviews TO authenticated;  -- 行はRLSで0件に絞られる

-- ★ members の UPDATE は「本人が変えてよい列」だけに限定する（§6-2② の danger）
GRANT UPDATE (nickname, skills, certifications, line_joined, discord_joined)
  ON members TO authenticated;
-- role / account_status / auth_user_id / stay_tickets / total_stay_days / uii_balance /
-- earned_xp / legacy_member_no / invite_code は列単位 GRANT に含めない＝更新不能。

GRANT INSERT, UPDATE (full_name, full_name_kana, address, hometown, birth_ym)
  ON member_profiles_private TO authenticated;
GRANT INSERT ON member_identifiers TO authenticated;   -- UPDATE は与えない（is_verified 保護）

-- ③ service_role：BYPASSRLS。サーバサイド（Edge Function / Server Actions）専用。
--    CLAUDE.md §3.2 のとおりクライアントへ渡さない。RLS を迂回するため、
--    service_role を使う処理では [[API設計]] §1 のアプリ層認可が唯一の関門になる。
```

> [!warning] 集計キャッシュ3種を列単位 GRANT から外すのは §1-1 の担保でもある
> `stay_tickets`・`total_stay_days`・`uii_balance` は「アプリから直接 UPDATE してはならない」（§1-1・v13 §7）。
> これを**規約ではなく DB 権限として強制**しているのが上の列指定である。
> トリガーは所有者権限で走るため影響を受けない。

### 6-7. デフォルト拒否の徹底

```sql
-- 全テーブルで有効化する。ポリシー未定義＝全拒否。
ALTER TABLE members                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_profiles_private  ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_identifiers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_notes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships              ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stay_ticket_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE uii_transactions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_ins                ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_assignments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE accommodation_types      ENABLE ROW LEVEL SECURITY;
ALTER TABLE accommodation_rates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_reservations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_otps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_adjustments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quests                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_applications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_logs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_log_reviews         ENABLE ROW LEVEL SECURITY;
ALTER TABLE morning_meetings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE eumo_grants              ENABLE ROW LEVEL SECURITY;
```

- **ポリシーを1本も定義しないテーブルは、`authenticated` から見て「存在するが常に0行」**になる
  （`INSERT` は `WITH CHECK` に一致せずエラー）。これが既定の状態である。
- **RLS を有効化していないテーブルが1つでもあると、そのテーブルは `GRANT` の範囲で全開**になる。
  §6-8 のメタテストで機械的に検出する。
- ビューは RLS を持たない。**ビューの安全性は「どの列を SELECT 句に書いたか」だけで決まる**（§6-4）。

#### PII-B テーブルの共通テンプレート

PII-B（§6-1 の #5・#8〜#20・#22）は形が同じであるため、**同一のテンプレートを各テーブルへ展開**する。
所有者列（`owner_col`）だけがテーブルごとに異なる。

```sql
-- テンプレート（<T> = テーブル名、<owner_col> = 会員を指す列）
CREATE POLICY <T>_select_self  ON <T> FOR SELECT TO authenticated
  USING ( <owner_col> = (SELECT public.current_member_id()) );
CREATE POLICY <T>_select_staff ON <T> FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );
CREATE POLICY <T>_insert_staff ON <T> FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );
CREATE POLICY <T>_update_staff ON <T> FOR UPDATE TO authenticated
  USING ( (SELECT public.is_staff()) ) WITH CHECK ( (SELECT public.is_staff()) );
-- DELETE は原則ポリシーを作らない（§1-3 論理削除）
```

| テーブル | `<owner_col>` | テンプレートからの差分 |
| --- | --- | --- |
| `check_ins` | `member_id` | `<T>_insert_self` を追加（アプリ内予約／v13 §5.2.4）。UPDATE は staff のみ（チェックアウト・キャンセルは運営操作） |
| `memberships` | `member_id` | 差分なし |
| `stay_ticket_transactions` | `member_id` | 差分なし。INSERT は `staff_adjust` で `reason` NOT NULL（v13 §5.8.5） |
| `uii_transactions` | `member_id` | 差分なし（Phase 1 は稼働しないが先に張る） |
| `orders` | `purchaser_id` | `<T>_insert_self` を追加（自分の注文） |
| `order_items` | 親 `orders` 経由 | `USING ( order_id IN (SELECT order_id FROM orders) )` — 親の RLS が効くため入れ子で足りる |
| `settlement_adjustments` | 親 `orders` 経由 | 同上。免除操作は `core_member` も可（v13 §9 #2 決着） |
| `meal_reservations` | 親 `check_ins` 経由 | 同上 |
| `membership_applications` | `member_id` | **staff 版を `is_admin()` に置換**（申請一覧は admin のみ／v13 §6） |
| `work_logs` | 申請者（`quest_application` 経由） | `<T>_insert_self` を追加（完了報告は申請者本人） |
| `work_log_reviews` | ― | **`_select_self` を作らない**（評価コメントを被評価者に見せない） |
| `quest_applications` | `member_id` | `<T>_insert_self` を追加（受注申請） |
| `room_assignments` | 親 `check_ins` 経由 | `_insert_self` なし（部屋割当は staff のみ／v13 §6） |
| `media_assets` | `member_id` | `_select_self` に加え **`_select_public`**（`visibility = '公開' AND deleted_at IS NULL`）を追加。全ロールが自分の投稿を INSERT 可（v13 §5.11.7） |
| `import_jobs` / `member_import_links` | ― | `_select_self` を作らない。`is_admin()` のみ |

#### 非PII テーブルの共通テンプレート

```sql
CREATE POLICY <T>_select_all   ON <T> FOR SELECT TO authenticated USING ( true );
CREATE POLICY <T>_write_admin  ON <T> FOR ALL    TO authenticated
  USING ( (SELECT public.is_admin()) ) WITH CHECK ( (SELECT public.is_admin()) );
```

適用先: `membership_plans`・`menu_items`・`accommodation_rates`・`accommodation_types`・`work_categories`・`rooms`（`rooms` の書き込みは `is_staff()`）。
`quests` のみ差分あり — ゲストには `guest_allowed = true` の行だけを見せる:

```sql
CREATE POLICY quests_select_member ON quests FOR SELECT TO authenticated
  USING ( (SELECT public.current_member_role()) <> 'guest' );
CREATE POLICY quests_select_guest  ON quests FOR SELECT TO authenticated
  USING ( guest_allowed = true );
CREATE POLICY quests_write_staff   ON quests FOR ALL TO authenticated
  USING ( (SELECT public.is_staff()) ) WITH CHECK ( (SELECT public.is_staff()) );
```

### 6-8. RLS のテスト方法（`CLAUDE.md` §4.4 の必須要件）

`CLAUDE.md` §4.4 は「**認可・金額計算・個人情報の取り扱いに関わるロジックは必ずテストを書く**」と定めている。
RLS はその3つすべてに該当する。**ポリシーを書いただけでレビューを通さない。**

#### ① 3層のテスト

| 層 | 何を検証するか | 実装 |
| --- | --- | --- |
| **メタテスト** | 全テーブルで RLS が有効か。ポリシーの無いテーブルが無いか | SQL 1本（下記②）。**新テーブル追加時の付け忘れを機械的に検出**する |
| **ポリシー単体** | 各ポリシーの `USING` / `WITH CHECK` が意図どおりか | psql / pgTAP。トランザクション内でロールを偽装（下記③） |
| **統合** | 実際の JWT を持った Supabase クライアントから見て正しいか | `supabase-js` ＋ Jest（`tests/rls/*.test.ts`）。**PostgREST の GRANT も同時に検証できる**唯一の層 |

#### ② メタテスト（付け忘れの検出）

```sql
-- RLS が無効なテーブルが1つでもあれば失敗する
SELECT c.relname AS rls_disabled_table
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false;
-- 期待：0行

-- RLS は有効だがポリシーが0本のテーブル（意図的な全拒否か、書き忘れかを人が判断する）
SELECT c.relname
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
  AND  NOT EXISTS (SELECT 1 FROM pg_policies p
                   WHERE p.schemaname = 'public' AND p.tablename = c.relname);
-- 期待：reservation_otps のみ（§6-2⑧ の意図的な全拒否）
```

これは CI（`.github/workflows/ci.yml`）で毎回走らせる。
`docs/自律開発ループ設計.md` が「RLS ポリシーの欠落したテーブル」を独自チェック項目としているのと同じ検査である。

#### ③ SQL だけでロールを偽装する（JWT を発行せずにポリシーを試す）

```sql
BEGIN;
  -- PostgREST が行うのと同じことを手で行う：JWT クレームを session 変数へ載せ、ロールを切り替える
  SELECT set_config('request.jwt.claims',
                    json_build_object('sub', '00000000-0000-0000-0000-0000000000a1',
                                      'role', 'authenticated')::text,
                    true);   -- true = トランザクションローカル
  SET LOCAL ROLE authenticated;

  -- ここでクエリを実行して行数を検査する
  SELECT count(*) FROM member_profiles_private;   -- 期待：1（自分の行だけ）
ROLLBACK;
```

`auth.uid()` は `request.jwt.claims` の `sub` を読むため、**実際の JWT を署名しなくてもポリシーを検証できる**。
ポリシー単体テストはこの方式を使う（速い・秘密鍵が要らない）。

#### ④ 統合テスト用の JWT をどう用意するか

| 環境 | 方法 |
| --- | --- |
| **ローカル** | `supabase start` のローカルスタックは **JWT シークレットが固定値**で `supabase status` から取得できる。テストヘルパ `signTestJwt(authUserId, role)` が `jsonwebtoken` でそのシークレットを使い、`{ sub: <auth_user_id>, role: 'authenticated', aud: 'authenticated', exp }` を署名する。**シークレットはローカル既定値をコードに書かず、`supabase status -o json` から読む**（`CLAUDE.md` §3.2） |
| **CI** | `CLAUDE.md` §6.2 の警告どおり、**`E2E_SUPABASE_URL` / `E2E_SUPABASE_ANON_KEY`（テスト用プロジェクト）のみ**を使う。テストユーザーは `supabase.auth.admin.createUser()` で毎回作り、`members.auth_user_id` へ結合してから使う |
| **本番** | **テストを実行しない。** 本番の値を Secrets に入れると実名370名に対してテストが走る（`CLAUDE.md` §3.1 違反） |

- テストユーザーは **`admin` / `core_member` / `member`（本人） / `member`（他人） / `guest` / 未ログイン（`anon`）の6種**を用意する。
  「他人」役が居ないと、**最も重要な「他人の行が見えないこと」を検証できない。**
- フィクスチャは**実データを一切参照せず自作**する（`CLAUDE.md` §3.2・§7.1）。氏名は架空のダミー
  （例: `テスト 太郎` / `フユウ ハナコ`）、メールは `@example.invalid` を使う。

#### ⑤ 「できる」「できない」を対で書く

**片方だけのテストは通ってしまう。** 全ポリシーについて、許可される操作と拒否される操作を必ず対で書く。

| # | できる（許可） | できない（拒否） |
| ---: | --- | --- |
| 1 | 一般会員は**自分の** `member_profiles_private` を1行 SELECT できる | 一般会員は**他人の** `member_profiles_private` を SELECT すると**0行**になる（エラーではなく0行である点に注意） |
| 2 | `core_member` は全会員の `member_profiles_private` を SELECT できる | **`member_type = '親方'` の一般会員は他人の行を SELECT できない**（立場と権限の分離／v13 §2） |
| 3 | 一般会員は自分の `nickname` を UPDATE できる | 一般会員は自分の `role` を `'admin'` へ UPDATE できない（列単位 GRANT で拒否／§6-6） |
| 4 | 一般会員は自分の `member_identifiers` を `is_verified = false` で INSERT できる | 一般会員は `is_verified = true` で INSERT できない／既存行の `is_verified` を UPDATE できない |
| 5 | `core_member` は `visibility = 'core_only'` の `member_notes` を読める | **本人は自分についての `member_notes` を1行も読めない**／`core_member` は `admin_only` を読めない |
| 6 | 一般会員は `v_member_public` から全会員の `display_name` を読める | `v_member_public` に `full_name` は存在しない（列自体が無い） |
| 7 | ニックネーム未設定の会員は `街人#10xxx` として表示される | **`display_name` に本名が現れることは無い**（§5.2c の不可侵ルールの回帰テスト） |
| 8 | `admin` は `reservation_otps` を…**読めない**（service_role のみ） | `anon` / `authenticated` / `admin` のいずれも `reservation_otps` を SELECT できない |
| 9 | 未ログイン（`anon`）は `v_room_availability` を…**読めない** | `anon` はいかなるテーブルも SELECT / INSERT できない（§6-6①） |
| 10 | `member` は自分の `orders` を INSERT できる | `member` は他人の `purchaser_id` を指定した `orders` を INSERT できない |
| 11 | 退会前の会員は自分の行を読める | **`account_status = 'withdrawn'` にした直後、本人ポリシーが即座に不成立になる**（`current_member_id()` が NULL を返す） |
| 12 | `auth_user_id` が NULL の `pre_registered` 会員の行は staff から見える | `pre_registered` の行は**どの一般会員セッションからも見えない**（370名の移行直後の状態） |

テスト名は日本語の文で書く（`CLAUDE.md` §4.4）:

```ts
test('一般会員は他人の member_profiles_private を1行も取得できない', async () => { ... });
test('member_type が親方の一般会員でも他人の氏名は取得できない', async () => { ... });
test('ニックネーム未設定の会員の display_name に本名が含まれない', async () => { ... });
```

#### ⑥ 回帰テストとして残すもの

- **`v_member_public` の列構成**をスナップショットで固定する。列が増えた PR を検知する（§6-4 の danger）。
- **`members` の列単位 GRANT** を `information_schema.column_privileges` から検査し、
  `role`・`auth_user_id`・集計キャッシュ3種に `authenticated` の UPDATE が付いていないことを確認する。

### 6-9. 本節の設計で解消できなかった論点（`QUESTIONS.md` 起票候補）

**本書では決定しない。** 実装着手前にオーナー確認が必要な事項として列挙する。

| # | 論点 | なぜ問題か |
| ---: | --- | --- |
| ① | **宿泊法の「住所・前泊地・後泊地」の物理的な格納先が未定義** | v13 §5.2 は収集必須、§9 #30-② は「チェックイン時に収集」と定めるが、`check_ins` のカラム定義（v13 §7）にこの3項目が無い。`address` は `member_profiles_private` にあるが、**前泊地・後泊地は「滞在ごと」に変わるため会員マスタには置けない**。[[データモデル図_ER_Diagram]] は `PROFILES.previous_residence` / `next_destination` に置いており、設計間で不一致 |
| ② | **`core_member` の「自拠点のみ」をRLSで表現できない** | v13 §6 は顧客管理・部屋割当等を「コアメンバーは**自拠点**」と限定しているが、`members` に拠点を示す列が無い（`rooms.place_id` は存在する）。本節のポリシーは `core_member` に**全拠点**を許可しており、**v13 §6 より緩い** |
| ③ | **退会30日後の匿名化の具体仕様が未定義** | v13 §2 が「30日後匿名化」と定めるのみ。`member_profiles_private` の値をダミーへ UPDATE する想定だが、**旅館業法の宿泊者名簿保存義務（3年）と衝突する可能性**がある。どちらが優先するかは法務判断 |
| ④ | **Realtime（再訪アラート）のペイロード** | [[非機能要件詳細]] §7-3 F-3 の未解決事項。`postgres_changes` は RLS 準拠で配信されるが、**再訪アラートは氏名＋運営メモを含む**。`member_profiles_private` / `member_notes` を購読対象にするか、ID のみ配信して詳細は認可済みAPIで取るかが未決 |
| ⑤ | **`member_notes.visibility` の値域**（`core_only` のみか、`admin_only` を含む2値か） | 文書間で不一致（§6-2⑤）。実体は Vault 側 `01_schema.sql` にあり本リポジトリから確認できない |
| ⑥ | **`role` の値域に `custom` を含めるか** | v13 §2 は5値（`custom` あり）、[[会員データモデル_ユーザーテーブル定義]] §5.2 は4値。`custom` の権限内容が未定義のため、**本節のポリシーは `custom` を「`member` 相当（staff ではない）」として扱っている** |
| ⑦ | **`member_type` の値域**（3値か4値か） | v13 §2 は `親方`/`街人（コア）`/`街人（一般）`/`ゲスト` の4値、会員データモデル §5.2 は3値。認可には使わないため RLS には影響しないが、§6-4 の `display_name` の接頭辞判定が値に依存する |
| ⑧ | **正本 §8 の「`contact_info` のユニーク制約で二重取込を防ぐ」が成立していない** | §5.3 のユニークは `WHERE is_verified = true` の部分ユニークであり、**移行時は全件 `is_verified = false` のため制約が効かない**。A案とは独立した既存の穴（[[会員データモデル_ユーザーテーブル定義]] §6.5） |
| ⑨ | **`v_member_public` を `anon` へ開けるか** | 公開予約ページ `/reserve` はログイン不要だが、クエストボードの公開範囲は未定義。現設計は `authenticated` 限定 |

### 6-10. 本節の適用範囲外（既存方針の再掲）

- Cloud Storage for Firebase（メディア）への署名付きURL発行は Supabase Edge Function 経由に一元化し、
  **Firebase Security Rules 側には認可ロジックを置かない**（v13 §5.11.2・§9 #9、[[システムアーキテクチャ]]）。
  RLS が守るのは `media_assets` の**メタデータ行**であり、ファイル実体の保護は署名付きURLの TTL が担う。
- 詳細な機能単位の権限マトリクスは v13 §6 を正とする。本節はそれを DB の行単位アクセスへ写像したものであり、
  **両者が食い違った場合は v13 §6 が勝つ**（`CLAUDE.md` §1.1）。

---

## 7. Phase 1スコープとの突合（過不足整理）

| WBS機能領域 | 対応テーブル | 状態 |
| --- | --- | --- |
| 2. 認証・アカウント基盤 | `members`, **`member_profiles_private`**, `member_identifiers`, `member_notes`, `membership_plans`, `memberships`, `stay_ticket_transactions` | 既存（Vault側で実装・検証済み）。**2026-09-05：`member_profiles_private` を新設し `members.auth_user_id` を追加**（§2・§6-0）。⚠️ 本表は従来 `member_notes` 等を落としていた。**RLS 適用対象の正は §6-1 の一覧表**とする |
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
| 9 | **RLS 設計で解消できなかった論点9件**（宿泊法項目の格納先／`core_member` の自拠点スコープ／退会後の匿名化と名簿保存義務の衝突／Realtime のペイロード／`member_notes.visibility` の値域／`role` の `custom` ／`member_type` の値域／`contact_info` ユニークの空振り／`v_member_public` の `anon` 公開） | **新規（2026-09-05・§6-9）**。`QUESTIONS.md` 起票候補。本書では決定していない |
| 8 | `media_assets`：AI解析（~~Gemini~~ → **Claude**／2026-08-29変更）のコスト・レイテンシ、動画サムネイル生成・保存容量の見積り、肖像権チェックの要否。※ 写真AI判定（収穫可否・設備点検・献立提案）は **2026-08-29 に LINE（`line-rag-bot`）側での実装（A案）へ確定**したため、**本テーブルの解析コストには含まれない**（v13 §9 #56） | 新規（2026-08-16、画面設計.md §6 #5〜#7と同一論点） |

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
| **2026-08-23** | **Googleフォーム廃止・公開予約ページ化に伴うスキーマ改訂（v13 §9 #46〜#49）**。①**§3-6 を全面改訂**：中間テーブル `reservation_form_submissions` の構想を**撤回**（外部フォームの生回答が存在しなくなったため）。代わりに **`meal_reservations`**（カフェ事前予約注文。提供時に `orders` へ変換し、予約時点では伝票を作らない）と **`reservation_otps`**（公開予約ページの本人確認。平文コードを保存せずハッシュのみ）を新設。②**§3-11 `reservation_source` に `web_public` を追加**し既定値を変更。`google_form` は過去データ用に残す。③**§3-12 残枠ビューを全面改訂**：算出元を `room_assignments` → **`check_ins`（宿泊形態単位）**へ変更し、**`accommodation_types.allocation_mode`（`per_person` / `per_unit`）による2モード算出**を導入（コテージを人数で数えると1名予約3件で実質満室なのに「残り3名」と表示される問題を解消）。④**`menu_items` に `is_pre_orderable` / `meal_slot` を追加**し、カテゴリに「送迎・オプション」を追加（送迎 1,900円＝1,520Uii・片道は専用マスタを作らず本テーブルで扱う）。 |
| **2026-08-20（v13 v1.15.0 反映）** | **8/13レビュー未反映分の一括反映（v13 §9 #33〜#43）に伴うスキーマ改訂**。①**§3-1 二段階承認**：`work_logs.approval_status` を `報告済み/コアメンバー確認済/承認完了/差戻し` へ変更し、`reviewed_by`（確認者）と `approved_by`（最終承認者＝admin）を**別カラムで保持**。`review_skipped`・差戻し理由の CHECK 制約・`work_log_reviews`（2人目以降の確認ログ）を追加。②**§3-2 提供ステータス**：`orders.serving_status`（未提供／提供済み）・`served_at`・`served_by` を追加し、決済ステータスと独立した2軸に。「精算済みだが未提供」検出用の部分インデックスも新設。③**§3-7 メディア**：`visibility`（公開／運営のみ）・`deleted_at`（論理削除・運営措置）・`place_id`・`taken_at`・`geo_location` を追加。**用途タグ最低1つ必須**の CHECK 制約を新設（Phase 2 の検索精度を担保）。`ai_*` 系は Phase 2 用にカラムのみ用意。④**§3-8 `eumo_grants` を新設**：`未送付→送付済→受領確認済` を追跡。送付と受領を別状態で保持。⑤**§3-9 `menu_items` / §3-10 `accommodation_rates` を新設**：Uii価格は保存せず都度算出。宿泊料金は `EXCLUDE USING gist` で適用期間の重複を防止し、過去予約を当時の料金で再計算可能に。⑥**§3-11 `check_ins.reservation_source` を追加**：アプリ内予約とフォーム経由を同一テーブルで扱い経路のみ区別。⑦**§3-12 `v_room_availability` ビューを新設**：残枠を**保存せず都度算出**（ダブルブッキング防止）。§7突合表に15〜20番を追加。 |
