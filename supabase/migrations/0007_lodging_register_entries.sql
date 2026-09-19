-- =============================================================================
-- WBS 2-4：宿泊者名簿（lodging_register_entries）
--
-- 根拠: v13 §5.2（旅館業法に基づく「住所」「前泊地」「後泊地/行先」を収集・管理出力可能にする）、
--       v13 §7「★ 宿泊者名簿」（専用テーブル／スナップショット／ON DELETE SET NULL／
--       3年保存が退会30日後の匿名化に優先する）、
--       DB物理設計.md §3-13②③④（DDL・退会時のふるまい・保存期限）・
--       §6-1 表 No.32（PII-A：読みは本人＋admin/core_member、書きは staff）・
--       §6-6①②（anon の権限ゼロ化・GRANT は剥がしてから与える）・§6-7（RLS 有効化）
--
-- ── スコープ（Issue #58 の 2026-09-19 オーナー決定 ＝ A案）──────────────
--   含む : lodging_register_entries のスキーマ・制約・索引・RLS・GRANT
--   含まない:
--     - 収集UI（氏名・カナ・住所・前泊地の入力画面）   → WBS 3-1 / 3-2
--     - 法定出力（CSV 等）・3年経過分の削除ジョブ       → 後続
--     - プライバシーポリシー・利用規約への反映          → 別途（§3-13③ の要確認）
--
-- `member_profiles_private`（氏名・カナ・住所・出身地・誕生年月）は 0001＋0005 で実装済み。
-- 2-4 のうち未実装だったのは本表だけである。
-- =============================================================================


-- =============================================================================
-- ① lodging_register_entries（§3-13②）
--
-- ★ check_ins へ列を足すのではなく専用テーブルにする理由（§3-13①）:
--   check_ins は PII-B（本人が自分の行を読める）だが、名簿は氏名・住所を持つ PII-A である。
--   RLS は列を絞れないため、check_ins に住所を足すと**同伴者の住所が予約者へ返る**。
-- =============================================================================

CREATE TABLE public.lodging_register_entries (
  entry_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ★ 参照は「弱い」リンクにする。会員・チェックインが消えても名簿は残る（§3-13③）。
  --
  -- ⚠️ `check_ins` は WBS 3-2（Issue #54）の成果物であり、まだ存在しない。
  --    そのため **外部キー制約はここでは張らない**（張ると DDL が適用できない）。
  --    3-2 が `check_ins` を作った時点で、次の ALTER を追加すること。
  --
  --      ALTER TABLE public.lodging_register_entries
  --        ADD CONSTRAINT fk_lodging_register_check_in
  --        FOREIGN KEY (checkin_id) REFERENCES public.check_ins (checkin_id)
  --        ON DELETE SET NULL;
  --
  --    CLAUDE.md §4.5「既存マイグレーションを書き換えない」に反しないよう、
  --    後続が ALTER で足せる形にしてある（0006_rooms_and_assignments.sql と同じ扱い）。
  checkin_id      uuid,

  -- NULL 許容は必須。NOT NULL にすると ON DELETE SET NULL が成立せず、
  -- 会員行の物理削除で名簿が失われる（＝法定記録の消失）。
  member_id       uuid REFERENCES public.members (member_id) ON DELETE SET NULL,

  -- ★ 宿泊時点のスナップショット（値のコピー）。member_profiles_private を参照しない（§3-13②）。
  full_name_snapshot      text NOT NULL,
  full_name_kana_snapshot text,
  address_snapshot        text NOT NULL,
  previous_location       text,          -- 前泊地（v13 §5.2）
  next_destination        text,          -- 後泊地／行先（v13 §5.2）

  -- 滞在の事実（名簿の索引項目）
  checked_in_on   date NOT NULL,
  checked_out_on  date,                  -- 滞在中は NULL
  is_representative boolean NOT NULL DEFAULT true,   -- false = 同伴者

  -- 記録の出所と操作者
  recorded_by     uuid REFERENCES public.members (member_id) ON DELETE SET NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'checkin'
                    CONSTRAINT chk_lodging_register_source
                    CHECK (source IN ('checkin', 'web_public', 'staff_manual', 'migration')),

  -- 保存期限。3年保存（§3-13④）。
  -- ★ 生成列にするのは「保存期限を書き込み側が詐称できない」ようにするため。
  --   列にしておけば ix_lodging_register_retention で掃き出しジョブが引ける。
  --   生成列の式は IMMUTABLE のみで構成する必要があるため、current_date 等を混ぜてはならない。
  retention_until_on date GENERATED ALWAYS AS
                       ((coalesce(checked_out_on, checked_in_on) + interval '3 years')::date) STORED,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- 同日チェックアウト（日帰り扱いの滞在）は許可する。逆転だけを弾く。
  CONSTRAINT chk_stay_period CHECK (checked_out_on IS NULL OR checked_out_on >= checked_in_on)
);

-- 法定出力（期間指定での抽出）と保存期限の掃き出しに効かせる（§3-13②）。
CREATE INDEX ix_lodging_register_period    ON public.lodging_register_entries (checked_in_on);
CREATE INDEX ix_lodging_register_retention ON public.lodging_register_entries (retention_until_on);

-- 退会・会員削除で member_id が NULL になった行まで索引に載せない。
CREATE INDEX ix_lodging_register_member    ON public.lodging_register_entries (member_id)
  WHERE member_id IS NOT NULL;

COMMENT ON TABLE public.lodging_register_entries IS
  '宿泊者名簿（旅館業法対応／v13 §5.2）。氏名・住所は宿泊時点のスナップショットであり、'
  '会員が後から住所を変更しても本表の記録は変わらない。members / check_ins へのFKは '
  'ON DELETE SET NULL。退会・予約削除で名簿を失わないため（3年保存を優先／2026-09-05 オーナー決定）';

COMMENT ON COLUMN public.lodging_register_entries.address_snapshot IS
  '宿泊時点の住所の写し。member_profiles_private.address を参照してはならない。'
  '参照にすると、住所変更で過去の名簿が書き換わる（＝法定記録の遡及改変になる）';


-- =============================================================================
-- ② RLS：既定は全拒否（§6-7）
--
-- 本表は本リポジトリで最も保護区分の高い PII-A（氏名・住所）である。
-- 認可は **role のみ**で判定する。member_type（親方／街人／ゲスト）は立場であって
-- 権限ではないため、ポリシー条件に一切現れてはならない（v13 §2）。
-- =============================================================================

ALTER TABLE public.lodging_register_entries ENABLE ROW LEVEL SECURITY;

-- ── SELECT：本人の行 ＋ staff（admin / core_member）──────────────────
--    §6-1 表 No.32。staff が全行を読めるのは法定出力のため。
--
--    ⚠️ member_id が NULL の行（同伴者・会員行が物理削除された行）は、
--       `member_id = current_member_id()` が NULL 判定になるため誰にも本人として見えない。
--       安全側（見えすぎるのではなく見えない）に倒してある。
CREATE POLICY lre_select_self ON public.lodging_register_entries
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY lre_select_staff ON public.lodging_register_entries
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- ── INSERT / UPDATE：staff だけ（§6-1 表 No.32「書き込み: staff」）────────
--    本人の自己申告で名簿を作れると、法定名簿が「本人の言い値」になる（§3-13⑤）。
--    UPDATE は誤記の訂正のみを想定する。§3-13② の warning は訂正を admin に限る読みも
--    許すが、より狭める場合も後続マイグレーションでポリシーを差し替えれば足りる。
CREATE POLICY lre_insert_staff ON public.lodging_register_entries
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY lre_update_staff ON public.lodging_register_entries
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを1本も作らず、GRANT も与えない ＝ 全拒否。
--   3年経過分の削除は `retention_until_on < current_date` を条件にした定期ジョブ
--   （service_role）だけが行う（§3-13③④）。クライアントから名簿を消せてはならない。


-- =============================================================================
-- ③ GRANT（§6-6②）
--
-- ★ 0005・0006 と同じく、**先に既定の広い権限を剥がしてから**必要分だけ与える。
--   剥がさないと、Supabase の既定 GRANT が残って RLS より手前で素通りする
--   （2026-09-16 に同種の見落としが DB テストで捕まった前例がある）。
--
-- anon は 0005 の ALTER DEFAULT PRIVILEGES で既にゼロだが、
-- 既定値に依存せず明示的にも剥がす（§6-6①）。
-- =============================================================================

REVOKE ALL ON public.lodging_register_entries FROM anon, authenticated;

-- 行の絞り込みは上の RLS が行う。staff も authenticated セッションで書くため、
-- INSERT / UPDATE の GRANT 自体は authenticated に与える必要がある。
GRANT SELECT, INSERT, UPDATE ON public.lodging_register_entries TO authenticated;
