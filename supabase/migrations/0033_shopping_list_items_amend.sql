-- =====================================================================
-- 0033_shopping_list_items_amend.sql
--
-- WBS: 5-8（買い物リストの登録・一覧・ステータス管理）
--
-- 根拠: 正本 v13 §5.12.1（必須は品名のみ・編集／取下げは登録者本人と運営）
--       §5.12.2（5つのステータス・見送りは理由必須）／ §7（列の一覧）
--
-- なぜ 0030 を書き換えずにここへ足すのか:
--   `0030_shopping_list_items.sql` は既に main へ入り、適用済みの DB が存在する。
--   適用済みのマイグレーションを書き換えても**既存の DB には何も起きない**ため、
--   CREATE TABLE 側の列名を直しただけでは `/shopping` の全クエリが 42703
--   （undefined_column）で落ちる。既存マイグレーションは書き換えない（CLAUDE.md §4.5）。
--
-- ここで直すのは、0030 を実装へ載せて初めて分かった4点である。
--   ① 入手先候補を1列の自由記述から「店名」「URL」の2列へ分ける（§7）
--   ② 登録者に既定値を与える（§5.12.1「必須は品名のみ」）
--   ③ 見送りの必須項目を**理由だけ**に戻す／購入日時の必須をやめる（§5.12.2）
--   ④ 取下げ済みの行を登録者本人にも見せる（§5.12.1 の取下げが 42501 で落ちていた）
-- =====================================================================

-- ===== ① 入手先候補を店名と URL に分ける（v13 §7「入手先候補（店名・URL）」）=====
--
-- 1列の自由記述（`source_hint`）では、後から「買える店の一覧」を引けない
-- （買い出しの経路を組めない）。DROP ではなく RENAME で移すため、
-- 既に入っている入手先の記述は店名として残る。

ALTER TABLE public.shopping_list_items RENAME COLUMN source_hint TO shop_name;
ALTER TABLE public.shopping_list_items ADD COLUMN IF NOT EXISTS shop_url text;

COMMENT ON COLUMN public.shopping_list_items.shop_name IS
  '入手先候補の店名（v13 §7）。0030 の source_hint を改称した列。';
COMMENT ON COLUMN public.shopping_list_items.shop_url IS
  '入手先候補のURL（v13 §7）。http / https のみ受け付ける検証はアプリ層（src/lib/shopping/shop-url.ts）。';

-- ===== ② 登録者はセッションから決まる（v13 §5.12.1 の入力項目表）=====
--
-- 登録者は利用者が入力する項目ではない。既定値を持たせて
-- 「INSERT に書かないと通らない列」を品名だけに保つ。

ALTER TABLE public.shopping_list_items
  ALTER COLUMN registered_by SET DEFAULT public.current_member_id();

-- ===== ③ DDL で必須にする項目を §5.12.2 の字面まで戻す =====
--
-- ⚠️ 見送りで必須なのは**理由**だけである。判断者（decided_by）を CHECK に足すと、
--    「誰が」を補えない経路（移行・手動補正）で見送りを記録できなくなり、
--    仕様が求めていない必須項目を DDL が増やす（§5.12.1 の「必須は品名のみ」と同じ考え方）。
--    実運用で decided_by を入れるのはアプリ層（src/app/shopping/actions.ts）。

ALTER TABLE public.shopping_list_items DROP CONSTRAINT ck_shopping_item_skip_reason;
ALTER TABLE public.shopping_list_items ADD CONSTRAINT ck_shopping_item_skip_reason CHECK (
  status <> '見送り' OR btrim(coalesce(skip_reason, '')) <> ''
);

-- ⚠️ 「購入済なら purchased_at が要る」という CHECK は**置かない**。
--    §5.12.2 の状態表は 5 値の意味を定めるだけで、購入日時を必須にしていない。
--    縛ると「クエストを立てずに誰かが買ってきた」分の手動 `購入済`（§5.12.3）が、
--    日時を補えない経路から入らなくなる。購入日時・購入者はアプリ層が入れる
--    （0017 の「写真必須はアプリ層で担保する」と同じ分担）。
ALTER TABLE public.shopping_list_items DROP CONSTRAINT ck_shopping_item_purchased_has_time;

-- ===== ④ 取下げ済みの行を登録者本人にも見せる =====
--
-- ⚠️ 登録者を外してはならない。UPDATE では**更新後の行**も SELECT ポリシーに掛かるため、
--    本人が見られない状態（withdrawn_at IS NOT NULL）へは本人が更新できなくなる。
--    0030 が運営だけに絞っていたため、§5.12.1「登録者本人が取り下げられる」が
--    42501 で落ちていた。閲覧できる相手が増えるのは**自分が登録した行**に限られ、
--    他人の取下げ済みの行は引き続き運営にしか見えない。

DROP POLICY shopping_list_items_select_all ON public.shopping_list_items;

CREATE POLICY shopping_list_items_select_all ON public.shopping_list_items
  FOR SELECT TO authenticated
  USING (
    withdrawn_at IS NULL
    OR (SELECT public.is_staff())
    OR registered_by = (SELECT public.current_member_id())
  );
