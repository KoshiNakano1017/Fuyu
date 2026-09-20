-- =============================================================================
-- 0101_revoke_service_role_excess_privileges.sql
--
-- ① vector 拡張を public から extensions スキーマへ移す
-- ② service_role から DELETE / TRUNCATE / REFERENCES / TRIGGER を剥がす
--
-- ⚠️ 採番が 0101 なのは「0100 より後でなければならない」ためである。
--    本ファイルは public.knowledge_chunks（0100 が作る表）を REVOKE 対象に含むので、
--    0013 等の若い番号を付けると新規DBへの適用時に 0100 より先に走り、
--    「relation does not exist」で落ちる（改番前に実際に検出した）。
--
-- 根拠: DB物理設計.md §1「物理削除の原則禁止」、§6-6（列単位 GRANT・デフォルト拒否）、
--       CLAUDE.md §4.5（既存マイグレーションを書き換えない）。
--
-- ── なぜ必要か（2026-09-20 に dev へ初回適用して判明） ──────────────────
-- 0001〜0100 を dev Supabase へ適用した直後に権限を実測したところ、
-- **public スキーマの全テーブル・全ビューで service_role が ALL を持っていた**。
--
--   public.knowledge_chunks → DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--
-- 0100:404-410 は `GRANT SELECT, INSERT, UPDATE ... TO service_role` と書き、
-- さらに「DELETE は与えない。投影の失効は source_deleted フラグで表す」と明記している。
-- ところが Supabase は **public スキーマの新規テーブルへ service_role に既定で ALL を与える**ため、
-- 既に ALL がある上への GRANT は何も絞らず、設計意図が DB 上で1ミリも効いていなかった。
--
-- 0100 は anon / authenticated については既定権限を意識して明示 REVOKE していた
-- （同ファイル §7 の ⚠️ コメント）。見落とされていたのは service_role だけである。
--
-- 裏付け: 同じ 0100 が作った `rag` スキーマ側は **INSERT,SELECT,UPDATE のみ**で正しかった。
--   rag は 0100 が新規作成したスキーマであり、Supabase の既定権限（public 限定）が
--   適用されなかったためである。つまり不具合の原因は 0100 の書き方ではなく、
--   「public スキーマには既定 ALL が効く」ことへの対処漏れである。
--
-- ── 対象範囲（2026-09-20 オーナー確定：プロジェクト全体に適用） ──────────
-- 0100 の2表だけでなく public の全テーブル・全ビューを対象にする。
-- §1「物理削除の原則禁止」はテーブル単位の約束ではなくプロジェクト全体の原則であり、
-- knowledge_chunks だけ守っても members が TRUNCATE できるなら意味がないため。
--
-- ⚠️ authenticated の権限には一切触れない。
--    0008:118-120 は work_categories / quests へ **意図的に** DELETE を与えている
--    （行の可否は RLS で admin / staff に絞る設計）。ここを巻き込むと機能が壊れる。
--
-- ⚠️ 安全確認: アプリコードに service_role 経由の削除は存在しない。
--    admin クライアント（src/lib/supabase/admin.ts）の利用箇所は
--    src/lib/auth/binding.ts:101 の `bind_member_auth_user` RPC 1件のみである。
-- =============================================================================


-- =============================================================================
-- 1. vector 拡張を extensions スキーマへ移す
--
-- 0100:29 は `CREATE EXTENSION IF NOT EXISTS vector;` とだけ書いており、
-- スキーマを指定していない。結果 public に作られ、Supabase の DB Advisor が
-- `extension_in_public` として警告する状態になっていた。
--
-- 0100 自体は tests/migrations-baseline.test.ts が 424 行・SQL 文リスト完全一致で
-- 不改変を固定しているため書き換えられない。後続の連番で是正する（CLAUDE.md §4.5）。
--
-- 依存する列があっても移動できることは事前に BEGIN〜ROLLBACK で確認済み。
-- 移動後も public.knowledge_chunks.embedding は vector(768) のまま解決される
-- （Supabase の search_path に extensions が含まれるため）。
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'vector' AND n.nspname = 'public'
  ) THEN
    EXECUTE 'ALTER EXTENSION vector SET SCHEMA extensions';
  END IF;
END $$;


-- =============================================================================
-- 2. service_role から余剰権限を剥がす（テーブル）
--
-- 残すのは SELECT / INSERT / UPDATE の3つ。
--   - DELETE     … §1 物理削除の原則禁止。失効は状態列で表す
--   - TRUNCATE   … 全行削除。監査証跡ごと消えるため DELETE より危険
--   - REFERENCES … 他表から FK を張る権限。スキーマ変更はマイグレーションの仕事
--   - TRIGGER    … トリガー定義の追加。認可の最後の関門を上書きできてしまう
-- =============================================================================

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.members                   FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.member_profiles_private   FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.member_role_changes       FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.member_invitations        FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.rooms                     FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.room_assignments          FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.work_categories           FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.quests                    FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.lodging_register_entries  FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.morning_meetings          FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.knowledge_chunks          FROM service_role;


-- =============================================================================
-- 3. service_role から余剰権限を剥がす（ビュー）
--
-- ビューは読み取り専用の投影である。書き込み権限を残す理由がない。
-- 0100:407 が rag.v_cohort_stats へ SELECT だけを与えているのと同じ扱いに揃える。
-- =============================================================================

REVOKE DELETE, INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER
  ON public.v_member_public FROM service_role;
REVOKE DELETE, INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER
  ON public.v_quest_board   FROM service_role;


-- =============================================================================
-- 4. 今後作られるテーブルにも同じ既定を効かせる
--
-- ここまでは「今ある表」を直しただけである。これが無いと、次に public へ
-- テーブルを足した時点で同じ穴が再発する（本件がまさにそれだった）。
--
-- ⚠️ ALTER DEFAULT PRIVILEGES は「実行したロールが作るオブジェクト」にしか効かない。
--    Supabase 側の既定が別ロール（supabase_admin 等）で設定されている場合、
--    これだけでは打ち消せない可能性がある。そのため tests/db/rag-pgvector.test.ts と
--    tests/db/service-role-privileges.test.ts が**実測値**で検査し、
--    取りこぼしたら CI が赤くなるようにしてある。
-- =============================================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA rag
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM service_role;


-- =============================================================================
-- ロールバック（適用を戻す場合の手順。実行はしない）
-- =============================================================================
-- GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO service_role;
-- ALTER EXTENSION vector SET SCHEMA public;
-- -- ⚠️ 戻す前に「なぜ service_role に削除権が要るのか」を QUESTIONS.md へ起票すること。
-- --    §1 物理削除の原則禁止に対する例外の申請にあたる。
