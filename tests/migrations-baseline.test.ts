// 既存マイグレーション `0100_rag_pgvector_knowledge_chunks.sql` の不改変を固定する（完了条件24）。
//
// 根拠: CLAUDE.md §4.5「既存マイグレーションを書き換えない」。
//       同ファイル自身が「採番 0100 は 0001〜0099 をベーススキーマ用に空けておくため」と明記しており、
//       WBS 2-1 の会員スキーマは **0100 を書き換えるのではなく、それより前の番号で追加する**。
//
// ⚠️ この試験が捕まえるのは「行数の変化」と「SQL 文の増減・書き換え」である。
//    コメント本文だけを同じ行数で差し替える改変は捕まえられない。
//    厳密な不改変は git の差分レビュー（CLAUDE.md §5.3）が担い、ここはその取りこぼしを機械で拾う位置づけ。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(__dirname, "..");
const MIGRATION_PATH = join(REPOSITORY_ROOT, "supabase/migrations/0100_rag_pgvector_knowledge_chunks.sql");

/** WBS 2-1 着手時点（2026-09-14）の行数。 */
const BASELINE_LINE_COUNT = 424;

/** 同時点で存在した SQL 文の開始行（コメント・継続行を除く）。 */
const BASELINE_STATEMENTS = [
  "CREATE EXTENSION IF NOT EXISTS vector;",
  "CREATE SCHEMA IF NOT EXISTS rag;",
  "REVOKE ALL   ON SCHEMA rag FROM PUBLIC, anon, authenticated;",
  "GRANT  USAGE ON SCHEMA rag TO service_role;",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA rag REVOKE ALL ON TABLES    FROM anon, authenticated;",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA rag REVOKE ALL ON SEQUENCES FROM anon, authenticated;",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA rag REVOKE ALL ON ROUTINES  FROM anon, authenticated;",
  "COMMENT ON SCHEMA rag IS",
  "CREATE TABLE public.knowledge_chunks (",
  "COMMENT ON TABLE public.knowledge_chunks IS",
  "COMMENT ON COLUMN public.knowledge_chunks.embedding IS",
  "COMMENT ON COLUMN public.knowledge_chunks.embedding_model IS",
  "COMMENT ON COLUMN public.knowledge_chunks.pii_hit_count IS",
  "CREATE INDEX ix_chunks_ann ON public.knowledge_chunks",
  "CREATE INDEX ix_chunks_source ON public.knowledge_chunks (source_type, source_id);",
  "CREATE INDEX ix_chunks_export ON public.knowledge_chunks (tier, exportable_to_line)",
  "CREATE INDEX ix_chunks_needs_review ON public.knowledge_chunks (pii_scan_status)",
  "CREATE OR REPLACE FUNCTION rag.redact_known_names(p_text text)",
  "SET search_path = ''          -- search_path 乗っ取りの防止（SECURITY DEFINER の必須作法）",
  "BEGIN",
  "COMMENT ON FUNCTION rag.redact_known_names(text) IS",
  "CREATE OR REPLACE FUNCTION rag.contains_known_names(p_text text)",
  "SET search_path = ''",
  "COMMENT ON FUNCTION rag.contains_known_names(text) IS",
  "REVOKE EXECUTE ON FUNCTION rag.redact_known_names(text)   FROM PUBLIC, anon, authenticated;",
  "REVOKE EXECUTE ON FUNCTION rag.contains_known_names(text) FROM PUBLIC, anon, authenticated;",
  "GRANT  EXECUTE ON FUNCTION rag.redact_known_names(text)   TO service_role;",
  "GRANT  EXECUTE ON FUNCTION rag.contains_known_names(text) TO service_role;",
  "CREATE TABLE rag.member_behavior_features (",
  "COMMENT ON TABLE rag.member_behavior_features IS",
  "CREATE INDEX ix_behavior_ann ON rag.member_behavior_features",
  "CREATE OR REPLACE VIEW rag.v_cohort_stats AS",
  "SELECT f.age_bracket,",
  "COMMENT ON VIEW rag.v_cohort_stats IS",
  "CREATE OR REPLACE FUNCTION rag.touch_updated_at()",
  "BEGIN",
  "CREATE TRIGGER trg_knowledge_chunks_touch",
  "ALTER TABLE public.knowledge_chunks      ENABLE ROW LEVEL SECURITY;",
  "ALTER TABLE rag.member_behavior_features ENABLE ROW LEVEL SECURITY;",
  "REVOKE ALL ON public.knowledge_chunks      FROM anon, authenticated;",
  "REVOKE ALL ON rag.member_behavior_features FROM anon, authenticated;",
  "GRANT SELECT, INSERT, UPDATE ON public.knowledge_chunks      TO service_role;",
  "GRANT SELECT, INSERT, UPDATE ON rag.member_behavior_features TO service_role;",
  "GRANT SELECT                 ON rag.v_cohort_stats           TO service_role;",
];

const STATEMENT_HEAD = /^(CREATE|ALTER|GRANT|REVOKE|COMMENT|DROP|INSERT|UPDATE|DELETE|SELECT|DO|SET|BEGIN|COMMIT)/;

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("既存マイグレーション 0100 の不改変（完了条件24）", () => {
  test("0100_rag_pgvector_knowledge_chunks.sql の行数が変わっていない", () => {
    const lines = readMigration().replace(/\n$/, "").split("\n");
    expect(lines.length).toBe(BASELINE_LINE_COUNT);
  });

  test("0100_rag_pgvector_knowledge_chunks.sql の SQL 文が1つも増減・変更されていない", () => {
    const statements = readMigration()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => STATEMENT_HEAD.test(line));
    expect(statements).toEqual(BASELINE_STATEMENTS);
  });
});
