-- =====================================================================
-- 0028_shopping_list_items.sql
--
-- WBS: 5-8（買い物リストの登録・一覧・ステータス管理）
--      5-9（買い物リストからの買い出しクエスト化）
--
-- 根拠: 正本 v13 §5.12（買い物リスト ＆ 買い出しクエスト化）
--       §5.12.1 登録 ／ §5.12.2 ステータス ／ §5.12.3 クエスト化 ／ §5.12.4 立替実費
--       §6 権限マトリクス（買い物リスト8行） ／ §9 #65（2026-09-22 決着）
--
-- スコープ（含む）:
--   ① public.shopping_list_items の DDL
--   ② quests.origin_type への 'shopping_list' 追加（CHECK の張り直し）
--   ③ 相乗り（「自分も欲しい」）の RPC
--   ④ ロール判定が要る禁止事項のガードトリガー
--   ⑤ RLS ／ GRANT
--
-- スコープ（含まない）:
--   ・立替実費（`advance_*`）— **アプリで扱わないことが決まっている**（§5.12.4／2026-09-22 確定）。
--     証憑が要る場合はクエスト完了報告（§5.3 の After 写真）にレシートを添付する。
--     ここに金額の器を足すと、§5.6.6 と同じ厳密さ（発生・残置・消込・滞留アラート）が
--     必要になる。**「軽く作る」選択肢は無い。**
--   ・予算管理・定期購入・在庫連動・外部EC振り分け（すべて Phase 2／§5.12.5）
--   ・状態遷移の業務ルール（`希望 → 買う → …` の順序）。
--     これはアプリ層（`src/lib/shopping/status.ts`）の純関数が持つ。
--     DB が持つのは「**誰が**変えてよいか」だけである（0017 と同じ分担）。
--
-- 動かしてはならない点:
--   ・`item_name` 以外を必須にしない。§5.12.1 が「必須は品名のみ」と定めている。
--     入力必須を増やすと「気づいた瞬間に30秒で登録」が成立せず、結局 LINE に書かれて終わる。
--   ・`reference_price_jpy` は**買い出しの目安**であって精算額ではない。
--     未会計（`orders`）や `settlement_adjustments` へ計上してはならない（§5.12.4）。
--   ・`quest_id` は品目側に持つ（多対1）。中間テーブルを作らない。
--     品目から見てクエストは必ず1件以下であり、**買い出し1回＝1クエスト**だからである（§5.12.3）。
-- =====================================================================

-- ===== ① 買い物リスト（ほしいものリスト）=====

CREATE TABLE public.shopping_list_items (
  item_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 品名だけが必須。NOT NULL だけでは空白文字で抜けられるため btrim で締める。
  item_name            text NOT NULL
                         CONSTRAINT chk_shopping_item_name_present
                         CHECK (btrim(coalesce(item_name, '')) <> ''),

  quantity             numeric
                         CONSTRAINT chk_shopping_item_quantity_positive
                         CHECK (quantity IS NULL OR quantity > 0),
  unit                 text,
  wanted_by            date,
  purpose              text,
  source_hint          text,

  -- 参考価格。**精算には使わない**（§5.12.4）。COMMENT も参照。
  reference_price_jpy  integer
                         CONSTRAINT chk_shopping_item_reference_price_non_negative
                         CHECK (reference_price_jpy IS NULL OR reference_price_jpy >= 0),

  priority             text NOT NULL DEFAULT '通常'
                         CONSTRAINT chk_shopping_item_priority
                         CHECK (priority IN ('至急', '通常', 'いつでも')),

  -- 写真（任意）。media_assets への FK は、当該テーブルの投入後に後付けする
  -- （work_logs.before_photo_media_id と同じ扱い／0017）。
  photo_media_id       uuid,

  status               text NOT NULL DEFAULT '希望'
                         CONSTRAINT chk_shopping_item_status
                         CHECK (status IN ('希望', '買う', 'クエスト化済', '購入済', '見送り')),

  registered_by        uuid NOT NULL REFERENCES public.members (member_id),

  -- 相乗り（「自分も欲しい」）。members への FK は配列のため張れない
  -- （quests.required_certification と同じ割り切り）。更新は ③ の RPC 経由のみ。
  requesters           uuid[] NOT NULL DEFAULT '{}'::uuid[],

  decided_by           uuid REFERENCES public.members (member_id),
  decided_at           timestamptz,
  skip_reason          text,

  -- 多対1。クエストが消えても品目は残す（買う必要が消えたわけではない）。
  quest_id             uuid REFERENCES public.quests (quest_id) ON DELETE SET NULL,

  purchased_at         timestamptz,
  purchased_by         uuid REFERENCES public.members (member_id),

  -- 取下げは論理削除（§5.12.1）。物理削除しない。
  withdrawn_at         timestamptz,
  withdraw_reason      text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- 見送りは理由と判断者を必ず残す（§5.12.2）。
  -- 却下の履歴が無いと、同じ品目が翌週また登録される。
  CONSTRAINT ck_shopping_item_skip_reason CHECK (
    status <> '見送り'
    OR (btrim(coalesce(skip_reason, '')) <> '' AND decided_by IS NOT NULL)
  ),

  -- クエスト化済なら必ず紐づくクエストがある。
  CONSTRAINT ck_shopping_item_quested_has_quest CHECK (
    status <> 'クエスト化済' OR quest_id IS NOT NULL
  ),

  CONSTRAINT ck_shopping_item_purchased_has_time CHECK (
    status <> '購入済' OR purchased_at IS NOT NULL
  ),

  CONSTRAINT ck_shopping_item_withdraw_reason CHECK (
    withdrawn_at IS NULL OR btrim(coalesce(withdraw_reason, '')) <> ''
  )
);

COMMENT ON TABLE public.shopping_list_items IS
  '買い物リスト（ほしいものリスト）。v13 §5.12。立替実費は扱わない（§5.12.4）ため advance_* 相当の列を足してはならない。';
COMMENT ON COLUMN public.shopping_list_items.item_name IS
  '品名。§5.12.1 の唯一の必須項目。他の項目を必須にしないこと。';
COMMENT ON COLUMN public.shopping_list_items.reference_price_jpy IS
  '参考価格（円）。買い出しの目安であり精算額ではない。orders / settlement_adjustments へ計上してはならない（v13 §5.12.4）。';
COMMENT ON COLUMN public.shopping_list_items.requesters IS
  '相乗り（「自分も欲しい」）の会員ID。直接 UPDATE せず shopping_item_add_requester() を使う。';
COMMENT ON COLUMN public.shopping_list_items.status IS
  '希望 → 買う（運営承認）→ クエスト化済 → 購入済 ／ 見送り。遷移順序の判定はアプリ層（src/lib/shopping/status.ts）。DB は「誰が変えてよいか」だけを守る。';
COMMENT ON COLUMN public.shopping_list_items.quest_id IS
  '買い出しクエスト（quests.origin_type = ''shopping_list''）。複数品目が1件のクエストに紐づく多対1。中間テーブルを作らない（v13 §5.12.3）。';
COMMENT ON COLUMN public.shopping_list_items.photo_media_id IS
  'media_assets への FK は当該テーブル投入後に後付けする（work_logs と同じ扱い）。';

-- 運営が毎日見る待ち行列（未処理かつ取下げでないもの）を部分索引で引く。
CREATE INDEX ix_shopping_item_open ON public.shopping_list_items (priority, created_at)
  WHERE status IN ('希望', '買う') AND withdrawn_at IS NULL;

CREATE INDEX ix_shopping_item_quest ON public.shopping_list_items (quest_id)
  WHERE quest_id IS NOT NULL;

CREATE INDEX ix_shopping_item_registered_by ON public.shopping_list_items (registered_by);

-- ===== ② quests.origin_type に 'shopping_list' を追加 =====
--
-- ⚠️ 既存マイグレーション（0007）は書き換えず、ここで張り直す（CLAUDE.md §4.5）。
--    正本 v13 §7 が v1.30.0 時点で `source_type` と書いていたのは誤りで、
--    実装済みの列は `origin_type` である（v1.31.0 で是正済み）。

ALTER TABLE public.quests DROP CONSTRAINT chk_quests_origin_type;
ALTER TABLE public.quests ADD CONSTRAINT chk_quests_origin_type
  CHECK (origin_type IN ('manual', 'morning_meeting_auto', 'shopping_list'));

COMMENT ON COLUMN public.quests.origin_type IS
  '起案元区分。manual＝手動起案 / morning_meeting_auto＝朝会自動抽出 / shopping_list＝買い物リスト起点（v13 §5.12.3）。';

-- ===== ③ 相乗り（「自分も欲しい」）=====
--
-- なぜ RPC にするのか: 相乗りは**他人が登録した行**への更新である。
-- RLS は列単位で許可を出せないため、UPDATE を開けると品名・価格まで書き換えられる。
-- 触れてよいのが requesters だけである以上、入口を関数1本に絞るのが唯一の方法になる。

CREATE OR REPLACE FUNCTION public.shopping_item_add_requester(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role      text := public.current_actor_role();
  v_member_id uuid := public.current_member_id();
BEGIN
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION '会員として結合されていないため相乗りできません' USING ERRCODE = '42501';
  END IF;

  -- ゲストは登録も相乗りもできない（v13 §5.12.1・§6 ／ 2026-09-22 確定）。
  IF v_role = 'guest' THEN
    RAISE EXCEPTION 'ゲストは買い物リストへ登録できません（v13 §5.12.1）' USING ERRCODE = '42501';
  END IF;

  -- 既に入っているなら足さない。配列の重複を作らない側で倒す
  -- （DISTINCT を取る書き方より、意図がそのまま読める）。
  UPDATE public.shopping_list_items
     SET requesters = CASE
                        WHEN v_member_id = ANY (requesters) THEN requesters
                        ELSE requesters || v_member_id
                      END,
         updated_at = now()
   WHERE item_id = p_item_id
     AND withdrawn_at IS NULL
     -- 買われた後・見送った後に希望者だけ増えても意味がない。
     AND status IN ('希望', '買う');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.shopping_item_add_requester(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.shopping_item_add_requester(uuid) TO authenticated;

-- ===== ④ ガードトリガー（ロール判定が要る禁止事項）=====
--
-- RLS ではなくトリガーで守る理由（0017 §の danger と同じ）:
--   ① service_role は RLS も GRANT も迂回する
--   ② core_member と admin は同じ authenticated ロールであり、GRANT では区別できない
--   → 「呼び出した人の role」が判定に要るなら、トリガーが唯一の場所になる。

CREATE OR REPLACE FUNCTION public.shopping_list_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text := public.current_actor_role();
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- ゲストは閲覧のみ（v13 §5.12.1・§6 ／ 2026-09-22 オーナー確定）。
    IF v_role = 'guest' THEN
      RAISE EXCEPTION 'ゲストは買い物リストへ登録できません（v13 §5.12.1）' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- 「買う／見送り」の判断は運営だけが行う（v13 §5.12.2・§6）。
  -- 登録者本人は内容を直せるが、自分の希望を自分で承認することはできない。
  IF NEW.status IS DISTINCT FROM OLD.status AND v_role NOT IN ('admin', 'core_member') THEN
    RAISE EXCEPTION '買い物リストの状態を変えられるのは運営のみです（v13 §5.12.2）' USING ERRCODE = '42501';
  END IF;

  -- 登録者は後から書き換えられない（誰が言い出したかの記録であるため）。
  IF NEW.registered_by IS DISTINCT FROM OLD.registered_by THEN
    RAISE EXCEPTION '登録者は変更できません（v13 §5.12.1）' USING ERRCODE = '42501';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.shopping_list_items_guard() FROM PUBLIC, anon;

CREATE TRIGGER trg_shopping_list_items_guard
  BEFORE INSERT OR UPDATE ON public.shopping_list_items
  FOR EACH ROW EXECUTE FUNCTION public.shopping_list_items_guard();

-- ===== ⑤ RLS ／ GRANT =====

ALTER TABLE public.shopping_list_items ENABLE ROW LEVEL SECURITY;

-- 閲覧は全ロール（ゲスト含む）。取下げ済みだけは運営にしか見せない。
CREATE POLICY shopping_list_items_select_all ON public.shopping_list_items
  FOR SELECT TO authenticated
  USING ( withdrawn_at IS NULL OR (SELECT public.is_staff()) );

-- 登録は本人名義でのみ。ゲスト除外は④のトリガーが service_role 経由も含めて担保する。
CREATE POLICY shopping_list_items_insert_self ON public.shopping_list_items
  FOR INSERT TO authenticated
  WITH CHECK ( registered_by = (SELECT public.current_member_id()) );

-- 本人は自分が登録した品目を直せる（取下げを含む）。状態遷移は④が止める。
CREATE POLICY shopping_list_items_update_self ON public.shopping_list_items
  FOR UPDATE TO authenticated
  USING       ( registered_by = (SELECT public.current_member_id()) )
  WITH CHECK  ( registered_by = (SELECT public.current_member_id()) );

CREATE POLICY shopping_list_items_update_staff ON public.shopping_list_items
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。取下げは withdrawn_at（論理削除）。

REVOKE ALL ON public.shopping_list_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.shopping_list_items TO authenticated;

-- ===== ⑥ 作らなかったもの（意図的な不在）=====
--
--   ・advance_payer_id / advance_amount_jpy / receipt_media_id / advance_settled*
--       → 立替実費はアプリで扱わない（v13 §5.12.4 ／ 2026-09-22 オーナー確定）
--   ・shopping_list_item_quests（中間テーブル）
--       → 品目から見てクエストは必ず1件以下。quest_id 1本で足りる（§5.12.3）
--   ・状態遷移を強制するトリガー
--       → 遷移順序はアプリ層の純関数が持つ。DB は「誰が」だけを守る（0017 と同じ分担）
--   ・DELETE ポリシー
--       → 論理削除のみ（withdrawn_at）
