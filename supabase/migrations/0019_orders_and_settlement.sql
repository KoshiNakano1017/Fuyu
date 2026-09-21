-- =============================================================================
-- WBS 6-1（セルフ注文）／6-5（提供ステータス）／7-2（伝票管理）／8-3（差額の繰越・免除）
--   ／3-5c（カフェ事前予約注文 `meal_reservations`）
--
-- 根拠: v13 §5.4.1（提供ステータス・**会計と提供の2軸**）・§5.4.1b（事前予約注文）、
--       v13 §5.5（Uii は単品ごとに floor(単価×0.8)。伝票合計に 0.8 を掛けない）、
--       v13 §5.6.2〜§5.6.6（伝票編集・理由必須・差額の繰越／免除）、
--       v13 §7「★ 注文データ（会計管理）」L2430-2446、
--       `DB物理設計.md` §3-2 L221-297（orders / order_items / settlement_adjustments）・
--       §3-6② L379-403（meal_reservations）、`API設計.md` §2-5・§2-2b
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : orders ／ order_items ／ settlement_adjustments ／ meal_reservations
--           ／RLS・GRANT・索引
--   含まない:
--     - セルフ注文画面 A5・カンバン B1・顧客管理 C9  → 各パッケージのアプリ層
--     - 精算QRの発行・検証ロジック                   → WBS 7-3（列だけ本ファイルで用意する）
--     - 編集履歴ログ（v13 §5.6.4 の audit_log）      → **未設計**。§⑦ の注記を参照
--
-- ── 動かしてはならない点 ──────────────────────────────────
--   1. **会計ステータスと提供ステータスを1カラムに統合しない**（v13 §5.4.1）。
--      統合すると「代金は受け取ったが料理を出していない」伝票が検出できなくなる。
--   2. **明細は注文時点の単価をコピーして保持する**（v13 §5.4.2 の警告）。
--      `menu_items` への参照にすると、価格改定で過去伝票が書き換わる。
--   3. **事前予約の時点で `orders` を作らない**（v13 §5.4.1b）。
--      作ると「予約済・未来訪」という第3の状態が2軸のマトリクスに混ざる。
-- =============================================================================


-- =============================================================================
-- ① orders（伝票）
-- =============================================================================

CREATE TABLE public.orders (
  order_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ★ チェックイン中の利用者だけが注文できる（v13 §5.4）。`check_ins` は 0014 で作った。
  checkin_id         uuid NOT NULL REFERENCES public.check_ins (checkin_id),

  purchaser_id       uuid NOT NULL REFERENCES public.members (member_id),

  order_channel      text NOT NULL DEFAULT 'self'
                       CONSTRAINT chk_orders_channel
                       CHECK (order_channel IN ('self', 'staff_proxy')),

  order_source       text NOT NULL DEFAULT 'cafe'
                       CONSTRAINT chk_orders_source
                       CHECK (order_source IN ('cafe', 'shop')),

  -- ▼ 軸1：会計ステータス
  status             text NOT NULL DEFAULT '未会計'
                       CONSTRAINT chk_orders_status
                       CHECK (status IN ('未会計', '精算済み', '取消')),

  -- ▼ 軸2：提供ステータス（v13 §5.4.1 ／ §9 #39）
  --   ★ 軸1と**独立**である。同一カラムへ統合してはならない。
  --   値は DB では `未提供` / `提供済み` を持ち、**画面表示は「調理中」**（正本 §5.4.1）。
  --   表示文言の変換は `src/lib/serving-status.ts` ただ1箇所で行う（二重管理を避ける）。
  serving_status     text NOT NULL DEFAULT '未提供'
                       CONSTRAINT chk_orders_serving_status
                       CHECK (serving_status IN ('未提供', '提供済み')),
  served_at          timestamptz,
  served_by          uuid REFERENCES public.members (member_id),

  -- 合計。明細行の合計を書き戻すキャッシュであり、**伝票合計に 0.8 を掛けて作らない**（v13 §5.5）。
  total_amount_yen   integer NOT NULL DEFAULT 0,
  total_amount_uii   integer NOT NULL DEFAULT 0,

  settled_at         timestamptz,

  -- ▼ 精算QR（2026-09-10 A案で確定 ／ 非機能 F-1・§2-7）。発行ロジックは WBS 7-3。
  --   平文は保存しない。発行APIのレスポンスで1度だけ返し、再表示はしない。
  settlement_qr_token_hash  text UNIQUE,   -- sha256(トークン) の16進。DB流出だけでは清算できない
  settlement_qr_issued_by   uuid REFERENCES public.members (member_id),
  settlement_qr_issued_at   timestamptz,
  settlement_qr_expires_at  timestamptz,   -- 既定: 発行から24時間
  settlement_qr_consumed_at timestamptz,   -- 精算完了で確定。以降は再利用不可（単回使用）

  -- ★ 伝票編集による自動失効（v13 §5.6.3-5・§7 L2445「トークン失効フラグ」）。
  --   派生設計の DDL に列が無く、「編集したのに旧QRで元の金額のまま精算できる」窓が開いていた。
  --   consumed（使われた）と revoked（無効にした）は別の事実なので列を分ける。
  settlement_qr_revoked_at  timestamptz,

  -- ▼ 取消（v13 §5.6.2・§7 L2444）。**論理削除**であり物理削除しない。
  --   派生設計は `status = '取消'` しか持たず、理由・操作者を残せなかった。
  cancelled_at       timestamptz,
  cancel_reason      text,
  cancelled_by       uuid REFERENCES public.members (member_id),

  created_by         uuid REFERENCES public.members (member_id),  -- 代理注文時の店員ID
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- 理由なし取消を物理的に作れなくする（v13 §5.6.4 の編集理由必須ルール）。
  CONSTRAINT chk_orders_cancel_complete CHECK (
    cancelled_at IS NULL
    OR (btrim(coalesce(cancel_reason, '')) <> '' AND cancelled_by IS NOT NULL)
  ),

  -- `status` と `cancelled_at` の食い違いを作れなくする。
  CONSTRAINT chk_orders_cancelled_status_agree CHECK (
    (status = '取消') = (cancelled_at IS NOT NULL)
  ),

  -- 代理注文には店員が記録されていなければならない（誰が代わりに入れたか追えないと補正できない）。
  CONSTRAINT chk_orders_proxy_has_operator CHECK (
    order_channel <> 'staff_proxy' OR created_by IS NOT NULL
  ),

  CONSTRAINT chk_orders_served_has_operator CHECK (
    served_at IS NULL OR served_by IS NOT NULL
  )
);

COMMENT ON TABLE public.orders IS
  '伝票（v13 §5.4・§5.6 ／ DB物理設計 §3-2）。★ 会計ステータス（status）と提供ステータス'
  '（serving_status）は独立した2軸であり、1カラムに統合してはならない（v13 §5.4.1）。'
  '統合すると「代金は受け取ったが料理を出していない」伝票が検出できなくなる。'
  '取消は論理削除（cancelled_at）であり物理削除しない（§5.6.2）。';

COMMENT ON COLUMN public.orders.serving_status IS
  '提供ステータス。DB の値は 未提供／提供済み。★ 画面表示は正本 §5.4.1 に従い「調理中」とし、'
  '変換は src/lib/serving-status.ts ただ1箇所で行う（画面ごとに文言を書かない）。';

COMMENT ON COLUMN public.orders.settlement_qr_revoked_at IS
  '伝票編集による精算QRの失効（v13 §5.6.3-5・§7）。consumed（使われた）とは別の事実なので'
  '同じ列に寄せない。編集後は再発行を促す（旧QRで旧金額のまま精算されるのを防ぐ）。';

CREATE INDEX ix_order_purchaser ON public.orders (purchaser_id, created_at DESC);
CREATE INDEX ix_order_checkin   ON public.orders (checkin_id);
CREATE INDEX ix_order_status    ON public.orders (status);

-- 厨房の作業待ち行列（B1 カンバンの「調理中」列）。
CREATE INDEX ix_order_serving ON public.orders (serving_status) WHERE serving_status = '未提供';

-- ★「精算済みだが未提供」＝要注意状態（v13 §5.4.1 の2軸マトリクス）。B1 で強調表示する。
CREATE INDEX ix_order_paid_unserved ON public.orders (created_at)
  WHERE status = '精算済み' AND serving_status = '未提供';

-- 有効な精算QRの絞り込み（期限切れ掃除ジョブが参照する）。失効済みも除く。
CREATE INDEX ix_order_qr_active ON public.orders (settlement_qr_expires_at)
  WHERE settlement_qr_consumed_at IS NULL AND settlement_qr_revoked_at IS NULL;


-- =============================================================================
-- ② order_items（伝票明細）
--
--   ★ `menu_items` への外部キーを**張らない**。明細は注文時点の商品名・単価の
--     **コピー**であり、マスタの改定が過去伝票を書き換えてはならない（v13 §5.4.2 の警告）。
--     `room_assignments.room_name_snapshot`（0006）と同じ原則である。
-- =============================================================================

CREATE TABLE public.order_items (
  item_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  order_id          uuid NOT NULL REFERENCES public.orders (order_id) ON DELETE CASCADE,

  -- 注文時点の商品名のコピー。マスタをリネームしても過去伝票は変わらない。
  product_name      text NOT NULL
                      CONSTRAINT chk_order_items_name_present CHECK (btrim(product_name) <> ''),

  unit_price_yen    integer NOT NULL,

  -- ★ 注文時点の Uii 単価 ＝ floor(unit_price_yen × 0.8)。
  --   マスタ（`menu_items`）は Uii を持たないが、**明細は持つ**。ここは矛盾ではない:
  --   マスタは「これから作る伝票の既定値」、明細は「当時の事実の記録」である（v13 §5.4.2）。
  unit_price_uii    integer NOT NULL,

  quantity          integer NOT NULL DEFAULT 1
                      CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0),

  sold_out_at_order boolean NOT NULL DEFAULT false,

  -- 由来のマスタ行（集計・再注文の手がかり）。FK は張らない（上記の理由）。
  source_menu_item_id uuid,

  -- ▼ 顧客管理画面からの手動編集（v13 §5.6.4：理由必須）
  edited_by         uuid REFERENCES public.members (member_id),
  edit_reason       text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- 理由なし編集を物理的に作れなくする（v13 §5.6.4 ／ API設計 §3-2 の `edit_reason` minLength 1）。
  CONSTRAINT chk_order_items_edit_needs_reason CHECK (
    edited_by IS NULL OR btrim(coalesce(edit_reason, '')) <> ''
  )
);

COMMENT ON TABLE public.order_items IS
  '伝票明細（v13 §5.6.3 ／ DB物理設計 §3-2）。★ 商品名・単価は注文時点のコピーであり、'
  'menu_items への外部キーを張らない（マスタ改定で過去伝票が書き換わるのを防ぐ／v13 §5.4.2）。';

CREATE INDEX ix_order_item_order ON public.order_items (order_id);


-- =============================================================================
-- ③ settlement_adjustments（差額精算 ／ WBS 8-3）
--
--   v13 §5.6.6 ／ §9 #7・#17。繰越・免除とも Phase 1 で許可（2026-08-16 回答済み）。
-- =============================================================================

CREATE TABLE public.settlement_adjustments (
  adjustment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  order_id      uuid NOT NULL REFERENCES public.orders (order_id),

  -- ★ 符号付き。＋＝追加請求／−＝返金。
  --   `src/lib/uii.ts` の `toUii()` は負数で RangeError を投げるため、
  --   Uii 換算は絶対値へ適用して符号を戻すこと（`src/lib/billing/adjustment.ts`）。
  amount_yen    integer NOT NULL
                  CONSTRAINT chk_settlement_adj_amount_not_zero CHECK (amount_yen <> 0),
  amount_uii    integer NOT NULL DEFAULT 0,

  category      text NOT NULL
                  CONSTRAINT chk_settlement_adj_category
                  CHECK (category IN ('追加請求', '返金')),

  -- 理由は必須（v13 §5.6.4）。派生設計は NOT NULL だけだったが空白で抜けられるため締める。
  reason        text NOT NULL
                  CONSTRAINT chk_settlement_adj_reason_present CHECK (btrim(reason) <> ''),

  status        text NOT NULL DEFAULT '未処理'
                  CONSTRAINT chk_settlement_adj_status
                  CHECK (status IN ('未処理', '精算済み', '免除')),

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  settled_by    uuid REFERENCES public.members (member_id),

  -- ★ 免除操作者。**Phase 1 はコアメンバーにも免除を許可**（`QUESTIONS.md`
  --   「[2026-08-15] 差額繰越（返金・免除運用）の詳細」2026-08-16 回答 ／
  --   `API設計.md` §5・`DB物理設計.md` §8 とも「✅解消済み」）。
  --   ⚠️ `DB物理設計.md` §3-2 の「権限範囲は QUESTIONS.md 未回答」という注記は**古い**。
  --      本コミットで派生文書側を是正する（CLAUDE.md §7.0.1）。
  waived_by     uuid REFERENCES public.members (member_id),
  waived_at     timestamptz,

  -- ★ 90日滞留フラグ（v13 §5.6.6）。**自動免除も督促も行わず、旗を立てるだけ**
  --   （2026-08-16 回答）。日次ジョブが立てる想定で、既定は false。
  is_stale      boolean NOT NULL DEFAULT false,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- 符号と区分の食い違いを作れなくする。「返金なのに +5,000」を DDL で塞ぐ。
  CONSTRAINT chk_settlement_adj_sign_matches_category CHECK (
    (category = '追加請求' AND amount_yen > 0)
    OR (category = '返金' AND amount_yen < 0)
  ),

  CONSTRAINT chk_settlement_adj_waived_has_operator CHECK (
    (status = '免除') = (waived_by IS NOT NULL)
  )
);

COMMENT ON TABLE public.settlement_adjustments IS
  '差額精算（v13 §5.6.6 ／ §9 #7・#17）。Phase 1 は繰越・免除とも許可し、免除はコアメンバーも可'
  '（2026-08-16 オーナー回答）。90日滞留は is_stale の旗を立てるだけで自動免除・督促は行わない。'
  '★ ダッシュボードの「未会計額」には繰越差額を含めて表示すること（繰越を選んだ瞬間に'
  '画面から消える設計にしない／v13 §5.6.6）。';

CREATE INDEX ix_settlement_adj_order  ON public.settlement_adjustments (order_id);
CREATE INDEX ix_settlement_adj_status ON public.settlement_adjustments (status) WHERE status = '未処理';
CREATE INDEX ix_settlement_adj_stale  ON public.settlement_adjustments (occurred_at) WHERE status = '未処理';


-- =============================================================================
-- ④ meal_reservations（カフェ事前予約注文 ／ WBS 3-5c）
--
--   v13 §5.4.1b。**予約時点では伝票を作らない。** 目的は仕込み数量の把握である。
-- =============================================================================

CREATE TABLE public.meal_reservations (
  meal_reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  checkin_id          uuid NOT NULL REFERENCES public.check_ins (checkin_id) ON DELETE CASCADE,

  served_on           date NOT NULL,   -- 提供日。チェックイン当日を含む滞在日

  meal_slot           text NOT NULL
                        CONSTRAINT chk_meal_res_slot
                        CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner')),

  menu_item_id        uuid NOT NULL REFERENCES public.menu_items (menu_item_id),

  quantity            integer NOT NULL DEFAULT 1
                        CONSTRAINT chk_meal_res_quantity_positive CHECK (quantity > 0),

  -- 提供操作で `orders` へ変換した際の伝票（二重変換の防止／WBS 6-5 の責務）。
  converted_order_id  uuid REFERENCES public.orders (order_id),
  converted_at        timestamptz,

  cancelled_at        timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_meal_res_slot UNIQUE (checkin_id, served_on, meal_slot, menu_item_id),

  -- 変換済みなら伝票が特定できていなければならない（「変換した」だけ立って伝票不明を防ぐ）。
  CONSTRAINT chk_meal_res_converted_complete CHECK (
    (converted_at IS NULL) = (converted_order_id IS NULL)
  )
);

COMMENT ON TABLE public.meal_reservations IS
  '宿泊予約時のカフェ事前予約注文（v13 §5.4.1b ／ §9 #48）。★ 予約時点では orders を作らない'
  '（「予約済・未来訪」という第3の状態が会計×提供の2軸に混ざるため）。提供操作時に orders へ変換する。';

COMMENT ON COLUMN public.meal_reservations.converted_order_id IS
  '提供時に変換した伝票。NULL のまま滞在が終わった行は「予約されたが提供されなかった食事」として'
  '運用で検知できる（DB物理設計 §3-6②）。';

-- 日別食数サマリー（仕込み数量）。未キャンセル・未変換だけを数える。
CREATE INDEX ix_meal_res_date ON public.meal_reservations (served_on, meal_slot)
  WHERE cancelled_at IS NULL AND converted_at IS NULL;

CREATE INDEX ix_meal_res_checkin ON public.meal_reservations (checkin_id);


-- =============================================================================
-- ⑤ RLS（§6-1 #12〜#15：いずれも PII-B ／ §6-7 のテンプレート）
-- =============================================================================

ALTER TABLE public.orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meal_reservations      ENABLE ROW LEVEL SECURITY;

-- ── orders（owner = purchaser_id）──────────────────────────
CREATE POLICY orders_select_self ON public.orders
  FOR SELECT TO authenticated
  USING ( purchaser_id = (SELECT public.current_member_id()) );

CREATE POLICY orders_select_staff ON public.orders
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- ★ セルフ注文（WBS 6-1）は本人名義かつ**自分がチェックイン中のときだけ**作れる。
--   他人の checkin_id を指定して他人の伝票に付け替える経路を塞ぐ。
CREATE POLICY orders_insert_self ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK ( purchaser_id = (SELECT public.current_member_id())
               AND EXISTS (SELECT 1
                           FROM   public.check_ins c
                           WHERE  c.checkin_id = orders.checkin_id
                             AND  c.member_id  = (SELECT public.current_member_id())
                             AND  c.status     = 'staying') );

-- 代理注文（WBS 6-2）・提供ステータス操作（6-5）・伝票編集（7-2）は staff。
CREATE POLICY orders_insert_staff ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY orders_update_staff ON public.orders
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：全拒否（取消は論理削除）。

-- ── order_items（親 `orders` に従う）──────────────────────
CREATE POLICY order_items_select_via_order ON public.order_items
  FOR SELECT TO authenticated
  USING ( EXISTS (SELECT 1 FROM public.orders o WHERE o.order_id = order_items.order_id) );

CREATE POLICY order_items_insert_self ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK ( EXISTS (SELECT 1
                       FROM   public.orders o
                       WHERE  o.order_id     = order_items.order_id
                         AND  o.purchaser_id = (SELECT public.current_member_id())) );

CREATE POLICY order_items_insert_staff ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- 明細の編集は staff のみ（v13 §5.6.2：顧客管理画面からの編集）。
CREATE POLICY order_items_update_staff ON public.order_items
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- ── settlement_adjustments（親 `orders` 経由。書き込みは staff）──
--   ★ `_select_self` を置くのは v13 §5.6.6「本人にも未処理差額を常時表示する」ため
--     （WBS 8-4 マイログ）。差額の存在を本人に隠さないことが仕様である。
CREATE POLICY settlement_adjustments_select_self ON public.settlement_adjustments
  FOR SELECT TO authenticated
  USING ( EXISTS (SELECT 1
                  FROM   public.orders o
                  WHERE  o.order_id     = settlement_adjustments.order_id
                    AND  o.purchaser_id = (SELECT public.current_member_id())) );

CREATE POLICY settlement_adjustments_select_staff ON public.settlement_adjustments
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY settlement_adjustments_insert_staff ON public.settlement_adjustments
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- 免除は Phase 1 ではコアメンバーにも許可（2026-08-16 回答）。よって admin 限定にしない。
CREATE POLICY settlement_adjustments_update_staff ON public.settlement_adjustments
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- ── meal_reservations（親 `check_ins` 経由。本人＋staff が書ける）──
CREATE POLICY meal_reservations_select_self ON public.meal_reservations
  FOR SELECT TO authenticated
  USING ( EXISTS (SELECT 1
                  FROM   public.check_ins c
                  WHERE  c.checkin_id = meal_reservations.checkin_id
                    AND  c.member_id  = (SELECT public.current_member_id())) );

CREATE POLICY meal_reservations_select_staff ON public.meal_reservations
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY meal_reservations_insert_self ON public.meal_reservations
  FOR INSERT TO authenticated
  WITH CHECK ( EXISTS (SELECT 1
                       FROM   public.check_ins c
                       WHERE  c.checkin_id = meal_reservations.checkin_id
                         AND  c.member_id  = (SELECT public.current_member_id())) );

CREATE POLICY meal_reservations_insert_staff ON public.meal_reservations
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY meal_reservations_update_self ON public.meal_reservations
  FOR UPDATE TO authenticated
  USING       ( EXISTS (SELECT 1
                        FROM   public.check_ins c
                        WHERE  c.checkin_id = meal_reservations.checkin_id
                          AND  c.member_id  = (SELECT public.current_member_id())) )
  WITH CHECK  ( EXISTS (SELECT 1
                        FROM   public.check_ins c
                        WHERE  c.checkin_id = meal_reservations.checkin_id
                          AND  c.member_id  = (SELECT public.current_member_id())) );

CREATE POLICY meal_reservations_update_staff ON public.meal_reservations
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );


-- =============================================================================
-- ⑥ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.orders                 FROM anon, authenticated;
REVOKE ALL ON public.order_items            FROM anon, authenticated;
REVOKE ALL ON public.settlement_adjustments FROM anon, authenticated;
REVOKE ALL ON public.meal_reservations      FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.orders                 TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.order_items            TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.settlement_adjustments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.meal_reservations      TO authenticated;


-- =============================================================================
-- ⑦ 本ファイルで**作らなかった**もの（後続が拾えるように明記する）
--
--   v13 §5.6.4／§7 L2446 が要求する **編集履歴ログ（audit_log）** の物理設計が
--   `DB物理設計.md` に存在しない。`order_items.edited_by` / `edit_reason` は
--   **最後の1回の編集しか残せず**、§5.6.5-4「遡及修正は通常の編集ログとは別に
--   警告レベルで記録」を満たせない。
--
--   ここで独自に作ると、監査ログの粒度・保存年限（v13 §5.11・非機能）を
--   本パッケージが勝手に決めることになるため作らない。
--   `QUESTIONS.md`「[2026-09-20] 伝票の編集履歴ログ（audit_log）の物理設計が存在しない」を参照。
--
--   同様に、v13 §7 L2445 の **精算グループ（一括精算）** と §5.6.2 の **手動調整行**
--   （まかない補助・割引）にも物理設計が無い。いずれも同じ論点として起票した。
-- =============================================================================
