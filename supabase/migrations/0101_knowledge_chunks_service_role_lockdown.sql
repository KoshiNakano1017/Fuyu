-- =============================================================================
-- 0101_knowledge_chunks_service_role_lockdown.sql
--
-- `public.knowledge_chunks`（ナレッジチャンク）から、Supabase の既定権限で
-- 勝手に生えていた DELETE / TRUNCATE / REFERENCES / TRIGGER を service_role から外す。
--
-- 根拠:
--   - DB物理設計.md §1「物理削除の原則禁止」（失効は `source_deleted` で表す）
--   - `0100_rag_pgvector_knowledge_chunks.sql`（pgvector 基盤）§7 は
--     `GRANT SELECT, INSERT, UPDATE ... TO service_role` しか書いていない
--   - `tests/db/rag-pgvector.test.ts`
--     「service_role にも DELETE は与えられていない（失効は source_deleted で表す）」
--
-- なぜ 0100 では塞げていなかったのか:
--   Supabase は `public` スキーマに対して `ALTER DEFAULT PRIVILEGES ... GRANT ALL
--   ON TABLES TO service_role` を既定で持つ。したがって `public` にテーブルを作ると、
--   0100 §7 が明示した3権限とは無関係に **ALL が先に付いている**。
--   明示 GRANT は「足す」ものであって「絞る」ものではないため、
--   REVOKE を書かない限り DELETE は残る（`rag` スキーマ側は 0100 §1 が
--   `ALTER DEFAULT PRIVILEGES` で潰しているため同じ穴は無い）。
--
--   0100 は不改変（`tests/migrations-baseline.test.ts` が固定）のため、後続の連番で足す。
-- =============================================================================

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.knowledge_chunks
  FROM service_role;
