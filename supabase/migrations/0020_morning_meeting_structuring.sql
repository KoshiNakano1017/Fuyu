-- =============================================================================
-- WBS 4-2：議事録の構造化 ＋ クエスト候補起案（`morning_meetings` への書き込み経路）
--
-- 根拠: v13 §5.1 ②③（構造化議事録＝決定事項・共有事項・注意点 ／ クエスト候補JSON＝
--         タスク名・想定人数・想定時間・担当候補を**同一のAPI呼び出しで**同時出力）、
--       v13 §5.7.4 ②（ナレッジ候補も**同じ1回の呼び出し**に相乗りさせる。別呼び出しにすると
--         非機能 P3 の60秒を圧迫する）、v13 §9 #63（アプリは音声を扱わない）、
--       v13 §6 L2140（朝会＝管理者〇・コアメンバー〇）、
--       `0011_morning_meetings.sql` L102-105（「必要最小の権限を別マイグレーションで足す」）
--
-- ── なぜ本ファイルが要るか ────────────────────────────────
--   `0011` は UPDATE のポリシーも GRANT も**意図的に置いていない**（投入UIしか無い段階で
--   書き換え経路を開けないため）。その結果 **`summary_text` を埋められない**状態にある。
--   4-2 の生成処理が書き込むために、ここで最小の権限だけを足す。
--   ⚠️ `0011` は書き換えない（CLAUDE.md §4.5）。
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : extracted_quest_candidates 列の追加 ／ UPDATE ポリシー ／ 列単位 GRANT
--   含まない:
--     - 生成処理そのもの（Gemini 呼び出し）→ `src/lib/morning-meetings/structure.ts`
--     - クエスト候補のボードへの公開      → WBS 4-3（`quests` への INSERT。0008 の
--                                            `quests_write_staff` で既に許可されている）
-- =============================================================================


-- =============================================================================
-- ① extracted_quest_candidates（抽出されたクエスト候補）
--
--   `DB物理設計.md` §3-4 L327 が `[{title, headcount, hours, candidate_assignee}]` として
--   提案していた列。**4-3 が「補正・却下」の状態を保つために必要**である。
--   ここが無いと、画面を再読み込みするたびに候補が生成前へ戻る（毎回 AI を呼び直すことになり、
--   非機能 P3 の意味が無くなる）。
--
--   jsonb にする理由: 候補は**承認されるまでクエストではない**。承認された時点で
--   `quests` へ1行 INSERT する（`origin_type = 'morning_meeting_auto'`）。
--   未承認の候補を `quests` に status で持たせると、クエストボードの行数・
--   ゲスト開放件数バナー（v13 §5.10.6）の分母が候補で汚れる。
-- =============================================================================

ALTER TABLE public.morning_meetings
  ADD COLUMN extracted_quest_candidates jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.morning_meetings.extracted_quest_candidates IS
  '議事録から抽出したクエスト候補（v13 §5.1 ③）。形は [{title, headcount, estimatedMinutes, '
  'assigneeCandidates[], sourceQuote, status}]。★ 承認されるまで quests に行を作らない'
  '（未承認の候補がクエストボードの件数・ゲスト開放バナーの分母を汚すため／v13 §5.10.6）。';

-- 構造化が済んでいない議事録の抽出（4-2 の処理待ち行列）。
CREATE INDEX ix_morning_meetings_unstructured ON public.morning_meetings (created_at)
  WHERE summary_text IS NULL;


-- =============================================================================
-- ② UPDATE ポリシー（v13 §6 L2140：朝会は admin ＋ core_member）
--
--   `0011` の SELECT / INSERT と同じく `is_staff()` で判定する。
--   派生設計（`DB物理設計.md` §6 ⑦ の `mm_insert_admin`）は admin 限定だが、
--   正本 v13 §6 がコアメンバーも〇としており、正本が勝つ（CLAUDE.md §1.1）。
-- =============================================================================

CREATE POLICY mm_update_staff ON public.morning_meetings
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：引き続きポリシーを作らない ＝ 全拒否。議事録は運営の記録であり消さない。


-- =============================================================================
-- ③ GRANT（§6-6②）— ★ 列を絞る
--
--   全列 UPDATE を与えると **`transcript_text` を後から書き換えられる**。
--   文字起こし全文は「貼り付けられた事実の記録」であり、生成処理が触ってよい対象ではない
--   （`0011` のコメント：「整形・要約をして保存しない」）。
--   書き換えを許すと、議事録の根拠が後から改変されうる状態になる。
-- =============================================================================

GRANT UPDATE (summary_text, extracted_quest_candidates, updated_at)
  ON public.morning_meetings TO authenticated;
