-- =============================================================================
-- WBS 5-1：クエストマスタ（work_categories / quests）
--
-- 根拠: v13 §5.3-1（手動登録と朝会自動抽出の統合表示）・§7「クエスト情報」、
--       v13 §5.10.6（ゲスト開放は `guest_allowed` のみで制御し、カテゴリ・`execution_mode`
--       から導出しない）、DB物理設計.md §3-1（本ファイルの DDL の出どころ）
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : work_categories / quests のスキーマ・制約・索引
--   含まない:
--     - RLS・GRANT・表示用ビュー            → 0008（同じ 5-1。関心が違うので分ける）
--     - quest_applications（受注申請の台帳） → WBS 5-2
--     - 業務カテゴリのマスタ管理 UI と初期行 → 別パッケージ。
--       ここで初期行を入れると 15 業務ドメインの定義を実装側が決めることになる
--
-- `work_categories` を同時に作るのは、`quests.category_id` が参照するためだけである
-- （カテゴリはゲストの施錠カードにも出してよい項目／v13 §5.10.6 末尾）。
-- =============================================================================


-- =============================================================================
-- ① work_categories（業務カテゴリ）
-- =============================================================================

CREATE TABLE public.work_categories (
  category_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 15業務ドメインの通し番号（[[業務カテゴリ体系とAIエージェント設計]]）
  domain_no          integer NOT NULL,

  name               text NOT NULL
                       CONSTRAINT chk_work_categories_name_present CHECK (btrim(name) <> ''),

  parent_category_id uuid REFERENCES public.work_categories (category_id),

  -- ランド／ホスピタリティ／イベント等。値域はエージェント設計側が持つため CHECK を付けない
  agent_type         text,

  rag_structure_type text
                       CONSTRAINT chk_work_categories_rag_structure_type
                       CHECK (rag_structure_type IN ('recipe', 'judgment', 'regulation')),

  is_tenant_specific boolean NOT NULL DEFAULT false,

  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_work_category_parent ON public.work_categories (parent_category_id);

COMMENT ON TABLE public.work_categories IS
  '業務カテゴリ（DB物理設計 §3-1）。クエストの分類と RAG の構造型を担う。'
  'カテゴリ名は施錠クエストでもゲストへ返してよい（v13 §5.10.6 末尾）。';


-- =============================================================================
-- ② quests（クエスト）
-- =============================================================================

CREATE TABLE public.quests (
  quest_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title                  text NOT NULL
                           CONSTRAINT chk_quests_title_present CHECK (btrim(title) <> ''),

  -- ★ 指示内容。**ゲストの施錠クエストでは返さない**（v13 §5.10.6 末尾）。
  --    列そのものは全員分が1つの表にあるため、絞るのは 0008 の v_quest_board 側で行う。
  description            text,

  category_id            uuid REFERENCES public.work_categories (category_id),

  difficulty             text,
  base_hours             numeric,
  recruit_count          integer NOT NULL DEFAULT 1
                           CONSTRAINT chk_quests_recruit_count_positive CHECK (recruit_count > 0),

  -- 拠点参照。`places` は FEL 共通スキーマ側で未作成のため FK は張らない（§3-1 のとおり）
  place_id               uuid,

  -- ★ 起案元区分。手動起案と朝会自動抽出を**1つの一覧に混ぜる**ための列（v13 §5.3-1）。
  --   一覧を分ける用途ではなく、カード上の出どころ表示に使う。
  origin_type            text NOT NULL DEFAULT 'manual'
                           CONSTRAINT chk_quests_origin_type
                           CHECK (origin_type IN ('manual', 'morning_meeting_auto')),

  execution_mode         text NOT NULL DEFAULT 'onsite'
                           CONSTRAINT chk_quests_execution_mode
                           CHECK (execution_mode IN ('onsite', 'remote', 'hybrid')),

  -- 安全ゲート。会員マスタの certifications と照合する（v13 §5.3-2）。
  -- 街人登録では解放されない軸であり、guest_allowed とは独立に判定する
  required_certification text[],

  -- ★ ゲスト開放。**運営が明示制御する唯一の根拠**であり、カテゴリや execution_mode から
  --   導出してはならない（v13 §5.10.6 冒頭。導出すると資格要件と判定が混線し、
  --   資格の要る作業をゲストへ開放する事故になる）。
  guest_allowed          boolean NOT NULL DEFAULT false,

  reward_uii             integer,

  status                 text NOT NULL DEFAULT 'open'
                           CONSTRAINT chk_quests_status
                           CHECK (status IN ('open', 'closed', 'archived')),

  created_by             uuid REFERENCES public.members (member_id),

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_quest_status ON public.quests (status);

-- 解放件数バナーの N（`guest_allowed = false` かつ `status = 'open'` の件数／v13 §5.10.6）は
-- ゲストが一覧を開くたびに数える。部分索引でその集計だけを支える
CREATE INDEX ix_quest_guest_allowed ON public.quests (guest_allowed) WHERE status = 'open';

COMMENT ON TABLE public.quests IS
  'クエスト（v13 §5.3・§7）。物理削除せず status = archived で退役させる（DB物理設計 §1-3）。'
  'ゲスト開放は guest_allowed のみで判定し、カテゴリ等から導出しない（v13 §5.10.6）。';

COMMENT ON COLUMN public.quests.guest_allowed IS
  'ゲストへの開放。false でも一覧からは隠さず施錠表示する（v13 §5.10.6）。行の可視性は 0008 の RLS、'
  '詳細列の非開示は v_quest_board が担う。';


-- =============================================================================
-- ③ RLS の有効化（デフォルト拒否／DB物理設計 §6-7）
--
--   ポリシー未定義 ＝ 全拒否。ポリシー本体と GRANT は 0008 で置く。
--   **この2行を 0008 側へ書かない。** テーブル作成と RLS 有効化の間に隙間を作らないため。
-- =============================================================================

ALTER TABLE public.work_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quests          ENABLE ROW LEVEL SECURITY;
