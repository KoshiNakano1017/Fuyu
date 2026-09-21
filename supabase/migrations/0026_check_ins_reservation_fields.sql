-- =============================================================================
-- 0026_check_ins_reservation_fields.sql — 公開予約ページが要る列を check_ins へ足す
--
--   WBS  : 3-5b（★ 公開予約ページ `/reserve`）／Issue #115
--   根拠 : v13 §5.2.3「公開予約ページの入力項目」・§5.4.2③（送迎は課金項目）
--   含む : check_ins への列追加（すべて NULL 許容）
--
-- ── 2026-09-21 オーナー決定 ──────────────────────────────────────
--
-- 「**到着予定と交通手段は宿泊情報関連のテーブルに NULL を許す形で**」
--
-- NULL 許容にするのは、既存行（`0014` 以降に入った予約・運営手入力・アプリ内予約）が
-- これらを持たないためである。NOT NULL にすると既存行の移行値を捏造することになる。
--
-- 「**連絡先はユーザーテーブルにして、宿泊テーブルには持たない**」という決定に従い、
-- **氏名・電話・メールの列はここに作らない**。それらは `member_identifiers`（`0025`）と
-- `member_profiles_private` が持ち、`check_ins.member_id` の外部キーで辿る。
-- =============================================================================

-- ── 到着予定時刻（v13 §5.2.3 の必須項目）───────────────────────────
--
--   `time` にするのは日付が `check_in_date` に既にあるためである。
--   `timestamptz` で二重に持つと、日付だけ直して時刻を直し忘れる事故が起きる。
ALTER TABLE public.check_ins
  ADD COLUMN IF NOT EXISTS arrival_time time;

COMMENT ON COLUMN public.check_ins.arrival_time IS
  '到着予定時刻（v13 §5.2.3）。日付は check_in_date が持つため time のみ。'
  'NULL は「申告なし」。既存行・運営手入力では空のことがある';


-- ── 交通手段（v13 §5.2.3 ／ §5.4.2③）────────────────────────────
--
--   ★ `shuttle`（送迎）は**課金項目**である。単価 1,900円（＝1,520 Uii・片道）は
--     `menu_items` のカテゴリ「送迎・オプション」に入っており、
--     チェックイン時に伝票へ計上する（v13 §5.4.2③）。
--     **ここに金額を持たせない。** 持たせると料金改定のたびに予約行を書き換えることになる。
ALTER TABLE public.check_ins
  ADD COLUMN IF NOT EXISTS transport_method text;

ALTER TABLE public.check_ins
  DROP CONSTRAINT IF EXISTS chk_check_ins_transport_method;

ALTER TABLE public.check_ins
  ADD CONSTRAINT chk_check_ins_transport_method
  CHECK (transport_method IS NULL
         OR transport_method IN ('car', 'taxi', 'shuttle', 'other'));

COMMENT ON COLUMN public.check_ins.transport_method IS
  '交通手段（v13 §5.2.3）。car/taxi/shuttle/other。'
  'shuttle は課金項目でチェックイン時に伝票へ計上する（§5.4.2③）。金額は menu_items が持つ';


-- ── 同意の記録（v13 §5.2.3「同意した版数を予約レコードへ記録する」）────────
--
--   ⚠️ **`consent_version` の採番規則はまだ決まっていない。**
--      「浮遊街に宿泊される方へ」の版数をどう振るかがリポジトリに無いため、
--      列だけ用意し、当面は `consented_at`（同意した事実と時刻）だけを埋める。
--      `QUESTIONS.md`／Issue #115 の B が未回答である。
--
--      版数が決まったら **既存行を遡って埋めない**こと。同意した時点の版が分からない行に
--      現在の版を入れると、「その版に同意した」という事実を捏造することになる。
ALTER TABLE public.check_ins
  ADD COLUMN IF NOT EXISTS consented_at    timestamptz;
ALTER TABLE public.check_ins
  ADD COLUMN IF NOT EXISTS consent_version text;

COMMENT ON COLUMN public.check_ins.consented_at IS
  '「浮遊街に宿泊される方へ」へ同意した時刻（v13 §5.2.3）。NULL は同意の記録が無い予約';
COMMENT ON COLUMN public.check_ins.consent_version IS
  '同意した版数。⚠️ 採番規則が未決のため当面 NULL（Issue #115 B）。'
  '決まっても既存行を遡って埋めないこと（同意した版の捏造になる）';
