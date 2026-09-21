-- =============================================================================
-- 0021_accommodation_rates.sql — 宿泊料金マスタ
--
--   WBS  : 3-9（宿泊料金マスタ）／Issue #106
--   根拠 : v13 §5.4.2②（マスタの管理画面編集）・§9 #40、`DB物理設計.md` §3-10
--   含む : accommodation_rates のスキーマ・制約・索引・RLS・GRANT
--
-- ── ★ `DB物理設計.md` §3-10 の DDL を**そのまま写していない** ──────────────
--
-- 同書の DDL は `room_type` を7値の CHECK で列挙しているが、同書自身が直後の
-- [!danger] で「**このまま実装してはならない**」と警告している。列挙されているのは
-- v1.16.0（2026-08-22）の**改称前**の名前（`ゲストハウス` / `テント` 等）であり、
-- 実装済みの `rooms.room_type`（0006）・`accommodation_types.room_type`（0014）は
-- 英字6値（`dormitory` / `cottage` / `campsite` / `car` / `earthbag` / `salon`）で入っている。
-- CHECK のまま作ると**どの部屋とも結合できない**表ができる。
--
-- 同書の指示どおり **`accommodation_types (room_type)` への外部キー**として定義する。
-- こうすると形態の増減・改称が起きても料金マスタ側を直す必要が無く、
-- `QUESTIONS.md`「[2026-08-26] 宿泊形態の旧名称が正本に残存している」が未回答のままでも
-- **DB 側は旧名称を取り込まない**（あの論点は正本の表記を直す話であり、値の変更ではない）。
--
-- ── 料金の初期行を入れない理由 ──────────────────────────────────────
--
-- v13 §5.4.2② は「**価格をコード・画面に直書きしない**」と定めており、
-- 正本に宿泊料金の実額は書かれていない（明記があるのは送迎 1,900円 ＝ `menu_items` 側だけ）。
-- 推測した金額を初期行として入れると、それが既成事実になる。**空のマスタで出荷し、
-- 管理者がマスタ管理画面（画面ID C13）から入れる**のが §5.4.2② の求める形である。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.accommodation_rates (
  rate_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ★ CHECK ではなく外部キー。理由は冒頭の注記
  room_type           text NOT NULL
                        REFERENCES public.accommodation_types (room_type),

  member_category     text NOT NULL DEFAULT 'member'
                        CONSTRAINT chk_rate_member_category
                        CHECK (member_category IN ('member', 'non_member')),

  price_per_night_yen integer NOT NULL
                        CONSTRAINT chk_rate_price_non_negative
                        CHECK (price_per_night_yen >= 0),

  -- ▼ 料金改定は行の上書きではなく、適用期間を区切って新しい行を追加する（v13 §5.4.2②）。
  --   上書きにすると、過去の予約を顧客管理画面で開いたときに**現在価格で再計算される**
  --   （§5.6.5 の遡及修正で差額が誤って算出される）。
  effective_from      date NOT NULL,
  effective_until     date,   -- NULL ＝ 現行

  note                text,
  created_by          uuid REFERENCES public.members (member_id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_rate_period
    CHECK (effective_until IS NULL OR effective_until >= effective_from)
);

COMMENT ON TABLE public.accommodation_rates IS
  '宿泊形態×会員区分×適用期間ごとの1泊単価（v13 §5.4.2②）。'
  'マスタは「これから作る予約の既定値」であり、過去の予約の参照先ではない。'
  '料金改定は上書きせず期間を区切って行を足す。';
COMMENT ON COLUMN public.accommodation_rates.room_type IS
  'accommodation_types への外部キー。DB物理設計 §3-10 の CHECK 列挙は改称前の名前のため採らない（同書の [!danger]）';
COMMENT ON COLUMN public.accommodation_rates.effective_until IS
  'NULL は現行を意味する。期間の重なりは ex_rate_no_overlap が禁じる';


-- =============================================================================
-- ② 同一（形態 × 会員区分）で適用期間を重ねさせない
--
--   重なりを許すと「その日の料金」が2行に決まってしまい、どちらで請求したかが
--   後から説明できなくなる。アプリ側の検査では競合時に2行入りうるため DB で禁じる。
--
--   ⚠️ 拡張は `extensions` スキーマへ置く（0013 が vector で確立した作法）。
--      素の `CREATE EXTENSION btree_gist;` だと public へ入り、
--      `0101` が剥がした service_role の余剰権限の議論をまた持ち込むことになる。
--      演算子クラスはスキーマ修飾して参照する（search_path に依存させない）。
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE public.accommodation_rates
  ADD CONSTRAINT ex_rate_no_overlap
  EXCLUDE USING gist (
    room_type       extensions.gist_text_ops WITH =,
    member_category extensions.gist_text_ops WITH =,
    -- '[]' ＝ 両端を含む。`effective_until` が NULL のときは上限なしの範囲になる
    daterange(effective_from, effective_until, '[]') WITH &&
  );

-- 現行料金だけを引く経路（画面・予約の料金表示）。部分索引にして現行行だけを載せる
CREATE INDEX IF NOT EXISTS ix_rate_current
  ON public.accommodation_rates (room_type, member_category)
  WHERE effective_until IS NULL;


-- =============================================================================
-- ③ RLS（DB物理設計 §6）
--
--   参照は authenticated 全員。料金は会員・ゲストが見る情報であり隠さない。
--   ⚠️ `anon` には与えない。未ログインの公開予約ページは anon キーで直接 DB を読まず、
--      必ずサーバ側（service_role）を経由する（0015 と同じ方針 ／ `API設計.md` §1-1）。
--
--   登録・改定は **管理者のみ**（v13 §5.4.2②「操作権限：管理者のみ」）。
--   0018 の `menu_items` のような列単位 GRANT は要らない。あちらは UPDATE ポリシーが
--   staff まで開いているため列で絞る必要があったが、ここは行レベルで admin に閉じている。
-- =============================================================================

ALTER TABLE public.accommodation_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY accommodation_rates_select_all ON public.accommodation_rates
  FOR SELECT TO authenticated
  USING ( true );

CREATE POLICY accommodation_rates_insert_admin ON public.accommodation_rates
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_admin()) );

CREATE POLICY accommodation_rates_update_admin ON public.accommodation_rates
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_admin()) )
  WITH CHECK  ( (SELECT public.is_admin()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。
--   料金は履歴である。消すと過去の予約を当時の料金で再計算できなくなる（v13 §5.4.2②）。
--   改定は `effective_until` を入れて期間を閉じることで行う。


-- =============================================================================
-- ④ GRANT（DB物理設計 §6-6②）— 既定の広い権限を剥がしてから必要分だけ与える
-- =============================================================================

REVOKE ALL ON public.accommodation_rates FROM anon, authenticated;

GRANT SELECT         ON public.accommodation_rates TO authenticated;
GRANT INSERT, UPDATE ON public.accommodation_rates TO authenticated;  -- 行は RLS で admin のみ
