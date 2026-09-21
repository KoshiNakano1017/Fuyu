-- =============================================================================
-- WBS 3-4：宿泊券管理・消費／付与ロジック（`membership_plans` / `stay_ticket_transactions`）
--
-- 根拠: v13 §5.8.5（宿泊日数の運営制御・**残高は取引履歴の積み上げで算出**）、
--       v13 §7「★ 会員プランマスタ」（#51 決着・2026-09-01）、
--       v13 §5.2.2（チェックイン前のキャンセルでは消費が起きていない）、
--       v13 §9 #15（付与は4泊。マスタ参照とし画面・コードへ直書きしない）
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : membership_plans（2プラン）／stay_ticket_transactions ／残高算出関数
--           ／RLS・GRANT
--   含まない:
--     - 街人登録申込フロー（付与の起点）      → WBS 12-1・12-2
--     - 顧客管理画面からの手動増減 UI         → WBS 8-1
--     - Uii 残高（`uii_transactions`）         → Phase 2（v13 §5.5）
--
-- ── 設計上動かしてはならない点 ────────────────────────────────
--   **残高カラムを持たない。** v13 §5.8.5 が「チェックアウト時の自動消費と手動調整の
--   2系統が同一残高に作用するため、残高は取引履歴の積み上げ（イベントソーシング）で
--   算出し、直接上書きしない」と明記している。残高列を足すと、2系統のどちらかが
--   更新を落とした時点で静かにずれる（§9 #25 の集計キャッシュ禁止と同じ原則）。
-- =============================================================================


-- =============================================================================
-- ① membership_plans（会員プランマスタ）
--
--   v13 §7「★ 会員プランマスタ」の項目をそのまま起こす。
--   **泊数・キャッシュバック額をコードへ直書きしないための表**である（§9 #15）。
-- =============================================================================

CREATE TABLE public.membership_plans (
  plan_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 機械的な判別キー。表示名はリネームされうるので、実装はこちらで引く。
  plan_code           text NOT NULL UNIQUE
                        CONSTRAINT chk_membership_plans_code_present CHECK (btrim(plan_code) <> ''),

  display_name        text NOT NULL
                        CONSTRAINT chk_membership_plans_name_present CHECK (btrim(display_name) <> ''),

  -- 年会費額（円）。既存会員のプラン判別キーでもある（v13 §5.10.8）。
  annual_fee_yen      integer NOT NULL
                        CONSTRAINT chk_membership_plans_fee_non_negative CHECK (annual_fee_yen >= 0),

  -- ★ 付与宿泊券枚数。v13 §9 #15 の確定値は 4。**画面・コードへ直書きしない**ための列。
  granted_stay_nights integer NOT NULL
                        CONSTRAINT chk_membership_plans_nights_non_negative CHECK (granted_stay_nights >= 0),

  -- ★ 初回キャッシュバック額。**単位は uii（コイン）であって円ではない**（v13 §9 #51 決着）。
  --   円と取り違えると付与額が 1.25 倍ずれる。列名に単位を含めて取り違えを防ぐ（CLAUDE.md §4.1）。
  first_cashback_uii  integer NOT NULL DEFAULT 0
                        CONSTRAINT chk_membership_plans_cashback_non_negative CHECK (first_cashback_uii >= 0),

  -- 会員権の有効月数（`会員データモデル_ユーザーテーブル定義.md` §5.4。全プラン 24）。
  term_months         integer NOT NULL DEFAULT 24
                        CONSTRAINT chk_membership_plans_term_positive CHECK (term_months > 0),

  -- 新規の街人登録導線（v13 §5.10.2）が既定で引くプランは1つだけである。
  -- 過去プランは判別・表示のために残すが、新規登録では選ばせない。
  is_current_signup_plan boolean NOT NULL DEFAULT false,

  -- 適用期間（v13 §7）。プラン改定は上書きせず期間を区切って新しい行を足す。
  effective_from      date NOT NULL DEFAULT current_date,
  effective_to        date,

  note                text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_membership_plans_period CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE public.membership_plans IS
  '会員プランマスタ（v13 §7 ／ §9 #15・#51）。付与泊数とキャッシュバック額の唯一の出どころ。'
  '画面・コードへ直書きしてはならない。改定は上書きせず適用期間を区切って行を追加する。';

COMMENT ON COLUMN public.membership_plans.first_cashback_uii IS
  '初回キャッシュバック額。単位は uii（コイン）であり円ではない（v13 §9 #51 決着・2026-09-01）。';

-- 新規登録が引くプランは常に1つ。2行立つと街人登録の付与内容が不定になる。
--
-- 真偽列そのものへ部分一意インデックスを張る。述語で `true` の行だけに絞っているため、
-- 索引に載る行はすべて同じ値（true）になり、**2行目が一意制約で弾かれる**。
-- 定数式（`((true))`）を書く書き方もあるが、こちらのほうが読んで意図が分かる。
CREATE UNIQUE INDEX uq_membership_plans_current_signup
  ON public.membership_plans (is_current_signup_plan)
  WHERE is_current_signup_plan;

-- 初期4行。出典は `会員データモデル_ユーザーテーブル定義.md` §5.4 のプラン表である。
-- ⚠️ 個人情報は含まない。プランは商品定義であり会員データではない（CLAUDE.md §7.1・§3.2）。
--
-- ── 「2プラン化」（v13 §9 #51）との関係 ──────────────────────────
--   v13 §9 #51 の「`membership_plans` を2プラン化」は**キャッシュバックが年会費額で2段階**
--   （40,000円 → 10,000 uii ／ 30,000円 → 5,000 uii）という意味であり、
--   **過去プランの行を消すという意味ではない**。判別キーが「年会費額」である（v13 §5.10.8）以上、
--   行を減らすと既存街人がどのプランで入ったかを引けなくなる。
--
--   実際、両文書は**キャッシュバック額で完全に一致している**（40,000円の2プランとも 10,000、
--   30,000円の2プランとも 5,000）。食い違うのは付与泊数のみで、これは同じ年会費でも
--   募集時期によって 7泊／6泊 と異なっていたという歴史的事実である。
--
--   新規登録（v13 §5.10.2・§9 #15 の「4泊＋5,000 uii」）が引くのは `phase3` ただ1行であり、
--   `is_current_signup_plan` で一意に特定できるようにした。ここを年会費額で引くと
--   30,000円の2行（`phase2_standard`／`phase3`）のどちらが当たるかが不定になる。
INSERT INTO public.membership_plans
  (plan_code, display_name, annual_fee_yen, granted_stay_nights, first_cashback_uii,
   term_months, is_current_signup_plan, note) VALUES
  ('phase1',          '[第一弾]',            40000, 7, 10000, 24, false,
   '過去プラン。既存街人の判別用に残す（v13 §5.10.8）'),
  ('phase2_standard', '[第二弾]通常',        30000, 4,  5000, 24, false,
   '過去プラン。既存街人の判別用に残す'),
  ('phase2_hyper',    '[第二弾]ハイパー',    40000, 6, 10000, 24, false,
   '過去プラン。年会費は phase1 と同額だが付与泊数が異なる'),
  ('phase3',          'アプリ登録（新規）',  30000, 4,  5000, 24, true,
   '★ 現行の街人登録導線（v13 §5.10.2・§9 #15）。宿泊券4枚＋キャッシュバック 5,000 uii');


-- =============================================================================
-- ② stay_ticket_transactions（宿泊券の取引明細）
--
--   ★ Phase 1 で稼働する唯一の宿泊券テーブル。**残高はここの合計である。**
-- =============================================================================

CREATE TABLE public.stay_ticket_transactions (
  tx_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  member_id   uuid NOT NULL REFERENCES public.members (member_id),

  -- initial_grant = 取込時の初期値（v13 §5.8.5「初期入力」）
  -- plan_grant    = 街人登録による付与（§5.10.4。枚数は membership_plans から取る）
  -- consume       = チェックアウト時の自動消費（§5.2.2 の note：消費はチェックアウト時に起きる）
  -- gift          = 会員間の譲渡
  -- expiry        = 期限切れ
  -- staff_adjust  = 運営による手動増減（§5.8.5。理由入力が必須）
  tx_type     text NOT NULL
                CONSTRAINT chk_stay_tx_type
                CHECK (tx_type IN ('initial_grant', 'plan_grant', 'consume', 'gift', 'expiry', 'staff_adjust')),

  -- ★ 符号付き。consume / expiry は負値で入れる。
  --   「枚数」ではなく「泊数」であることを名前に含める（v13 は宿泊券1枚＝1泊）。
  nights      integer NOT NULL
                CONSTRAINT chk_stay_tx_nights_not_zero CHECK (nights <> 0),

  -- 消費の出どころ。チェックアウト時の自動消費がどの滞在に対応するかを辿れるようにする。
  -- 手動調整（staff_adjust）では NULL。
  checkin_id  uuid REFERENCES public.check_ins (checkin_id),

  -- ★ 理由。v13 §5.8.5「増減操作時は理由の入力を必須とする」。
  --   自動消費（consume）は操作者が居ないため必須にしない。手動系だけ CHECK で縛る。
  reason      text,

  operator_id uuid REFERENCES public.members (member_id),

  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- ★ 運営の手動増減は「理由なし」を物理的に作れなくする（§5.8.5・§5.6.4 の編集理由必須ルール）。
  --   画面側のバリデーションだけに頼ると、API を直接叩く経路で理由なしの増減が通る。
  CONSTRAINT chk_stay_tx_manual_needs_reason CHECK (
    tx_type <> 'staff_adjust'
    OR (btrim(coalesce(reason, '')) <> '' AND operator_id IS NOT NULL)
  ),

  -- 消費・失効は必ず減算である。符号の取り違えで残高が増える事故を DDL で塞ぐ。
  CONSTRAINT chk_stay_tx_consume_is_negative CHECK (
    tx_type NOT IN ('consume', 'expiry') OR nights < 0
  ),

  -- 付与は必ず加算である。
  CONSTRAINT chk_stay_tx_grant_is_positive CHECK (
    tx_type NOT IN ('initial_grant', 'plan_grant') OR nights > 0
  )
);

COMMENT ON TABLE public.stay_ticket_transactions IS
  '宿泊券の取引明細（v13 §5.8.5）。★ 残高カラムを持たず、本表の合計を残高とする'
  '（チェックアウト時の自動消費と運営の手動調整が同一残高に作用するため）。'
  '消費はチェックアウト時に起きる。チェックイン前のキャンセルでは消費が起きていない（§5.2.2）。';

CREATE INDEX ix_stay_tx_member ON public.stay_ticket_transactions (member_id, occurred_at DESC);

-- ★ 1つのチェックアウトから2重に消費を作らない（再実行・二度押しへの防御）。
--   イベントソーシングは「同じイベントを2回積むと残高が壊れる」のが唯一の弱点であり、
--   そこだけは DB のユニーク制約で塞ぐ。
CREATE UNIQUE INDEX uq_stay_tx_consume_per_checkin
  ON public.stay_ticket_transactions (checkin_id)
  WHERE tx_type = 'consume';


-- =============================================================================
-- ③ 残高の算出（v13 §5.8.5「取引履歴の積み上げで算出」）
--
--   関数にしておくのは、SUM の書き方を画面ごとに再発明させないため。
--   `SECURITY INVOKER`（既定）のままにする ＝ 呼び出し元の RLS がそのまま効き、
--   他人の残高を覗く経路にならない。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.stay_ticket_balance(p_member_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(t.nights), 0)::integer
  FROM   public.stay_ticket_transactions t
  WHERE  t.member_id = p_member_id
$$;

COMMENT ON FUNCTION public.stay_ticket_balance(uuid) IS
  '宿泊券残高（v13 §5.8.5）。取引明細の合計であり、保存カラムではない。'
  'SECURITY INVOKER のままにしてあるため、呼び出し元から見えない行は合計に入らない。';

-- ⚠️ `members.stay_tickets`（0001 L75）との関係
--    あちらは会員データ取込（WBS 10-x）が埋める**集計キャッシュ**であり、
--    `0005` の GRANT UPDATE 列リストから意図的に外されている（authenticated からは書けない）。
--    `DB物理設計.md` §6-6b④ が要求する再計算トリガー（`app.balance_recalc` 旗）は
--    **まだ実装されていない**。したがって本パッケージでは `members.stay_tickets` を一切書かない。
--    残高を読む場所は本関数ただ1つとし、二重管理を作らない（v13 §9 #25）。
--    再計算トリガーを入れるのは、取込（10-x）と本表の双方が揃ってからでよい。

REVOKE EXECUTE ON FUNCTION public.stay_ticket_balance(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.stay_ticket_balance(uuid) TO   authenticated;


-- =============================================================================
-- ④ RLS（§6-7 デフォルト拒否）
-- =============================================================================

ALTER TABLE public.membership_plans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stay_ticket_transactions   ENABLE ROW LEVEL SECURITY;

-- ── membership_plans：読みは authenticated 全員（料金表示）、書き込みは admin のみ ──
CREATE POLICY membership_plans_select_all ON public.membership_plans
  FOR SELECT TO authenticated
  USING ( true );

CREATE POLICY membership_plans_insert_admin ON public.membership_plans
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_admin()) );

CREATE POLICY membership_plans_update_admin ON public.membership_plans
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_admin()) )
  WITH CHECK  ( (SELECT public.is_admin()) );

-- ── stay_ticket_transactions：本人は自分の履歴を読める（マイログ／v13 §5.8.5「本人への反映」）──
CREATE POLICY stay_tx_select_self ON public.stay_ticket_transactions
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY stay_tx_select_staff ON public.stay_ticket_transactions
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- ★ INSERT は staff のみ。本人に書かせると自分の宿泊券を増やせる（v13 §6 権限マトリクス）。
CREATE POLICY stay_tx_insert_staff ON public.stay_ticket_transactions
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- UPDATE / DELETE：ポリシーを作らない ＝ 全拒否。
--   取引明細は**追記専用**である。過去の明細を書き換えられると、
--   残高の根拠（イベントソーシング）が成立しなくなる。訂正は逆仕訳を1行足して行う。


-- =============================================================================
-- ⑤ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.membership_plans         FROM anon, authenticated;
REVOKE ALL ON public.stay_ticket_transactions FROM anon, authenticated;

GRANT SELECT         ON public.membership_plans         TO authenticated;
GRANT INSERT, UPDATE ON public.membership_plans         TO authenticated;  -- 行は RLS で admin のみ
GRANT SELECT, INSERT ON public.stay_ticket_transactions TO authenticated;  -- UPDATE/DELETE は与えない
