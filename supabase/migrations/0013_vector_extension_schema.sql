-- =============================================================================
-- 0013_vector_extension_schema.sql
--
-- pgvector 拡張を `extensions` スキーマへ作る（`public` に作らせない）。
--
-- 根拠:
--   - Supabase DB Advisor の `extension_in_public` 警告
--   - `tests/db/rag-pgvector.test.ts`「vector 拡張が public スキーマに作られていない」
--
-- なぜ 0100 より前の連番なのか:
--   `0100_rag_pgvector_knowledge_chunks.sql`（pgvector 基盤）は
--   `CREATE EXTENSION IF NOT EXISTS vector;` とだけ書いており、スキーマを指定していない。
--   そのため素で適用すると `public` に作られる。0100 は
--   `tests/migrations-baseline.test.ts` が SQL 文リスト完全一致で不改変を固定しており
--   書き換えられない（CLAUDE.md §4.5「既存マイグレーションを書き換えない」）。
--   本ファイルが先に `extensions` へ作っておけば、0100 側の `IF NOT EXISTS` が
--   no-op になり、**0100 を1文字も触らずに配置先だけを正せる**。
--
--   ⚠️ 逆順（0100 の後）では直せない。一度 public に作られた拡張は、依存する型・索引が
--      あるため `ALTER EXTENSION ... SET SCHEMA` で動かせない（0100 の受入テストが
--      その旨をコメントに残している）。
-- =============================================================================

-- Supabase の標準 DB には既に存在するが、素の Postgres で再現するときのために冪等にする。
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
