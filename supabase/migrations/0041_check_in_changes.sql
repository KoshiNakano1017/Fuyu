-- =============================================================================
-- 0041_check_in_changes.sql — 滞在中の宿泊形態・部屋・日程・人数の変更（WBS 3-10）
--
--   根拠: v13 §5.6.9（2026-08-25 決定 ／ §9 #50）・§5.2.5（残枠の算出）・
--         §5.4.2②（適用期間付きの料金マスタ）・§5.6.4（編集理由）・§6（権限マトリクス）
--
-- ── 含む ────────────────────────────────────────────────────
--   ①〜③ check_in_changes（変更履歴。誰が・いつ・何を・なぜ変えたか）＋ RLS ＋ GRANT
--   ④     check_in_state_on()（その夜に効いている形態・人数を引く関数）
--   ⑤     v_room_availability の差し替え（**その夜に実際に使う形態**で占有を数える）
--   ⑥     rooms.room_type の書き換え禁止トリガー（v13 §5.6.9 の [!important] の実装ガード）
--
-- ── 含まない ────────────────────────────────────────────────
--   - 宿泊費の請求・差額の消し込み経路。**本節で独自の精算経路は作らない**（§5.6.9 の「差額の扱い」）。
--     そもそも宿泊費を伝票として起こす経路が Phase 1 にまだ無く（`orders` は注文のみ／`0019`）、
--     ここで先回りして `settlement_adjustments` へ行を積むと、請求の無い差額だけが溜まる
--   - 画面（顧客管理 C11 の「宿泊」タブ）→ `src/components/customers/StayChangeSection.tsx`
--
-- ── なぜ「履歴表」が必要か（`check_ins` の更新だけでは足りない）─────────
--   §5.6.9 は宿泊費を「**その夜に実際に使った宿泊形態**の単価」で積むと定める。
--   `check_ins.room_type` を上書きするだけの実装では、**滞在の途中で形態が変わった事実が消える**。
--   3泊目からコテージへ移った滞在は、上書き後に読むと「3泊すべてコテージ」に見え、
--   滞在全体が新しい単価で塗り替えられる（同節が禁じている振る舞いそのもの）。
--   したがって「いつの夜から新しい形態か」を持つ履歴表を正本にし、
--   `check_ins.room_type` は**現在の形態**（＝最後の変更の結果）として扱う。
-- =============================================================================


-- =============================================================================
-- ① check_in_changes（滞在の変更履歴）
--
--   `member_role_changes`（`0003`）と同じ位置づけの追記専用ログである。
--   変更前・変更後を**同じ行に**持つのは、後から「差分を復元できない」事故を防ぐため。
--   前の行を引き当てて差分を取る設計にすると、履歴の1行が欠けた瞬間に
--   その滞在の単価の切り替わりが読めなくなる。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.check_in_changes (
  change_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  checkin_id       uuid NOT NULL REFERENCES public.check_ins (checkin_id) ON DELETE CASCADE,

  -- ★ **この日の夜から**変更後の内容が効く（v13 §5.6.9「変更日を境に単価が切り替わる」）。
  --   滞在中の変更は当日、予約段階の変更は初日を既定とする（決め方はアプリ側 ／ `stay-changes.ts`）。
  --   ⚠️ 退去日は専有しないため（`0015`）、`effective_date` に退去日を入れると
  --      1泊も効かない変更行になる。アプリ側で `check_in_date <= effective_date < check_out_date`
  --      を保証する（DB 側では滞在の日付を読まないと判定できないため CHECK にしていない）。
  effective_date   date NOT NULL,

  -- 変更前・変更後。**変わらなかった項目は両方 NULL** にする。
  -- 「変更前 = 変更後」の行を許すと、履歴を読む側が「何が変わったのか」を毎回比較して
  -- 判断することになり、§7.2（番号だけを渡さない）と同じ読み手負担が生まれる。
  room_type_before      text REFERENCES public.accommodation_types (room_type),
  room_type_after       text REFERENCES public.accommodation_types (room_type),
  check_out_date_before date,
  check_out_date_after  date,
  adults_before         integer CONSTRAINT chk_cic_adults_before_non_negative  CHECK (adults_before   IS NULL OR adults_before   >= 0),
  adults_after          integer CONSTRAINT chk_cic_adults_after_non_negative   CHECK (adults_after    IS NULL OR adults_after    >= 0),
  children_before       integer CONSTRAINT chk_cic_children_before_non_negative CHECK (children_before IS NULL OR children_before >= 0),
  children_after        integer CONSTRAINT chk_cic_children_after_non_negative  CHECK (children_after  IS NULL OR children_after  >= 0),

  -- 部屋割当の移動先（`room_assignments` 側にも行を積む）。**未割当のままの変更もありうる**ため NULL 可。
  room_id_after    uuid REFERENCES public.rooms (room_id),

  -- ★ 理由は必須（v13 §5.6.9「理由入力：必須」／§5.6.4 の編集理由と同じ扱い）。
  reason           text NOT NULL
                     CONSTRAINT chk_cic_reason_present
                     CHECK (btrim(reason) <> ''),

  -- 誰が変えたか。運営（admin / core_member）以外は RLS で書けない。
  changed_by       uuid NOT NULL REFERENCES public.members (member_id),

  created_at       timestamptz NOT NULL DEFAULT now(),

  -- 変更が1つも無い行を作らせない。押し間違いで理由だけが積まれるのを防ぐ。
  CONSTRAINT chk_cic_has_change CHECK (
       (room_type_before      IS NOT NULL AND room_type_after      IS NOT NULL)
    OR (check_out_date_before IS NOT NULL AND check_out_date_after IS NOT NULL)
    OR (adults_before         IS NOT NULL AND adults_after         IS NOT NULL)
    OR (children_before       IS NOT NULL AND children_after       IS NOT NULL)
    OR room_id_after IS NOT NULL
  ),

  -- 変更前と変更後が同じ値の組を弾く。「変えていない項目は NULL」の規約を DB で守らせる。
  CONSTRAINT chk_cic_room_type_actually_changed
    CHECK (room_type_before IS NULL OR room_type_before <> room_type_after),
  CONSTRAINT chk_cic_check_out_actually_changed
    CHECK (check_out_date_before IS NULL OR check_out_date_before <> check_out_date_after),
  CONSTRAINT chk_cic_adults_actually_changed
    CHECK (adults_before IS NULL OR adults_before <> adults_after),
  CONSTRAINT chk_cic_children_actually_changed
    CHECK (children_before IS NULL OR children_before <> children_after)
);

COMMENT ON TABLE public.check_in_changes IS
  '滞在の変更履歴（v13 §5.6.9 ／ WBS 3-10）。追記専用。'
  '宿泊形態は「その夜に実際に使った形態」で単価を積むため、いつの夜から変わったか（effective_date）を持つ。'
  'check_ins.room_type は現在の形態であり、過去の夜の形態はこの表からしか復元できない。';

COMMENT ON COLUMN public.check_in_changes.effective_date IS
  'この日の夜から変更後の内容が効く。滞在全体を新しい形態で塗り替えないための境界（v13 §5.6.9）。';

COMMENT ON COLUMN public.check_in_changes.room_type_before IS
  '変更前の宿泊形態。変えていない場合は after とともに NULL（chk_cic_room_type_actually_changed）。';

-- 履歴の読み出しは「ある滞在の、日付順」でしか行わない（画面・残枠ビューのどちらも）。
CREATE INDEX IF NOT EXISTS ix_check_in_changes_stay
  ON public.check_in_changes (checkin_id, effective_date, created_at);


-- =============================================================================
-- ② RLS（`DB物理設計.md` §6-7 のデフォルト拒否 ／ v13 §6 の権限マトリクス）
--
--   §5.6.9 の権限は「管理者・コアメンバー」＝ `is_staff()`。部屋割当と同じ幅である。
--   ★ 本人向けの SELECT は置かない。ここに残るのは**運営の編集理由**であり、
--     本人に見せるのは §5.6.8 の宿泊履歴（部屋と日付）までである。
-- =============================================================================

ALTER TABLE public.check_in_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY check_in_changes_select_staff ON public.check_in_changes
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY check_in_changes_insert_staff ON public.check_in_changes
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- UPDATE / DELETE：ポリシーを作らない ＝ 全拒否（追記専用。訂正は新しい変更行を積む）。


-- =============================================================================
-- ③ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.check_in_changes FROM anon, authenticated;

GRANT SELECT, INSERT ON public.check_in_changes TO authenticated;  -- UPDATE/DELETE は与えない


-- =============================================================================
-- ④ check_in_state_on() — その夜に効いている滞在の内容（形態・人数）
--
--   ★ **項目ごとに「最後の非NULL」を引く。** 1件の変更行は変わった項目だけを持つため
--     （`chk_cic_has_change` の規約）、「最後の変更行」を1行選んでその列を読む実装では、
--     人数だけを直した変更のあとに形態が NULL で返る。
--
--   優先順は3段：① その夜までに効いた変更の最後の `*_after`
--                ② 1件も無ければ最初の変更の `*_before`（＝滞在開始時の値）
--                ③ 変更履歴が無ければ `check_ins` の現在値
--
--   ⚠️ 直接呼ぶと `check_ins` の RLS が効く（本人 ＋ staff）。残枠ビューから呼ぶ場合は
--      ビュー所有者の権限で走るため、他人の滞在も数えられる（`0015` の security_invoker = false）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_in_state_on(p_checkin_id uuid, p_date date)
RETURNS TABLE (room_type text, adults_count integer, children_count integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    COALESCE(
      (SELECT c.room_type_after FROM public.check_in_changes c
        WHERE c.checkin_id = p_checkin_id AND c.room_type_after IS NOT NULL
          AND c.effective_date <= p_date
        ORDER BY c.effective_date DESC, c.created_at DESC LIMIT 1),
      (SELECT c.room_type_before FROM public.check_in_changes c
        WHERE c.checkin_id = p_checkin_id AND c.room_type_before IS NOT NULL
        ORDER BY c.effective_date ASC, c.created_at ASC LIMIT 1),
      ci.room_type),
    COALESCE(
      (SELECT c.adults_after FROM public.check_in_changes c
        WHERE c.checkin_id = p_checkin_id AND c.adults_after IS NOT NULL
          AND c.effective_date <= p_date
        ORDER BY c.effective_date DESC, c.created_at DESC LIMIT 1),
      (SELECT c.adults_before FROM public.check_in_changes c
        WHERE c.checkin_id = p_checkin_id AND c.adults_before IS NOT NULL
        ORDER BY c.effective_date ASC, c.created_at ASC LIMIT 1),
      ci.adults_count),
    COALESCE(
      (SELECT c.children_after FROM public.check_in_changes c
        WHERE c.checkin_id = p_checkin_id AND c.children_after IS NOT NULL
          AND c.effective_date <= p_date
        ORDER BY c.effective_date DESC, c.created_at DESC LIMIT 1),
      (SELECT c.children_before FROM public.check_in_changes c
        WHERE c.checkin_id = p_checkin_id AND c.children_before IS NOT NULL
        ORDER BY c.effective_date ASC, c.created_at ASC LIMIT 1),
      ci.children_count)
  FROM public.check_ins ci
  WHERE ci.checkin_id = p_checkin_id;
$$;

COMMENT ON FUNCTION public.check_in_state_on(uuid, date) IS
  'その夜に効いている滞在の内容（宿泊形態・大人・子供 ／ v13 §5.6.9 ／ WBS 3-10）。'
  '変更履歴（check_in_changes）を項目ごとに引き当てる。残枠ビューと宿泊費の算定が同じ答えを見るための唯一の出所。';

REVOKE ALL    ON FUNCTION public.check_in_state_on(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.check_in_state_on(uuid, date) TO authenticated, service_role;


-- =============================================================================
-- ⑤ v_room_availability の差し替え — 占有は「その夜に実際に使う形態」で数える
--
-- > [!danger] ここを直さないと、翌日からの形態変更が**その日の夜をダブルブッキングする**
-- > 差し替え前のビューは `check_ins.room_type`（＝現在の形態）で滞在の全泊を数えていた。
-- > 「明日からキャンプサイト → コテージへ移る」変更を入れた瞬間、
-- > **今夜のキャンプサイトが空き枠として返り**、同じ枠に別の予約を通してしまう。
-- > 逆にコテージは今夜も埋まっている扱いになり、泊まれるのに満室と出る。
-- >
-- > 変更履歴（`check_in_changes`）を引いて、日付ごとに効いている形態へ割り当て直す。
-- > 変更が1件も無い滞在では `ci.room_type` に落ちるため、従来と同じ結果になる。
--
--   `CREATE OR REPLACE VIEW` で列の名前・型・並びは `0015` と同一に保つ（変えると REPLACE が失敗する）。
--   `security_invoker = false` の理由は `0015` の冒頭コメントのまま（集計値だけを返す）。
-- =============================================================================

CREATE OR REPLACE VIEW public.v_room_availability
WITH (security_invoker = false)
AS
WITH cal AS (
  SELECT d::date AS date
  FROM   generate_series(current_date, current_date + interval '180 days', interval '1 day') AS d
),
cap AS (
  SELECT
    r.room_type,
    SUM(r.capacity) AS total_capacity,
    COUNT(*)        AS total_units,
    MAX(r.capacity) AS unit_capacity
  FROM   public.rooms r
  WHERE  r.status = '利用可'
  GROUP BY r.room_type
),
booked AS (
  SELECT
    eff.room_type,
    cal.date,
    SUM(eff.adults_count + eff.children_count) AS booked_persons,
    -- 定員超過分は複数棟を消費する。3名でコテージ（定員2）を取れば2棟。
    SUM(CEIL((eff.adults_count + eff.children_count)::numeric
             / NULLIF(cap.unit_capacity, 0)))  AS booked_units
  FROM   public.check_ins ci
  JOIN   cal ON cal.date >= ci.check_in_date
            AND cal.date <  ci.check_out_date   -- チェックアウト日は専有しない
  -- ★ その夜に効いている形態・人数を使う（`ci.room_type` ＝ 現在の形態では数えない ／ ④）。
  CROSS JOIN LATERAL public.check_in_state_on(ci.checkin_id, cal.date) eff
  JOIN   cap ON cap.room_type = eff.room_type
  WHERE  ci.cancelled_at IS NULL
    AND  ci.status IN ('pre_registered', 'confirmed', 'staying')
  GROUP BY eff.room_type, cal.date
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
  '占有は「その夜に実際に使う形態」で数える（check_in_changes を引く ／ v13 §5.6.9・WBS 3-10）。'
  'security_invoker = false は意図的（集計値のみを返すため）。行レベルの列を足してはならない。';

REVOKE ALL    ON public.v_room_availability FROM anon;
GRANT  SELECT ON public.v_room_availability TO   authenticated;


-- =============================================================================
-- ⑥ rooms.room_type の書き換え禁止（v13 §5.6.9 の [!important] の実装ガード）
--
-- > [!important] 宿泊形態は「予約の属性」であって「部屋の属性」ではない
-- > 「コテージAをこの1件のためにキャンプサイトにする」実装は、**部屋台帳を壊す**。
-- > 他の予約の残枠・カレンダー・料金がすべて巻き添えになる（§5.6.9）。
-- > 正しい操作は滞在側（`check_ins.room_type`）の変更であり、部屋台帳は動かさない。
--
--   WBS 3-10 が求める「`rooms.type` を書き換えない実装ガード」を**DB 側に置く**。
--   アプリ側のレビューだけに頼ると、将来の実装が善意で `rooms` を更新して同じ事故を起こす。
--   部屋そのものの用途を本当に変える場合は、その行を `status = '利用停止'` にして
--   新しい部屋を1行足す（履歴が `room_name_snapshot` に残り、過去の割当が壊れない ／ §5.6.8）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.forbid_room_type_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'rooms.room_type は変更できない（v13 §5.6.9）。滞在側（check_ins.room_type）を変更し、部屋の用途を本当に変える場合は当該行を利用停止にして新しい部屋を追加する'
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION public.forbid_room_type_rewrite() IS
  '部屋台帳の宿泊形態の書き換えを拒む（v13 §5.6.9 ／ WBS 3-10）。'
  '形態は滞在側（check_ins）の属性であり、部屋の属性ではない。';

CREATE TRIGGER trg_rooms_room_type_immutable
  BEFORE UPDATE OF room_type ON public.rooms
  FOR EACH ROW
  WHEN (OLD.room_type IS DISTINCT FROM NEW.room_type)
  EXECUTE FUNCTION public.forbid_room_type_rewrite();
