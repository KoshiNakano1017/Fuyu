-- =============================================================================
-- WBS 6-4：カフェメニューマスタ（`menu_items`）／WBS 6-3：売り切れ（SOLDOUT）トグル
--
-- 根拠: v13 §5.4.2①（カフェメニューマスタ・Uii価格は保存しない・操作権限）、
--       v13 §5.4.2③（送迎を専用マスタではなく本表のカテゴリとして扱う／§9 #49）、
--       v13 §5.4.3（`ec_url`／Phase 2・§9 #53）、v13 §7「★ カフェメニューマスタ」、
--       `DB物理設計.md` §3-9 L531-563（本 DDL の出どころ）、
--       `docs/spec/requirements/カフェメニュー.md`（正本 v1。初期31行の出どころ）、
--       `API設計.md` §2-5b（`POST /api/menu-items` は **Uii価格を受け取らない**）
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : menu_items のスキーマ・制約・索引・RLS・GRANT・初期32行
--           ＋ SOLDOUT トグルだけをコアメンバーへ開ける列単位 GRANT（WBS 6-3）
--   含まない:
--     - マスタ管理画面 C13                      → 同パッケージのアプリ層
--     - 宿泊料金マスタ `accommodation_rates`    → WBS 3-9（#55 でブロック中）
--     - 伝票・注文（`orders`／`order_items`）    → 0019（WBS 6-1・6-5・7-2）
--
-- ── 動かしてはならない点 ──────────────────────────────────
--   **Uii 価格の列を作らない。** `floor(単価 × 0.8)` を都度算出する（v13 §5.4.2①・§5.5）。
--   保存すると単価改定のたびに二重管理になり、商品カードの Uii と伝票合計がずれる。
--   算出は `src/lib/uii.ts` の `toUii()` ただ1箇所で行う。
-- =============================================================================


-- =============================================================================
-- ① menu_items
-- =============================================================================

CREATE TABLE public.menu_items (
  menu_item_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name             text NOT NULL
                     CONSTRAINT chk_menu_items_name_present CHECK (btrim(name) <> ''),

  -- v13 §5.4.2① の4値。送迎は専用マスタを作らず「送迎・オプション」として本表に入れる。
  category         text NOT NULL
                     CONSTRAINT chk_menu_items_category
                     CHECK (category IN ('フード', 'ドリンク', '直売所', '送迎・オプション')),

  -- 画面の見出し分け（ごはん／サイドメニュー／自家製スカッシュ／ラテ／
  -- 自家製ハーブティ／スムージー／送迎）。`カフェメニュー.md` が6節に分けて掲げており、
  -- `category` の4値では節を復元できないため、表示用の下位区分として持つ。
  -- ⚠️ 認可・料金・事前予約の判定には使わない（表示順の手がかりに限る）。
  subcategory      text,

  -- ★ 円単価。**Uii は保存しない**（v13 §5.4.2①）。
  unit_price_yen   integer NOT NULL
                     CONSTRAINT chk_menu_items_price_non_negative CHECK (unit_price_yen >= 0),

  description      text,

  -- ⚠️ `media_assets` は未作成（WBS 2-1c ／ `QUESTIONS.md`「[2026-09-20] `media_assets` の
  --    列構成が…食い違う」が未回答）。`0006` の `rooms.place_id` と同じく **FK を張らず値だけ持つ**。
  --    `media_assets` を作る作業パッケージが次の ALTER を足すこと:
  --      ALTER TABLE public.menu_items
  --        ADD CONSTRAINT fk_menu_items_image
  --        FOREIGN KEY (image_media_id) REFERENCES public.media_assets (media_id);
  image_media_id   uuid,

  display_order    integer NOT NULL DEFAULT 0,

  -- ★ SOLDOUT トグル（WBS 6-3）。**コアメンバーも操作できる唯一の列**（v13 §5.4.2①）。
  --   現場で即座に切り替える必要があるため。制御は下の列単位 GRANT ＋ ポリシーで行う。
  is_sold_out      boolean NOT NULL DEFAULT false,

  is_published     boolean NOT NULL DEFAULT true,

  -- 季節メニュー用の有効期間。物理削除の代わりに使う（過去伝票が参照するため）。
  available_from   date,
  available_until  date,

  -- ▼ 宿泊予約時の事前予約注文（v13 §5.4.1b ／ §9 #48）
  is_pre_orderable boolean NOT NULL DEFAULT false,
  meal_slot        text
                     CONSTRAINT chk_menu_items_meal_slot
                     CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner')),

  -- 外部ECの商品ページURL（v13 §5.4.3・§7 ／ Phase 2 で使用）。
  -- Phase 1 では値を入れないが列は持つ。後から足すと全件の再登録が要るため（v13 §7 の note）。
  ec_url           text,

  created_by       uuid REFERENCES public.members (member_id),
  updated_by       uuid REFERENCES public.members (member_id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_menu_items_available_period
    CHECK (available_until IS NULL OR available_from IS NULL OR available_until >= available_from),

  -- 事前予約の対象は時間帯が決まっていないと、宿泊予約画面の朝／昼／夜のどこにも出せない。
  CONSTRAINT chk_menu_items_pre_orderable_has_slot
    CHECK (NOT is_pre_orderable OR meal_slot IS NOT NULL)
);

COMMENT ON TABLE public.menu_items IS
  'カフェメニューマスタ（v13 §5.4.2① ／ DB物理設計 §3-9）。★ Uii価格は保存せず floor(単価×0.8) を'
  '都度算出する。物理削除しない（is_published / 有効期間で非表示にする。過去伝票が参照するため）。'
  '送迎は専用マスタを作らずカテゴリ「送迎・オプション」として本表で扱う（v13 §5.4.2③）。';

COMMENT ON COLUMN public.menu_items.unit_price_yen IS
  '円単価。Uii は保存しない。表示・計上時に floor(unit_price_yen × 0.8) を都度算出する（v13 §5.5）。';

COMMENT ON COLUMN public.menu_items.is_sold_out IS
  'SOLDOUT トグル（v13 §5.4.2①）。★ 管理者に加えてコアメンバーも切り替えられる唯一の列。'
  '送迎の対応不可時間帯もこの旗で表現する（専用の休止フラグを作らない／§5.4.2③）。';

CREATE INDEX ix_menu_published     ON public.menu_items (display_order) WHERE is_published = true;
CREATE INDEX ix_menu_category      ON public.menu_items (category)      WHERE is_published = true;
CREATE INDEX ix_menu_pre_orderable ON public.menu_items (meal_slot)
  WHERE is_pre_orderable = true AND is_published = true;


-- =============================================================================
-- ② RLS（§6-1 #25：非PII。読みは authenticated 全員、書き込みは admin）
--
--   ★ 非PIIテンプレート（§6-7）をそのまま当てると
--     「SOLDOUT だけはコアメンバーも可」が表現できない。
--     そこで **write_admin を FOR ALL にせず動詞ごとに分け**、UPDATE だけ staff へ開いたうえで、
--     admin 以外が触れる列を ④ の列単位 GRANT で `is_sold_out` に限定する。
--     （RLS は列を絞れない／§6-0。列の限定は GRANT の仕事である）
-- =============================================================================

ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY menu_items_select_all ON public.menu_items
  FOR SELECT TO authenticated
  USING ( true );

CREATE POLICY menu_items_insert_admin ON public.menu_items
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_admin()) );

-- 行は staff まで開ける。**どの列を書けるかは GRANT が決める**（admin=全列／core_member=SOLDOUTのみ）。
CREATE POLICY menu_items_update_staff ON public.menu_items
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。
--   物理削除すると過去伝票の参照が切れる（v13 §5.4.2①）。非表示は is_published = false。


-- =============================================================================
-- ③ GRANT（§6-6② ／ 列単位は 0012 の先例に倣う）
-- =============================================================================

REVOKE ALL ON public.menu_items FROM anon, authenticated;

GRANT SELECT ON public.menu_items TO authenticated;
GRANT INSERT ON public.menu_items TO authenticated;   -- 行は RLS で admin のみ

-- ★ UPDATE は**列を絞って**与える。
--   全列 UPDATE を与えると、コアメンバーが `menu_items_update_staff` を通って
--   **単価を書き換えられる**（RLS は列を絞れない／§6-0）。
--   価格の変更は管理者のみ（v13 §5.4.2①）という決めを守るには、ここで列を絞るしかない。
--
--   ⚠️ 全ロールが同じ `authenticated` ロールである以上、GRANT では
--      「admin は全列・core_member は is_sold_out のみ」を分けられない。
--      そこで **GRANT は全員 `is_sold_out` と `updated_at` だけ**に絞り、
--      管理者によるその他の列の編集は**サーバ側（service_role）経由の管理APIで行う**
--      （`API設計.md` §2-5b `PATCH /api/menu-items/{id}` は admin のみ）。
--      これは 0012 が `quests` の列マスクで取ったのと同じ考え方である。
GRANT UPDATE (is_sold_out, updated_at, updated_by) ON public.menu_items TO authenticated;


-- =============================================================================
-- ④ 初期32行
--
--   出典: `docs/spec/requirements/カフェメニュー.md`（正本 v1）の31品
--         ＋ 送迎（v13 §5.4.2③ ／ §9 #49 で 1,900円・片道と確定）
--
--   ⚠️ 実在の会員データは一切含まない（CLAUDE.md §3.2・§7.1）。商品は設備であり個人情報ではない。
--
--   Uii は列に持たない。参考値（`カフェメニュー.md` 記載）と floor(単価×0.8) は全品一致している:
--     2,100→1,680 ／ 1,300→1,040 ／ 800→640 ／ 700→560 ／ 600→480 ／ 1,900→1,520
--
--   `is_pre_orderable` は v13 §5.4.1b の「朝ごはん／昼／夜のプレートごはん」に当たる商品のみ。
--   ⚠️ **朝（breakfast）に該当する商品が `カフェメニュー.md` に存在しない**ため、
--      ここでは朝の事前予約対象を1件も立てていない。単価を推測で作らない（CLAUDE.md §7）。
--      `QUESTIONS.md`「[2026-09-20] 事前予約の朝スロットに対応する商品が正本メニューに無い」を参照。
-- =============================================================================

INSERT INTO public.menu_items
  (name, category, subcategory, unit_price_yen, description, display_order, is_pre_orderable, meal_slot) VALUES
  -- 1️⃣ ごはん
  ('季節のプレートごはん',                 'フード', 'ごはん', 2100,
   '自家製塩麹からあげ、季節の副菜6種、お花のサラダ、ポタージュスープ付き', 101, true,  'dinner'),
  ('日替わりカレー（プレート）',           'フード', 'ごはん', 2100, NULL, 102, false, NULL),
  ('ワンプレートごはん',                   'フード', 'ごはん', 1300, NULL, 103, true,  'lunch'),
  ('日替わりカレー（小）',                 'フード', 'ごはん', 1300, NULL, 104, false, NULL),
  ('ロコモコ',                             'フード', 'ごはん', 1300, NULL, 105, false, NULL),
  ('タコライス',                           'フード', 'ごはん', 1300, NULL, 106, false, NULL),
  -- 2️⃣ サイドメニュー
  ('自家製塩麹からあげ（プレーン or コンニャク）', 'フード', 'サイドメニュー', 700, NULL, 201, false, NULL),
  ('ポテトフライ（塩 or オニオン塩）',     'フード', 'サイドメニュー',  600, NULL, 202, false, NULL),
  ('ポタージュスープ（季節の野菜）',       'フード', 'サイドメニュー',  600, NULL, 203, false, NULL),
  -- 3️⃣ 自家製スカッシュ（ICE）
  ('はちみつレモネード',                   'ドリンク', '自家製スカッシュ', 700, NULL, 301, false, NULL),
  ('ベリーミックス（レッド）',             'ドリンク', '自家製スカッシュ', 700, NULL, 302, false, NULL),
  ('スモモミックス（ピンク）',             'ドリンク', '自家製スカッシュ', 700, NULL, 303, false, NULL),
  ('トゥルシー＆バタフライピー（ブルー）', 'ドリンク', '自家製スカッシュ', 700, NULL, 304, false, NULL),
  ('スパイスジンジャー',                   'ドリンク', '自家製スカッシュ', 700, NULL, 305, false, NULL),
  ('うめ酵素',                             'ドリンク', '自家製スカッシュ', 700, NULL, 306, false, NULL),
  -- 4️⃣ ラテ（ICE / HOT。温度は現場選択のため行を分けない）
  ('抹茶ラテ',           'ドリンク', 'ラテ', 700, 'ICE / HOT', 401, false, NULL),
  ('ほうじ茶ラテ',       'ドリンク', 'ラテ', 700, 'ICE / HOT', 402, false, NULL),
  ('マサラチャイ',       'ドリンク', 'ラテ', 700, 'ICE / HOT', 403, false, NULL),
  ('黒豆きなこラテ',     'ドリンク', 'ラテ', 700, 'ICE / HOT', 404, false, NULL),
  ('アールグレイラテ',   'ドリンク', 'ラテ', 700, 'ICE / HOT', 405, false, NULL),
  ('ジャスミンラテ',     'ドリンク', 'ラテ', 700, 'ICE / HOT', 406, false, NULL),
  ('烏龍茶ラテ',         'ドリンク', 'ラテ', 700, 'ICE / HOT', 407, false, NULL),
  -- 5️⃣ 自家製ハーブティ（HOT）
  ('バタフライピー',     'ドリンク', '自家製ハーブティ', 700, 'HOT', 501, false, NULL),
  ('トゥルシー',         'ドリンク', '自家製ハーブティ', 700, 'HOT', 502, false, NULL),
  ('きこも',             'ドリンク', '自家製ハーブティ', 700, 'HOT', 503, false, NULL),
  ('びわの葉',           'ドリンク', '自家製ハーブティ', 700, 'HOT', 504, false, NULL),
  ('よもぎ',             'ドリンク', '自家製ハーブティ', 700, 'HOT', 505, false, NULL),
  ('金木犀紅茶',         'ドリンク', '自家製ハーブティ', 700, 'HOT', 506, false, NULL),
  -- 6️⃣ スムージー（ICE）
  ('ベリーミックス',     'ドリンク', 'スムージー', 800, 'ICE', 601, false, NULL),
  ('バナナミックス',     'ドリンク', 'スムージー', 800, 'ICE', 602, false, NULL),
  ('グリーンミックス',   'ドリンク', 'スムージー', 800, 'ICE', 603, false, NULL),
  -- 7️⃣ 送迎・オプション（v13 §5.4.2③ ／ §9 #49）
  ('送迎（三角駅→浮遊街・片道）', '送迎・オプション', '送迎', 1900,
   '片道。復路が発生する場合は同一明細をもう1件計上する（v13 §5.4.2③）', 701, false, NULL);
