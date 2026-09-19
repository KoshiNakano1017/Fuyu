-- =============================================================================
-- WBS 5-1：v_member_public（他者向け表示名）
--
-- 0001 は「v_member_public ビューと display_name の表示規則 … WBS 2-3 / 5-1」として
-- 本ビューを送り出していた。クエストボードで受注者・依頼者を表示するために要るため、ここで置く。
--
-- 根拠: DB物理設計.md §6-4（本ファイルの DDL の出どころ）、
--       会員データモデル §5.2c（**未設定時に本名へフォールバックしてはならない**＝不可侵ルール）、
--       2026-09-10 オーナー決定（`WBS_Phase1.md` L443）:
--         ① `nickname` 未設定時は**会員番号**で表示する
--         ② **親方兼街人は街人番号**で表示する（「親方優先」は不採用）
--
-- ⚠️ 未決の論点⑤（純粋な親方衆の会員番号の採番方式／`QUESTIONS.md`）には踏み込まない。
--    `legacy_member_no` を持たない会員は第3段（member_id 先頭8文字）へ落ちる。
--    論点⑤が決まるまでの既知の挙動であり、決まった時点で第2段の値が埋まる。
-- =============================================================================

CREATE VIEW public.v_member_public
WITH (security_invoker = false)   -- ビュー所有者権限で実行＝members の RLS を意図的に迂回する
AS
SELECT
  m.member_id,

  -- ★ フォールバックは3段。**氏名は候補に入らない**（§5.2c の不可侵ルール）。
  --   ここへ full_name を足すと、クエストボードを開いた全員に実名が露出する。
  --
  --   接頭辞は `member_type` で選ぶ。これは**表示ラベルの選択であって認可ではない**
  --   （認可の根拠は `role` のみ／v13 §2）。親方は else 側＝`街人#` になり、
  --   2026-09-10 決定②「親方兼街人は街人番号」と一致する。
  COALESCE(
    NULLIF(btrim(m.nickname), ''),
    (CASE WHEN m.member_type = 'ゲスト' THEN 'ゲスト#' ELSE '街人#' END) || m.legacy_member_no,
    (CASE WHEN m.member_type = 'ゲスト' THEN 'ゲスト#' ELSE '街人#' END) || left(m.member_id::text, 8)
  ) AS display_name,

  m.member_type   -- 画面上のバッジ表示用。認可には使わない（v13 §2）
FROM public.members m
WHERE m.account_status <> 'withdrawn';

REVOKE ALL    ON public.v_member_public FROM anon;
GRANT  SELECT ON public.v_member_public TO authenticated;

COMMENT ON VIEW public.v_member_public IS
  '他者向けに露出してよい会員情報はこの3列のみ。氏名・住所・連絡先・残高・XP を絶対に追加しない。'
  'display_name のフォールバック規則は 会員データモデル §5.2c の不可侵ルール（本名へ落とさない）。';
