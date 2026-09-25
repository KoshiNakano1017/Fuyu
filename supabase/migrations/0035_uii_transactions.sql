-- =============================================================================
-- 0035_uii_transactions.sql — Uii（地域通貨）の取引明細
--
--   QUESTIONS.md「[2026-09-21] Phase 1 に必要な4テーブルの DDL が本リポジトリに存在しない」
--   選択肢 A（Vault 側 `01_schema.sql` の既存 DDL を正として転記）を 2026-09-24 オーナー決定で採用。
--
--   根拠: `DB物理設計.md` §2 の表「定義のみ先行。Phase1 では移行・稼働しない」・
--          §6-1 #10（PII-B。`memo`／`operator_id`。本人＋staffが読める。書き込みはstaff。
--          **Phase 1 では稼働しないが RLS は先に張る**）
--   含む : uii_transactions のスキーマ・RLS・GRANT
--
-- ⚠️ Vault 側スキーマからの転記であり、実データは持ち込まない（CLAUDE.md §7.1）。
-- ⚠️ **Phase 1 ではこの表への INSERT を行うアプリコードを一切書かない**
--    （`members.uii_balance` も Phase 1 では未使用のまま。v13 §7 参照）。
--    RLS・GRANT だけを `stay_ticket_transactions`（0016）と同型で先に張り、
--    Phase 2 で稼働を始めるときにポリシーの作り直しが要らないようにする。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.uii_transactions (
  tx_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  member_id   uuid NOT NULL REFERENCES public.members (member_id),

  -- initial_grant = 取込時の初期値 ／ cashback = 初回来訪等のキャッシュバック（v13 §9 #51）
  -- charge        = 課金によるチャージ            ／ use      = アプリ内での使用
  -- offset        = 相殺調整                       ／ expiry   = 失効
  -- staff_adjust  = 運営による手動増減
  tx_type     text NOT NULL
                CONSTRAINT chk_uii_tx_type
                CHECK (tx_type IN
                  ('initial_grant', 'cashback', 'charge', 'use', 'offset', 'expiry', 'staff_adjust')),

  -- ★ 符号付き。増加・減少の両方をこの1列で表す（`stay_ticket_transactions.nights` と同型）。
  amount      integer NOT NULL
                CONSTRAINT chk_uii_tx_amount_not_zero CHECK (amount <> 0),

  memo        text,

  operator_id uuid REFERENCES public.members (member_id),

  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.uii_transactions IS
  'Uii（地域通貨）の取引明細（PII-B）。DB物理設計.md §6-1 #10。'
  '定義のみ先行させる表であり、Phase 1 ではこの表へ書き込むアプリコードを持たない。'
  '残高は本表の合計として算出する想定（stay_ticket_transactions と同じ設計。集計キャッシュ列は持たない）。';

CREATE INDEX IF NOT EXISTS ix_uii_tx_member ON public.uii_transactions (member_id, occurred_at DESC);


-- =============================================================================
-- ② RLS（`DB物理設計.md` §6-1 #10：本人＋staffが読める。書き込みはstaff）
-- =============================================================================

ALTER TABLE public.uii_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY uii_tx_select_self ON public.uii_transactions
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY uii_tx_select_staff ON public.uii_transactions
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- ★ INSERT は staff のみ。本人に書かせると自分の残高を増やせる。
CREATE POLICY uii_tx_insert_staff ON public.uii_transactions
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- UPDATE / DELETE：ポリシーを作らない ＝ 全拒否（取引明細は追記専用。訂正は逆仕訳を1行足す）。


-- =============================================================================
-- ③ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.uii_transactions FROM anon, authenticated;

GRANT SELECT, INSERT ON public.uii_transactions TO authenticated;  -- UPDATE/DELETE は与えない
