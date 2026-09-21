-- =============================================================================
-- WBS 3-2（チェックイン／チェックアウト操作）の DB 層 ＋ WBS 3-3（予約キャンセル・ノーショー処理）
--
-- 根拠: v13 §5.2.2（予約のキャンセル・ノーショー）・§5.2.5（宿泊枠の残数算出）・
--       §5.4.2（宿泊形態と収容枠の確定表）・§7「チェックイン/アウトステータス」、
--       `DB物理設計.md` §3-11（`reservation_source`）・§3-12（`accommodation_types`）・
--       §6-1 #5（`check_ins` は PII-B）・§6-7（デフォルト拒否）・§2011（`_insert_self`）
--
-- ── なぜ本ファイルが必要か ────────────────────────────────────
--   `DB物理設計.md` §3-11 は「既存の `check_ins`（Vault側 `01_schema.sql` で実装済み）」
--   と書いているが、**本リポジトリの `supabase/migrations/` には存在しない**。
--   Vault 側の `01_schema.sql` は移行用のドラフトであり、このリポジトリへ取り込まれていない。
--   その結果、`check_ins` を参照する作業パッケージ（`3-3`・`3-4`・`3-8`・`6-1`・`8-1`・`8-6`）が
--   全部止まっていた（`QUESTIONS.md`「[2026-09-19] WBS `3-8` の残枠ビューは `check_ins`
--   未作成では組めない」）。**2026-09-20 オーナー指示「DBが存在しない場合は実装すること」**に
--   より、その論点の選択肢 C（`3-8` の中で `check_ins` を併せて作る）に相当する形で解消する。
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : accommodation_types（6形態マスタ）／check_ins のスキーマ・制約・RLS・GRANT
--           ／`0006` が後続へ送った ALTER 2件（FK と本人向けポリシー）
--           ／`rooms` の収容枠を §5.4.2 確定表（合計66）へ是正
--   含まない:
--     - 残枠ビュー `v_room_availability`            → 0015（WBS 3-8）
--     - チェックイン操作 UI・QR・ウェルカムメッセージ → WBS 3-2 の画面側
--     - 宿泊券の消費・付与                          → 0016（WBS 3-4）
-- =============================================================================


-- =============================================================================
-- ① accommodation_types（宿泊形態マスタ）
--
--   `DB物理設計.md` §3-12 の DDL をそのまま起こす。
--   **収容枠の数え方をマスタに持たせるのが本表の唯一の存在理由**である（v13 §5.2.5）。
--   コテージを人数で数えると「1名の予約が3件 ＝ 実質満室」なのに「残り3名」と表示される。
-- =============================================================================

CREATE TABLE public.accommodation_types (
  -- `rooms.room_type` と**同じ6値**。揃えないと残枠計算が分母を引けない（0006 の chk_rooms_room_type）
  room_type       text PRIMARY KEY
                    CONSTRAINT chk_accommodation_types_room_type
                    CHECK (room_type IN ('dormitory', 'cottage', 'campsite', 'car', 'earthbag', 'salon')),

  display_name    text NOT NULL
                    CONSTRAINT chk_accommodation_types_display_name_present
                    CHECK (btrim(display_name) <> ''),

  -- ★ 占有量の数え方（v13 §5.2.5・§9 #47）。
  --   per_person = 定員の合計から予約人数を引く（ドミトリー・キャンプサイト・車中泊）
  --   per_unit   = 棟数から占有棟数を引く（コテージ・アースバッグ・サロン）
  allocation_mode text NOT NULL
                    CONSTRAINT chk_accommodation_types_allocation_mode
                    CHECK (allocation_mode IN ('per_person', 'per_unit')),

  display_order   integer NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.accommodation_types IS
  '宿泊形態マスタ（v13 §5.4.2 の確定表 ／ DB物理設計 §3-12）。'
  '収容枠の数え方（allocation_mode）を保持し、残枠算出をコードに直書きさせないための表。';

COMMENT ON COLUMN public.accommodation_types.allocation_mode IS
  'per_person=人数枠型（残枠 = 定員合計 − 予約人数合計）／per_unit=棟貸型（残枠 = 棟数 − 占有棟数）。'
  '一律の式にすると、コテージで1名予約3件＝実質満室なのに「残り3名」と表示される（v13 §9 #47）。';

-- 初期6行。v13 §5.4.2「★ 宿泊形態と収容枠の確定（2026-08-22 オーナー確定）」に一致させる。
-- ⚠️ 旧名称（ゲストハウス／テント／コテージA・B）は使わない。v1.16.0 の改称後の名前だけを入れる。
INSERT INTO public.accommodation_types (room_type, display_name, allocation_mode, display_order) VALUES
  ('dormitory', 'ドミトリー',     'per_person', 1),
  ('cottage',   'コテージ',       'per_unit',   2),
  ('campsite',  'キャンプサイト', 'per_person', 3),
  ('car',       '車中泊',         'per_person', 4),
  ('earthbag',  'アースバッグ',   'per_unit',   5),
  ('salon',     'サロン',         'per_unit',   6);


-- =============================================================================
-- ② `rooms` の収容枠を §5.4.2 確定表へ是正
--
--   0006 の初期8行は キャンプサイト=4 ／ 車中泊スペース=2 で入っているが、
--   v13 §5.4.2 の確定表は **キャンプサイト 10 ／ 車中泊 30**（合計66名）である。
--   このままだと残枠ビューの分母が 32 になり、**予約できるはずの枠を満室と表示する**。
--
--   CLAUDE.md §4.5「既存マイグレーションを書き換えない」ため、0006 は触らず UPDATE で直す。
--   `room_name` ではなく `room_type` で引く（部屋名はリネームされうるため／0006 のコメント）。
-- =============================================================================

UPDATE public.rooms SET capacity = 10, updated_at = now() WHERE room_type = 'campsite' AND capacity <> 10;
UPDATE public.rooms SET capacity = 30, updated_at = now() WHERE room_type = 'car'      AND capacity <> 30;


-- =============================================================================
-- ③ check_ins（チェックイン／アウト ＝ 予約の正本）
--
--   v13 §5.2.3 が「入口は2本、正本は1本」と定めており、公開予約ページ・アプリ内予約・
--   運営代理登録の**すべてが同じ1行**になる。経路は `reservation_source` でのみ区別する。
--
--   ⚠️ 宿泊者名簿（氏名・住所・前泊地・後泊地）は**本表に足さない**。
--      本表は PII-B（本人が自分の行を読める）であり、RLS は列を絞れない（§6-0）ため、
--      住所を足した瞬間に本人向け SELECT で住所が返る。名簿は
--      `lodging_register_entries`（0010 ／ PII-A）が持つ（v13 §7・DB物理設計 §3-13①）。
-- =============================================================================

CREATE TABLE public.check_ins (
  checkin_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  member_id           uuid NOT NULL REFERENCES public.members (member_id),

  -- ★ 宿泊形態は**滞在側の属性**である（v13 §7・§5.6.9）。
  --   現地で形態が変わったときに `rooms.room_type` を書き換えて表現してはならない。
  --   部屋台帳が壊れ、他の予約の残枠・料金まで巻き添えになる。
  room_type           text NOT NULL REFERENCES public.accommodation_types (room_type),

  -- 予約の日付。残枠はこの2列から日付展開して数える（DB物理設計 §3-12）。
  -- 実際の入退館時刻（checked_in_at / checked_out_at）とは別物なので混ぜない。
  check_in_date       date NOT NULL,
  check_out_date      date NOT NULL,

  adults_count        integer NOT NULL DEFAULT 1
                        CONSTRAINT chk_check_ins_adults_non_negative CHECK (adults_count >= 0),
  children_count      integer NOT NULL DEFAULT 0
                        CONSTRAINT chk_check_ins_children_non_negative CHECK (children_count >= 0),

  -- ★ 滞在の状態。**残枠を数える対象を決めるのはこの列**（DB物理設計 §3-12 の booked CTE）。
  --   pre_registered = 予約受付（自動確定前）／confirmed = 確定済み／staying = 滞在中
  --   checked_out    = 退館済み          ／cancelled = キャンセル・ノーショー（論理削除）
  status              text NOT NULL DEFAULT 'pre_registered'
                        CONSTRAINT chk_check_ins_status
                        CHECK (status IN ('pre_registered', 'confirmed', 'staying', 'checked_out', 'cancelled')),

  -- v13 §7 が列挙する「滞在フラグ（true/false）」。
  -- ★ 生成列にして `status` から導出する。独立した列にすると
  --   「status = 'staying' なのに is_staying = false」という食い違いを作れてしまう（二重管理／§9 #25 と同じ原則）。
  is_staying          boolean GENERATED ALWAYS AS (status = 'staying') STORED,

  -- 実際の入退館時刻。予約日（check_in_date）とはずれうる（早着・延泊）。
  checked_in_at       timestamptz,
  checked_out_at      timestamptz,

  -- 予約経路（DB物理設計 §3-11）。
  -- 'google_form' は**過去データの経路を表す値として残す**。削除すると既存行が CHECK 違反になる。
  reservation_source  text NOT NULL DEFAULT 'web_public'
                        CONSTRAINT chk_check_ins_reservation_source
                        CHECK (reservation_source IN ('web_public', 'in_app', 'staff_manual', 'google_form')),

  -- ★ 「街人ですか？」の自己申告（v13 §5.2.3 ／ 2026-09-01 再導入）。
  --   **料金・権限判定には一切使わない。** チェックイン時の照合の参考フラグに限る。
  --   認可に使うのは `members.role` だけである（v13 §2・CLAUDE.md §4.1）。
  self_declared_machibito boolean NOT NULL DEFAULT false,

  -- ▼ キャンセル・ノーショー（v13 §5.2.2 ／ §7 ／ §9 #27）。物理削除しない。
  cancelled_at        timestamptz,
  cancel_reason_type  text
                        CONSTRAINT chk_check_ins_cancel_reason_type
                        CHECK (cancel_reason_type IN ('会員都合', 'ノーショー', '運営都合')),
  cancel_reason       text,
  cancelled_by        uuid REFERENCES public.members (member_id),

  note                text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- 0泊の予約は作れない。`<=` にすると当日中の予約が残枠を1つも消費せず、
  -- 残枠ビュー（`cal.date < check_out_date`）が1行も返さないまま部屋だけ埋まる。
  CONSTRAINT chk_check_ins_stay_has_length CHECK (check_out_date > check_in_date),

  -- 「大人0名・子供0名」の予約は残枠を消費しないまま棟だけ押さえる幽霊予約になる。
  CONSTRAINT chk_check_ins_has_guest CHECK (adults_count + children_count > 0),

  -- ★ 理由なし取消を防ぐ（v13 §5.2.2「理由入力は必須」）。
  --   種別・自由記述・操作者をセットで必須にする。
  CONSTRAINT chk_check_ins_cancel_complete CHECK (
    cancelled_at IS NULL
    OR (cancel_reason_type IS NOT NULL
        AND btrim(coalesce(cancel_reason, '')) <> ''
        AND cancelled_by IS NOT NULL)
  ),

  -- `status` と `cancelled_at` の食い違いを物理的に作れなくする。
  -- 片方だけ更新した実装があると、残枠ビューがキャンセル済みの予約を数え続ける。
  CONSTRAINT chk_check_ins_cancelled_status_agree CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),

  CONSTRAINT chk_check_ins_checkout_after_checkin CHECK (
    checked_out_at IS NULL OR checked_in_at IS NULL OR checked_out_at >= checked_in_at
  )
);

COMMENT ON TABLE public.check_ins IS
  '予約・チェックイン／アウトの正本（v13 §5.2.3「入口は2本、正本は1本」・§7）。'
  '公開予約ページ・アプリ内予約・運営代理登録をすべて同じ行として持ち、経路は reservation_source でのみ区別する。'
  'キャンセル・ノーショーは論理削除（cancelled_at）であり物理削除しない（§5.2.2）。'
  '宿泊者名簿（氏名・住所）は PII-A のため本表ではなく lodging_register_entries が持つ（§3-13①）。';

COMMENT ON COLUMN public.check_ins.room_type IS
  '宿泊形態。滞在側の属性であり、形態変更のために rooms.room_type を書き換えてはならない（v13 §5.6.9）。';

COMMENT ON COLUMN public.check_ins.self_declared_machibito IS
  '予約時の「街人ですか？」自己申告（v13 §5.2.3）。★ 料金・権限判定には一切使わない。照合の参考のみ。';

-- 顧客管理の「チェックイン中を最上部へ」（WBS 8-5 ／ v13 §5.6.7）と本人のマイログが引く索引。
CREATE INDEX ix_check_ins_member ON public.check_ins (member_id, check_in_date DESC);

-- 残枠ビューは「有効な予約」だけを日付で引く。キャンセル済みを含めると分子が膨らむ。
CREATE INDEX ix_check_ins_active_dates ON public.check_ins (room_type, check_in_date, check_out_date)
  WHERE cancelled_at IS NULL;

-- 現在滞在中の一覧（セルフ注文の対象判定／WBS 6-1・6-2）。
CREATE INDEX ix_check_ins_staying ON public.check_ins (member_id)
  WHERE status = 'staying';


-- =============================================================================
-- ④ 0006 が後続（本パッケージ）へ送った ALTER 2件
--
--   `0006_rooms_and_assignments.sql` は「`check_ins` がまだ無いので張れない」として
--   FK と本人向けポリシーをコメントで明示的に先送りしていた（2026-09-15 オーナー決定）。
--   ここで回収する。**0006 自体は書き換えない**（CLAUDE.md §4.5）。
-- =============================================================================

ALTER TABLE public.room_assignments
  ADD CONSTRAINT fk_room_assignments_check_in
  FOREIGN KEY (check_in_id) REFERENCES public.check_ins (checkin_id);

-- 本人は「自分がどの部屋に泊まったか」を読める（DB物理設計 §6-1 #11 ／ v13 §5.6.8）。
-- 0006 のコメントが書き残していた DDL をそのまま起こす。
CREATE POLICY ra_select_self ON public.room_assignments
  FOR SELECT TO authenticated
  USING ( EXISTS (SELECT 1
                  FROM   public.check_ins c
                  WHERE  c.checkin_id = room_assignments.check_in_id
                    AND  c.member_id  = (SELECT public.current_member_id())) );


-- =============================================================================
-- ⑤ RLS（§6-7 デフォルト拒否 ／ §6-1 #5）
-- =============================================================================

ALTER TABLE public.accommodation_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_ins           ENABLE ROW LEVEL SECURITY;

-- ── accommodation_types：読みは authenticated 全員、書き込みは admin のみ ──
--    ゲストも残枠・料金を見る（v13 §5.2.3 公開予約ページ）。ここを staff に絞ると残枠が出ない。
--    マスタの編集権限は **管理者のみ**（v13 §5.4.2②「操作権限：管理者のみ」）。
CREATE POLICY accommodation_types_select_all ON public.accommodation_types
  FOR SELECT TO authenticated
  USING ( true );

CREATE POLICY accommodation_types_insert_admin ON public.accommodation_types
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_admin()) );

CREATE POLICY accommodation_types_update_admin ON public.accommodation_types
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_admin()) )
  WITH CHECK  ( (SELECT public.is_admin()) );

-- ── check_ins：PII-B。本人の行 ＋ staff（DB物理設計 §6-1 #5）──────
CREATE POLICY check_ins_select_self ON public.check_ins
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY check_ins_select_staff ON public.check_ins
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- 本人によるアプリ内予約（v13 §5.2.4 ／ DB物理設計 §2011「`_insert_self` を追加」）。
-- ⚠️ **他人名義の予約は作れない**。member_id を自分に固定する条件を WITH CHECK に置く。
CREATE POLICY check_ins_insert_self ON public.check_ins
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id())
               AND cancelled_at IS NULL );   -- 作成と同時のキャンセルは運営操作（下の staff 用で行う）

CREATE POLICY check_ins_insert_staff ON public.check_ins
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- ★ UPDATE は staff のみ（DB物理設計 §2011「チェックアウト・キャンセルは運営操作」）。
--   本人に UPDATE を許すと、自分の予約を `cancelled` にして部屋だけ押さえ続ける・
--   チェックアウト日を自分で伸ばす、といった経路が開く。変更は §5.6.9 の運営操作に閉じる。
CREATE POLICY check_ins_update_staff ON public.check_ins
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。キャンセルは論理削除である（v13 §5.2.2）。


-- =============================================================================
-- ⑥ GRANT（§6-6②）— 先に既定の広い権限を剥がしてから必要分だけ与える
-- =============================================================================

REVOKE ALL ON public.accommodation_types FROM anon, authenticated;
REVOKE ALL ON public.check_ins           FROM anon, authenticated;

GRANT SELECT                 ON public.accommodation_types TO authenticated;
GRANT INSERT, UPDATE         ON public.accommodation_types TO authenticated;  -- 行は RLS で admin のみ
GRANT SELECT, INSERT, UPDATE ON public.check_ins           TO authenticated;  -- 行は RLS で本人／staff

-- ⚠️ `anon` には何も与えない。公開予約ページ（未ログイン）は anon キーで直接 DB を触らず、
--    必ずサーバ側（service_role）を経由する（`非機能要件詳細.md` §2-2b ／ API設計 §1-1）。
