-- =============================================================================
-- WBS 3-8：宿泊枠の残数算出（`v_room_availability`）
--
-- 根拠: v13 §5.2.5①（残枠は保存カラムを持たず都度算出する）・§9 #47（算出元を
--       `room_assignments` → `check_ins` へ変更・占有量を2モードに分離）、
--       `DB物理設計.md` §3-12（本ビューの定義の出どころ）
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : v_room_availability ビューと GRANT
--   含まない:
--     - 本人向けカレンダー（画面ID A12）・運営向けカレンダー（C10） → WBS 3-6
--     - 宿泊料金マスタ `accommodation_rates`                        → WBS 3-9
--
-- ── 設計上動かしてはならない点（いずれも事故の再発防止）──────────────
--   1. **残枠カラム・キャッシュを持たない。** 加減算方式はダブルブッキングの温床
--      （v13 §8・§9 #25。実データで15件の不整合が出た経緯がある）
--   2. **算出元は `check_ins`。** `room_assignments` から数えると、備考欄が空で
--      自動確定した予約は部屋割当が無いため残枠を1つも減らさない（v13 §9 #47）
--   3. **チェックアウト日は専有しない**（`cal.date < check_out_date`）。`<=` にすると
--      退去日と次の到着日が重なる予約を弾いてしまい、稼働率が落ちる
-- =============================================================================


-- =============================================================================
-- v_room_availability：日付 × 宿泊形態ごとの残枠
--
-- > [!danger] security_invoker は false にする（意図的）
-- > `check_ins` の RLS は「本人の行 ＋ staff」であり（0014 §⑤）、
-- > **invoker 権限で走らせると、一般会員には自分の予約しか見えず
-- > 残枠が常に「ほぼ満室」として返る**（他人の占有が見えないのではなく、
-- > 他人の占有が 0 として数えられる ＝ 空いていないのに空きと出る）。
-- > 本ビューが返すのは **日付・形態ごとの集計値だけ**であり、
-- > 誰が泊まるかは1行も出ない。0009 の `v_member_public` と同じく
-- > 「露出してよい列だけで構成したビュー」に該当する。
-- >
-- > ⚠️ 本ビューに `member_id`・氏名・備考などの行レベルの列を足してはならない。
-- >    足した瞬間、security_invoker = false が RLS の迂回口になる。
-- =============================================================================

CREATE VIEW public.v_room_availability
WITH (security_invoker = false)   -- 理由は直上のコメント。集計値のみを返すことが前提条件
AS
WITH cal AS (
  -- 180日先まで。公開予約ページの選択可能範囲がこの窓に収まる（v13 §5.2.3）。
  SELECT d::date AS date
  FROM   generate_series(current_date, current_date + interval '180 days', interval '1 day') AS d
),
cap AS (
  SELECT
    r.room_type,
    SUM(r.capacity) AS total_capacity,   -- 人数枠型の分母
    COUNT(*)        AS total_units,      -- 棟貸型の分母
    MAX(r.capacity) AS unit_capacity     -- 棟貸型の1棟あたり定員（コテージ等は2）
  FROM   public.rooms r
  -- メンテナンス中・利用停止を分母に入れると、予約できてしまい当日に部屋が無い（v13 §5.2.1）。
  WHERE  r.status = '利用可'
  GROUP BY r.room_type
),
booked AS (
  SELECT
    ci.room_type,
    cal.date,
    SUM(ci.adults_count + ci.children_count) AS booked_persons,
    -- 定員超過分は複数棟を消費する。3名でコテージ（定員2）を取れば2棟。
    SUM(CEIL((ci.adults_count + ci.children_count)::numeric
             / NULLIF(cap.unit_capacity, 0)))  AS booked_units
  FROM   public.check_ins ci
  JOIN   cap ON cap.room_type = ci.room_type
  JOIN   cal ON cal.date >= ci.check_in_date
            AND cal.date <  ci.check_out_date   -- チェックアウト日は専有しない
  WHERE  ci.cancelled_at IS NULL                -- キャンセル・ノーショーは専有しない（v13 §5.2.2）
    AND  ci.status IN ('pre_registered', 'confirmed', 'staying')
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
  -- GREATEST(..., 0) で負値を潰す。運営が定員超過を手で入れた場合に
  -- 「残り -2」を画面へ出さないため（満室は満室として扱う）。
  GREATEST(
    CASE t.allocation_mode
      WHEN 'per_person' THEN cap.total_capacity - COALESCE(b.booked_persons, 0)
      ELSE cap.total_units - COALESCE(b.booked_units, 0)
    END, 0) AS available
FROM       cal
CROSS JOIN public.accommodation_types t
JOIN       cap ON cap.room_type = t.room_type
LEFT JOIN  booked b ON b.room_type = t.room_type AND b.date = cal.date;

COMMENT ON VIEW public.v_room_availability IS
  '日付 × 宿泊形態ごとの残枠（v13 §5.2.5① ／ DB物理設計 §3-12）。保存カラムを持たず都度算出する。'
  '算出元は check_ins（room_assignments ではない／§9 #47）。'
  'security_invoker = false は意図的（集計値のみを返すため）。行レベルの列を足してはならない。';


-- =============================================================================
-- GRANT（DB物理設計 §6-6②）
--
--   残枠はゲストも見る（v13 §5.2.3 の公開予約ページ）。authenticated 全員へ SELECT。
--   ⚠️ `anon` には与えない。未ログインの公開予約ページは anon キーで直接 DB を読まず、
--      必ずサーバ側（service_role）を経由する（API設計 §1-1・非機能要件詳細 §2-2b）。
-- =============================================================================

REVOKE ALL    ON public.v_room_availability FROM anon;
GRANT  SELECT ON public.v_room_availability TO   authenticated;
