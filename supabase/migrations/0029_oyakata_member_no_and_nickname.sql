-- =============================================================================
-- 0029_oyakata_member_no_and_nickname.sql
--
-- WBS `2-7`（ニックネームの必須化 ＆ 親方会員番号の採番）
--
-- 根拠:
--   - 2026-09-22 オーナー決定（v13 §9 #62 ／ `CONSOLIDATED_DECISIONS.md` §22-4）:
--       ② **`nickname` は必須化する**（本登録時の必須入力。既存370名には次回ログイン時に
--          設定を求め、設定されるまでの間だけ会員番号で表示する）
--       ⑤ **親方会員番号の採番方式は「一意であれば何でもよい」**。桁数・起点・接頭辞は
--          実装側の裁量で、条件は `legacy_member_no`（`10xxx`／`20xxx`）と識別できることだけ
--   - 2026-09-05 オーナー決定: 親方会員番号は街人の会員番号と**番号空間を共有しない**
--   - 2026-09-10 オーナー決定（§16-4）: **両方の番号を持つ会員は常に街人番号で表示する**
--   - `会員データモデル_ユーザーテーブル定義.md` §5.2c（**本名へフォールバックしてはならない**）・§6.2
--   - `DB物理設計.md` §6-4（`v_member_public.display_name`）・§6-6b①（採番系は列単位 GRANT 除外）
--
-- ここで作るもの:
--   ① `members.oyakata_member_no`（親方会員番号の専用列）
--   ② `seq_oyakata_member_no` ＋ `next_oyakata_member_no()`（採番）
--   ③ ニックネームの必須化（CHECK 2本）
--   ④ `v_member_public.display_name` を親方会員番号へ対応させる（差し替え）
--
-- ここで作らないもの:
--   - 親方衆44名への番号投入（WBS `10-1` の移行スクリプト）。本ファイルは器だけを置く
--   - 本登録フォームの必須入力（WBS `12-1`）。アプリ側の判定は
--     `src/lib/members/nickname.ts` に1箇所化し、`/nickname` 画面が呼ぶ
-- =============================================================================


-- =============================================================================
-- ① oyakata_member_no（親方会員番号）
--
-- **なぜ接頭辞ではなく専用列なのか。** 従来案は `legacy_member_no` へ `OYA-` 接頭辞を
-- 付けて番号空間を分ける形だった（`会員データモデル` §6.2）。これは 2026-09-10 決定と両立しない。
--
-- 同決定は「**両方の番号を持つ会員**は街人番号で表示する」と定めており、
-- v13 §9 #26 により親方兼街人は**1レコードに統合されている**。
-- 1つの列に1つの番号しか入らないのだから、接頭辞方式では
-- **その会員の親方会員番号か街人番号のどちらかを捨てるしかない**。
-- 捨てた側は二度と引けず、決定そのものが実装不能になる。
--
-- `DB物理設計.md` §6-6b① の可否表が最初から `oyakata_member_no` を挙げていたのも
-- 同じ構造を前提にしていたためである（列定義だけが存在しなかった）。
--
-- ⚠️ **認可には使わない。** 親方であることは `member_type` と同じく立場であり、
--    権限の根拠は `role` だけである（v13 §2）。この列は表示と突合のためにある。
-- =============================================================================

ALTER TABLE public.members
  ADD COLUMN oyakata_member_no text UNIQUE
    CONSTRAINT chk_members_oyakata_member_no_format
    -- `OYA-` ＋ 3桁ゼロ埋め。オーナー決定は「一意であれば何でもよい」なので、
    -- ここは実装側の裁量である（v13 §9 #62 ⑤）。次の2点で決めた。
    --   * 接頭辞 `OYA-` … 街人番号（`10xxx`／`20xxx`）と**一目で識別できる**という唯一の条件を満たす
    --   * 3桁ゼロ埋め   … 桁を固定しないと文字列順の並べ替えが `OYA-9` > `OYA-10` で逆転する。
    --                      44名に3桁は過剰だが、溢れると採番規則ごと作り直しになる
    CHECK (oyakata_member_no ~ '^OYA-[0-9]{3}$');

COMMENT ON COLUMN public.members.oyakata_member_no IS
  '親方会員番号（OYA-NNN）。街人の legacy_member_no とは番号空間を共有しない'
  '（2026-09-05 オーナー決定）。親方兼街人は両方を持ち、他者向け表示は街人番号を使う'
  '（2026-09-10 オーナー決定）。認可には使わない（v13 §2）';


-- =============================================================================
-- ② 採番（`seq_oyakata_member_no` ＋ `next_oyakata_member_no()`）
--
-- **起点を 45 にする理由。** 親方衆リストの `No.`（1〜44）はそのまま
-- 親方会員番号として移行される（`会員データモデル` §6.2）。連番の払い出しがそこへ踏み込むと、
-- 移行前に採番した番号と移行データが衝突する。1〜44 は移行の予約枠である。
--
-- **なぜ max+1 ではなくシーケンスか。** `SELECT max(...)+1` は同時実行で同じ番号を
-- 2人へ渡す。番号は UNIQUE なので後から入れた側が落ちるだけだが、
-- 落ちるのが「登録の最後の一手」になるため、利用者には理由の分からない失敗に見える。
-- シーケンスは採番の時点で一意が決まる。
-- =============================================================================

CREATE SEQUENCE public.seq_oyakata_member_no START WITH 45;

COMMENT ON SEQUENCE public.seq_oyakata_member_no IS
  '親方会員番号の払い出し。1〜44 は親方衆44名の移行（会員データモデル §6.2）で使うため空けてある';

CREATE OR REPLACE FUNCTION public.next_oyakata_member_no()
RETURNS text
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT 'OYA-' || lpad(nextval('public.seq_oyakata_member_no')::text, 3, '0');
$$;

-- 採番は取込・登録処理（service_role）だけが行う（`DB物理設計.md` §6-6b①）。
-- 会員本人から呼べると、番号を空回しして採番の連続性を壊せる。
REVOKE EXECUTE ON FUNCTION public.next_oyakata_member_no() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.next_oyakata_member_no() FROM anon;
REVOKE EXECUTE ON FUNCTION public.next_oyakata_member_no() FROM authenticated;

REVOKE ALL ON SEQUENCE public.seq_oyakata_member_no FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.seq_oyakata_member_no FROM anon;
REVOKE ALL ON SEQUENCE public.seq_oyakata_member_no FROM authenticated;


-- =============================================================================
-- ③ ニックネームの必須化
--
-- 必須化は2段に分ける。**NOT NULL は置けない。**
-- 移行370名は `nickname` 未設定で入り（`会員データモデル` §6.2「`NULL` のまま投入する」）、
-- §5.2c が「**本名を初期値として入れてはならない**」と定めているため、埋める値が無い。
-- オーナー決定も「既存370名には**次回ログイン時に設定を求め**、
-- 設定されるまでの間だけ会員番号で表示する」であり、**未設定の状態を許している**。
--
-- したがって DB で必須にできる（すべきな）のは「**アプリから作る会員**」だけである。
--
--   CHECK 1（空白の禁止）: 全行に効く。`'   '` を「設定済み」と誤認すると
--     `v_member_public` の `NULLIF(btrim(...))` を通り抜けた空文字が画面に並ぶ。
--   CHECK 2（本登録では必須）: `imported_from IS NULL` ＝ 取込由来でない行、
--     すなわちアプリから作られた会員に `nickname` を要求する。
--     移行行は `imported_from` が入る（`会員データモデル` §6.1）ため対象外になる。
--
-- ⚠️ CHECK 2 はアプリ側の入力検査（`src/lib/members/nickname.ts`）と対で維持すること。
--    DB 側だけが残るとエラーが SQLSTATE 23514 になり、利用者に意味が伝わらない。
-- =============================================================================

ALTER TABLE public.members
  ADD CONSTRAINT chk_members_nickname_not_blank
  CHECK (nickname IS NULL OR btrim(nickname) <> '');

ALTER TABLE public.members
  ADD CONSTRAINT chk_members_nickname_required_when_app_registered
  CHECK (imported_from IS NOT NULL OR nickname IS NOT NULL);

COMMENT ON COLUMN public.members.nickname IS
  '他者向け表示名。未設定時に full_name へフォールバックしてはならない（会員データモデル §5.2c）。'
  '取込由来でない会員（imported_from IS NULL ＝ アプリからの登録）では必須（WBS 2-7 ／ v13 §9 #62）。'
  '移行370名は未設定のまま入り、次回ログイン時に /nickname で設定を求める';


-- =============================================================================
-- ④ v_member_public.display_name を親方会員番号へ対応させる
--
-- 0009 は「街人番号 → `member_id` 先頭8文字」の2段落ちで、`legacy_member_no` を
-- 持たない純粋な親方衆44名は**意味の無い UUID 断片**で表示されていた
-- （0009 のヘッダが「論点⑤が決まった時点で第2段の値が埋まる」と予告していた箇所）。
--
-- **フォールバックの順序が決定そのものである。**
--   1. `nickname`
--   2. **街人番号**（`legacy_member_no`）      ← 両方を持つ会員はここで止まる（2026-09-10 決定）
--   3. **親方会員番号**（`oyakata_member_no`）  ← 街人番号を持たない純粋な親方（2026-09-05 決定）
--   4. `member_id` の先頭8文字                 ← どちらの番号も未採番の会員（ゲスト等）
--
-- 2 と 3 を入れ替えると「親方優先」になり、2026-09-10 に**不採用と決まった挙動**へ戻る。
-- 氏名は今回も候補に入らない（§5.2c の不可侵ルール）。
-- =============================================================================

CREATE OR REPLACE VIEW public.v_member_public
WITH (security_invoker = false)   -- ビュー所有者権限で実行＝members の RLS を意図的に迂回する
AS
SELECT
  m.member_id,

  COALESCE(
    NULLIF(btrim(m.nickname), ''),
    (CASE WHEN m.member_type = 'ゲスト' THEN 'ゲスト#' ELSE '街人#' END) || m.legacy_member_no,
    '親方#' || m.oyakata_member_no,
    (CASE WHEN m.member_type = 'ゲスト' THEN 'ゲスト#' ELSE '街人#' END) || left(m.member_id::text, 8)
  ) AS display_name,

  m.member_type   -- 画面上のバッジ表示用。認可には使わない（v13 §2）
FROM public.members m
WHERE m.account_status <> 'withdrawn';

COMMENT ON VIEW public.v_member_public IS
  '他者向けに露出してよい会員情報はこの3列のみ。氏名・住所・連絡先・残高・XP を絶対に追加しない。'
  'display_name のフォールバックは nickname → 街人番号 → 親方会員番号 → member_id 先頭8文字。'
  '街人番号が親方会員番号より先に来る順序が 2026-09-10 決定（親方兼街人は街人番号）そのものである。';
