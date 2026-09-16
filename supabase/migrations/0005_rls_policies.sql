-- =============================================================================
-- WBS 2-2：Supabase RLS ポリシー設計
--
-- 根拠: DB物理設計.md §6-2②③・§6-6・§6-6b⑥・§6-7・§6-9、
--       v13 §5.9.3（サーバサイド認可は必須・二重防御）、
--       2026-09-05 決定「前線2：anon 権限を原則ゼロ」、
--       Issue #35 の 2026-09-15 オーナー決定（範囲＝A ／ mrc は is_admin() で絞る）
--
-- 対象は **DDL が実在する4テーブル**に限る。
--   members / member_profiles_private / member_role_changes（0001）
--   member_invitations（0004。2-1b から「ポリシー本体は 2-2 へ」と送られたもの）
--
-- DB物理設計 §6-1 は35件を挙げるが、まだ作られていないテーブルへ
-- ポリシーは書けない。残りは各テーブルを作る作業パッケージで置く。
-- =============================================================================


-- =============================================================================
-- ⓪ 前提：RLS と GRANT は**別の関門**であり、両方が要る（§6-6）
--
--   PostgREST 経由のアクセスは ①ロールへの GRANT → ②RLS ポリシー の順に通る。
--   GRANT が無ければポリシーを書いても届かず、
--   ポリシーが無ければ GRANT があっても0行になる。
--
--   Supabase は**新規テーブルへ既定で anon/authenticated に広い権限を与える**。
--   明示的に絞らないと「新テーブルを作ったら全開だった」が起きる。
-- =============================================================================


-- =============================================================================
-- ① anon：アプリケーションテーブルへは一切触らせない（§6-6① ／ 前線2）
--
-- 公開予約ページは Edge Function 経由で処理する設計（§6-2⑧）なので、
-- anon が public スキーマのテーブルへ直接触れる必要はまったく無い。
-- =============================================================================

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM anon;

-- ★ 今後追加されるテーブルにも自動で適用する。
--   これが無いと、次にテーブルを作った人が明示的に REVOKE を書き忘れた瞬間、
--   そのテーブルが anon へ開く。**規約ではなく既定値で守る。**
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES  FROM anon;


-- =============================================================================
-- ② members のポリシー（§6-2②）
-- =============================================================================

-- SELECT：本人は自分の行。staff は全行。
CREATE POLICY members_select_self ON public.members
  FOR SELECT TO authenticated
  USING ( auth_user_id = (SELECT auth.uid()) );

CREATE POLICY members_select_staff ON public.members
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- UPDATE：本人は自分の行のみ。
--   WITH CHECK で「更新**後**も自分の行であること」を強制する。
--   これが無いと、auth_user_id を他人の値へ書き換えて行を手放す（＝乗っ取らせる）ことができる。
CREATE POLICY members_update_self ON public.members
  FOR UPDATE TO authenticated
  USING       ( auth_user_id = (SELECT auth.uid()) )
  WITH CHECK  ( auth_user_id = (SELECT auth.uid()) );

CREATE POLICY members_update_staff ON public.members
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- INSERT / DELETE：ポリシーを1本も作らない ＝ 全拒否。
--   会員行の生成はリスト取込と名寄せ成立時の結合だけで、いずれも service_role の
--   サーバサイド処理である。クライアントから会員を作れてはならない。
--   物理削除は §1-3 で原則禁止。退会は account_status = 'withdrawn' の論理削除。


-- =============================================================================
-- ③ member_profiles_private（PII-A）のポリシー（§6-2③）
-- =============================================================================

CREATE POLICY mpp_select_self ON public.member_profiles_private
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY mpp_select_staff ON public.member_profiles_private
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY mpp_insert_self ON public.member_profiles_private
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY mpp_insert_staff ON public.member_profiles_private
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY mpp_update_self ON public.member_profiles_private
  FOR UPDATE TO authenticated
  USING       ( member_id = (SELECT public.current_member_id()) )
  WITH CHECK  ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY mpp_update_staff ON public.member_profiles_private
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。
--   退会30日後の匿名化は「行を消す」のではなく「値をダミーへ UPDATE する」で行う。


-- =============================================================================
-- ④ member_role_changes（権限変更履歴）のポリシー（§6-6b⑥）
--
-- SELECT は **admin だけ**（2026-09-15 オーナー決定）。
-- core_member にも本人にも開かない。「誰が誰の権限を変えたか」は
-- 運営内部の人事的な判断であり、member_notes と同じ扱いにする。
-- =============================================================================

CREATE POLICY mrc_select_admin ON public.member_role_changes
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_admin()) );

-- INSERT / UPDATE / DELETE：ポリシーを1本も作らない ＝ 全拒否。
--   書き込みは SECURITY DEFINER のトリガー（0003 の members_log_role_change）だけが行う。
--   所有者権限で走るため RLS を通らない。


-- =============================================================================
-- ⑤ member_invitations（招待台帳 ／ 0004 から送られたもの）
--
-- 2-1b は ENABLE ROW LEVEL SECURITY までを行い、ポリシー本体をここへ送った。
--
-- **SELECT は staff のみ。** 監査記録は「誰が誰をどのアドレスで招待したか」であり、
-- 招待された本人に見せる必要が無い一方、宛先アドレスは PII である。
-- 書き込みは service_role のサーバサイド処理だけ（アプリ側で is_staff を判定済み）。
-- =============================================================================

CREATE POLICY invitations_select_staff ON public.member_invitations
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- INSERT / UPDATE / DELETE：ポリシーを作らない ＝ 全拒否。
--   送信と消費記録は src/lib/auth/{invitations,binding}.ts が service_role で行う。


-- =============================================================================
-- ⑥ GRANT：SELECT はテーブル単位、**書き込みは列単位**（§6-6②）
--
-- > [!danger] members の UPDATE は RLS だけでは守れない
-- > members_update_self は「自分の行だけ更新できる」ことしか保証しない。
-- > **自分の行の role を 'admin' に書き換える**のは RLS 的には完全に正当な操作である。
-- > 防ぐのは RLS ではなく**列単位の権限**であり、下の GRANT UPDATE (...) が本体。
-- > ここを GRANT UPDATE ON members（全列）にした瞬間、
-- > **全会員が自力で管理者に昇格できる。**
--
-- 0003 のガードトリガーと合わせて二重になっているが、これは冗長ではない。
-- トリガーは「誰が操作したか」を見る関門、列単位 GRANT は「その列に触れるか」の関門であり、
-- 守っている次元が違う。
-- =============================================================================

-- ★★ まず authenticated から**既定の広い権限を剥がす**。これが抜けると以下が起きる。
--
--   Supabase は新規テーブルへ既定で anon **と authenticated** に広い権限を与える（§6-6 冒頭）。
--   剥がさずに列単位 GRANT を足しても、**既定のテーブル全体 UPDATE が残ったまま**なので
--   列の限定がまったく効かない。つまり **一般会員が自分の role を admin へ書き換えられる**。
--
--   2026-09-16、この REVOKE を書き忘れた版が実際に DB テストで捕まった
--   （「★ 一般会員は自分を admin へ昇格できない」が Received: null ＝ UPDATE 成功）。
--   §6-2② の danger は「GRANT UPDATE を全列にするな」と書いているが、
--   **既定の GRANT を剥がさなければ列指定そのものが無意味**という一段手前の話がある。
--
--   対象を4テーブルに限定するのは、0100（RAG の pgvector）へ巻き込みたくないため。
REVOKE ALL ON public.members                 FROM authenticated;
REVOKE ALL ON public.member_profiles_private FROM authenticated;
REVOKE ALL ON public.member_role_changes     FROM authenticated;
REVOKE ALL ON public.member_invitations      FROM authenticated;

GRANT SELECT ON public.members                 TO authenticated;
GRANT SELECT ON public.member_profiles_private TO authenticated;
GRANT SELECT ON public.member_role_changes     TO authenticated;  -- 行は RLS で admin 以外0件
GRANT SELECT ON public.member_invitations      TO authenticated;  -- 行は RLS で staff 以外0件

-- ★ 本人が変えてよい列だけを列挙する。ここに列を足すときは必ず理由を書くこと。
--   role / account_status / auth_user_id / stay_tickets / total_stay_days /
--   uii_balance / earned_xp / legacy_member_no / invite_code は**意図的に含めない**。
--   集計キャッシュ3列を外すのは §1-1「アプリから直接 UPDATE してはならない」の担保でもある
--   （規約ではなく DB 権限として強制する）。トリガーは所有者権限で走るため影響を受けない。
GRANT UPDATE (nickname, skills, certifications, line_joined, discord_joined)
  ON public.members TO authenticated;

GRANT INSERT, UPDATE (full_name, full_name_kana, address, hometown, birth_ym)
  ON public.member_profiles_private TO authenticated;
