-- =============================================================================
-- WBS 3-1：部屋台帳・部屋割当（rooms / room_assignments）
--
-- 根拠: v13 §5.2.1（部屋割当）・§7「★ 部屋台帳・部屋割当」・§5.6.8（過去履歴の表示）、
--       DB物理設計.md §6-1 #11・#29・§6-7・§1-3（物理削除の原則禁止）、
--       Issue #31 の 2026-09-15 オーナー決定（論点①②）
--
-- ── スコープ（オーナー決定 ＝ 論点② 「DB層まで」）────────────────
--   含む : rooms / room_assignments のスキーマ・制約・RLS・GRANT・初期8行
--   含まない:
--     - 割当の操作画面（部屋移動 UI）        → WBS 3-2 以降
--     - 宿泊予定カレンダー                   → WBS 3-6
--     - `check_ins` テーブルそのもの         → WBS 3-2
--
-- `3-1` の完了で 7件（3-2 / 3-3 / 3-5b / 3-6 / 3-8 / 3-10 / 8-6）の依存が解ける。
-- これらはいずれも API・UI を自分で持つため、ここに画面まで含めると担当が重複する。
-- =============================================================================


-- =============================================================================
-- ① rooms（部屋台帳）
--
-- v13 §7 が列挙する項目：部屋ID／部屋名・番号／capacity／部屋種別／ステータス／
--                        place_id（任意）／備考
-- =============================================================================

CREATE TABLE public.rooms (
  room_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 部屋名・番号。**リネームされうる**ため、履歴側は room_name_snapshot を持つ（§5.6.8）。
  room_name    text NOT NULL
                 CONSTRAINT chk_rooms_name_present CHECK (btrim(room_name) <> ''),

  -- 収容枠数。ドミトリーはベッド数、個室は定員（v13 §5.2.1）。
  capacity     integer NOT NULL
                 CONSTRAINT chk_rooms_capacity_positive CHECK (capacity > 0),

  -- 部屋種別。DB物理設計 §3-12 の accommodation_types.room_type と**同じ6値**に揃える。
  -- 揃えないと、宿泊形態と部屋の対応が取れなくなる（残枠計算が破綻する）。
  room_type    text NOT NULL
                 CONSTRAINT chk_rooms_room_type
                 CHECK (room_type IN ('dormitory', 'cottage', 'campsite', 'car', 'earthbag', 'salon')),

  -- ステータス。**メンテナンス中の部屋を空きとして数えない**ための列（§5.2.5・§6-2 の残枠算出）。
  status       text NOT NULL DEFAULT '利用可'
                 CONSTRAINT chk_rooms_status
                 CHECK (status IN ('利用可', 'メンテナンス中', '利用停止')),

  -- 拠点・施設マスタへの任意参照。`places` は未作成のため FK は張らず、
  -- 値だけを持てるようにしておく（張るのは places を作る作業パッケージ）。
  place_id     uuid,

  note         text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rooms IS
  '部屋台帳（v13 §7）。物理削除しない（status = 利用停止 で無効化する／§1-3）。'
  'リネームされうるため、履歴側は room_assignments.room_name_snapshot を持つ（§5.6.8）。';


-- =============================================================================
-- ② room_assignments（部屋割当）
--
-- v13 §7 が列挙する項目：割当ID／チェックインID（FK）／部屋ID／
--                        room_name_snapshot／開始日時／終了日時／割当理由
-- =============================================================================

CREATE TABLE public.room_assignments (
  assignment_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ⚠️ `check_ins` は WBS 3-2 の成果物であり、まだ存在しない。
  --    そのため **外部キー制約はここでは張らない**（張ると DDL が適用できない）。
  --    3-2 が `check_ins` を作った時点で、次の ALTER を追加すること。
  --
  --      ALTER TABLE public.room_assignments
  --        ADD CONSTRAINT fk_room_assignments_check_in
  --        FOREIGN KEY (check_in_id) REFERENCES public.check_ins (checkin_id);
  --
  --    CLAUDE.md §4.5「既存マイグレーションを書き換えない」に反しないよう、
  --    後続が ALTER で足せる形にしてある。
  check_in_id         uuid NOT NULL,

  room_id             uuid NOT NULL REFERENCES public.rooms (room_id),

  -- ★ 割当**時点**の部屋名のコピー（§5.6.8）。
  --   rooms をリネームしても過去の履歴が書き換わらないようにするための列であり、
  --   「伝票明細が注文時点の単価をコピーする」のと同じ原則（§3-8）。
  --   ここを rooms への参照に置き換えてはならない。
  room_name_snapshot  text NOT NULL
                        CONSTRAINT chk_assignments_snapshot_present
                        CHECK (btrim(room_name_snapshot) <> ''),

  started_at          timestamptz NOT NULL DEFAULT now(),

  -- NULL = 現在の割当（v13 §7「現在の割当部屋は 終了日時 IS NULL の行から取得する」）。
  ended_at            timestamptz,

  -- 「初回」と「部屋移動」を区別する（v13 §7）。
  assignment_reason   text NOT NULL DEFAULT '初回'
                        CONSTRAINT chk_assignments_reason
                        CHECK (assignment_reason IN ('初回', '部屋移動')),

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_assignments_ended_after_started
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- ★ 1つのチェックインに「現在有効な割当」は1件だけ（DB物理設計 §1079 の部分一意インデックス）。
--   部屋移動は既存行を終了してから新規行を追加する。これが無いと、
--   終了し忘れた行が残って「今どの部屋に居るか」が二重になる。
CREATE UNIQUE INDEX uq_room_assign_active
  ON public.room_assignments (check_in_id)
  WHERE ended_at IS NULL;

CREATE INDEX ix_room_assign_room ON public.room_assignments (room_id, started_at DESC);

COMMENT ON TABLE public.room_assignments IS
  '部屋割当（v13 §7）。1つのチェックインに複数の履歴を許容し、部屋移動は'
  '既存行を終了して新規行を追加する（物理上書きしない）。'
  'check_ins への外部キーは WBS 3-2 で ALTER により追加する。';


-- =============================================================================
-- ③ RLS：既定は全拒否（§6-7）
-- =============================================================================

ALTER TABLE public.rooms            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_assignments ENABLE ROW LEVEL SECURITY;

-- ── rooms：読みは authenticated 全員、書き込みは staff だけ ──────────
--    DB物理設計 §6-1 #29「残枠表示のため authenticated 全員」。
--    guest も残枠を見るため、ここを staff に絞ってはならない。
CREATE POLICY rooms_select_all ON public.rooms
  FOR SELECT TO authenticated
  USING ( true );

CREATE POLICY rooms_insert_staff ON public.rooms
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY rooms_update_staff ON public.rooms
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。
--   物理削除すると履歴からの参照が切れる（v13 §7）。無効化は status = '利用停止'。

-- ── room_assignments：PII-B（誰がどの部屋に泊まったか）─────────────
--    DB物理設計 §6-1 #11：本人（自分の check_in 経由）＋ staff。
--
--    ⚠️ **本人ポリシーは `3-2` で置く。** 本人判定は `check_ins` を経由して
--       `members` に辿り着く必要があるが、`check_ins` がまだ存在しないため
--       ここでは書けない（2026-09-15 オーナー決定：「check_ins を参照する
--       会員向け2件だけを 3-2 へ送る」）。
--
--       3-2 で次を追加すること:
--         CREATE POLICY ra_select_self ON room_assignments
--           FOR SELECT TO authenticated
--           USING ( EXISTS (SELECT 1 FROM check_ins c
--                           WHERE c.checkin_id = room_assignments.check_in_id
--                             AND c.member_id  = (SELECT public.current_member_id())) );
--
--    それまでは staff 以外 0行。**安全側に倒れている**（見えすぎるのではなく見えない）。
CREATE POLICY ra_select_staff ON public.room_assignments
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY ra_insert_staff ON public.room_assignments
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY ra_update_staff ON public.room_assignments
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- `_insert_self` は作らない。部屋割当の登録・変更は管理者・コアメンバーのみ（v13 §5.2.1）。


-- =============================================================================
-- ④ GRANT（§6-6②）
--
-- ★ 0005 と同じく、**先に既定の広い権限を剥がしてから**必要分だけ与える。
--   剥がさないと、Supabase の既定 GRANT が残って RLS より手前で素通りする。
-- =============================================================================

REVOKE ALL ON public.rooms            FROM anon, authenticated;
REVOKE ALL ON public.room_assignments FROM anon, authenticated;

GRANT SELECT                 ON public.rooms            TO authenticated;
GRANT INSERT, UPDATE         ON public.rooms            TO authenticated;  -- 行は RLS で staff のみ
GRANT SELECT, INSERT, UPDATE ON public.room_assignments TO authenticated;  -- 同上


-- =============================================================================
-- ⑤ 初期8行（Issue #31 の完了条件）
--
--   cottage 3室（各 capacity 2）／earthbag 1室（2）／salon 1室（2）／
--   dormitory 1室（16）／campsite 1区画／car 1区画 ＝ 8行
--
--   ⚠️ 実在の会員データは一切含まない（CLAUDE.md §3.2・§7.1）。部屋は設備であり個人情報ではない。
-- =============================================================================

INSERT INTO public.rooms (room_name, capacity, room_type, status) VALUES
  ('コテージ1',      2,  'cottage',   '利用可'),
  ('コテージ2',      2,  'cottage',   '利用可'),
  ('コテージ3',      2,  'cottage',   '利用可'),
  ('アースバッグ',    2,  'earthbag',  '利用可'),
  ('サロン',         2,  'salon',     '利用可'),
  ('ドミトリー',      16, 'dormitory', '利用可'),
  ('キャンプサイト',  4,  'campsite',  '利用可'),
  ('車中泊スペース',  2,  'car',       '利用可');
