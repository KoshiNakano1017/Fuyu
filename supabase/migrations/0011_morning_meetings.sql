-- =============================================================================
-- WBS 4-1：朝会・議事録（morning_meetings）
--
-- 根拠: v13 §9 #63（2026-09-05 オーナー決定。**アプリは音声を扱わない**。入力は文字起こし済み
--         テキストで、投入方法はUI画面へのコピー＆ペースト。API連携・ファイルアップロードは行わない。
--         **貼り付け時点で議事録として格納する**）、
--       v13 §7「★ 朝会・議事録データ」（朝会ID・実施日・全文文字起こしテキスト・作成者ID）、
--       v13 §6 権限マトリクス L2106（朝会＝管理者〇／コアメンバー〇／会員−／ゲスト−）、
--       v13 §5.9.3・§8（認可の二重防御。行単位の制御は RLS が持ち、ポリシー未定義は既定で全拒否）、
--       DB物理設計.md §6-6b L1152（本表は **PII-A**。公開範囲は staff のみ）・§6-6①②・§6-7
--
-- ── スコープ（Issue #23 の 2026-09-19 オーナー決定 ＝ A'）────────────────
--   含む   : morning_meetings のスキーマ・RLS・GRANT ＋ 投入UI・保存処理
--   含まない:
--     - 構造化議事録の生成（summary_text を埋める処理）        → WBS 4-2
--     - クエスト候補の抽出・起案                                → WBS 4-2 / 4-3
--     - 投入画面へのナビゲーション導線                          → WBS 2-3 / 2-6
--
-- > [!warning] 派生設計と正本が食い違う箇所である（2026-09-19 に QUESTIONS.md へ記録済み）
-- > ① `DB物理設計.md` §3-4 L324 は `audio_storage_path text NOT NULL` を置くが、
-- >    アプリは音声を扱わないため**埋める値が存在しない**。本表に音声関連の列は置かない。
-- > ② 同 §6 ⑦ の `mm_insert_admin` は INSERT を `is_admin()` に絞るが、
-- >    正本 v13 §6 L2106 はコアメンバーも〇である。
-- > どちらも `CLAUDE.md` §1.1 により**正本 v13 が勝つ**。派生設計側の追随はオーナー判断。
--
-- > [!note] このポリシーは WBS 2-2 で見直す
-- > 2-2（RLS ポリシーの整備）より先に本表のポリシーと GRANT を置くのは A' の明示的な許可による。
-- > `CLAUDE.md` §4.5「既存マイグレーションを書き換えない」に従い、
-- > 2-2 側は本ファイルを編集せず**別ファイルでポリシーを差し替える**こと。
-- =============================================================================


-- =============================================================================
-- ① morning_meetings（v13 §7「★ 朝会・議事録データ」）
-- =============================================================================

CREATE TABLE public.morning_meetings (
  meeting_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 実施日。朝会は1日1回だが、同じ日の議事録を訂正のため別レコードで投入する運用を
  -- 否定できないため、ここでは一意制約を置かない（v13 に一意の定めが無い）。
  held_on         date NOT NULL,

  -- 外部ソフトで文字起こしした全文。**貼り付けられた本文をそのまま保持する**。
  -- 話者ラベル・タイムスタンプの有無は未確定だが、本文を加工せず持つ設計であれば
  -- どちらでも動く（QUESTIONS.md「[2026-09-05] 朝会文字起こしテキストの投入経路」回答）。
  transcript_text text NOT NULL
                    CONSTRAINT chk_morning_meetings_transcript_not_blank
                    CHECK (btrim(transcript_text) <> ''),

  -- 構造化議事録のサマリー。**NULL 許容は必須**。
  -- §9 #63 が「貼り付け時点で議事録として格納する」と定めており、
  -- 生成（WBS 4-2）を待たずに行が成立しなければならない。
  summary_text    text,

  -- 作成者＝投入した運営。会員行が物理削除されても議事録は残す（議事録は運営の記録であり、
  -- 投入者が居なくなったことで内容が失われてよいものではない）。
  created_by      uuid REFERENCES public.members (member_id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 実施日での絞り込み（「先週の朝会」など）に効かせる。
CREATE INDEX ix_morning_meetings_held_on ON public.morning_meetings (held_on DESC);

COMMENT ON TABLE public.morning_meetings IS
  '朝会の議事録（v13 §7「★ 朝会・議事録データ」）。入力は外部ソフトで文字起こし済みのテキストで、'
  'アプリは音声を一切扱わない（v13 §9 #63 ／ 2026-09-05 オーナー決定）。'
  '本文に会員の実名が含まれうるため PII-A 扱いとし、読み書きとも staff に限る';

COMMENT ON COLUMN public.morning_meetings.transcript_text IS
  '貼り付けられた全文。整形・要約をして保存しない。構造化は summary_text を埋める WBS 4-2 の責務';

COMMENT ON COLUMN public.morning_meetings.summary_text IS
  '構造化議事録。投入時点では NULL。NOT NULL にすると「貼り付け時点で格納する」が成立しない（v13 §9 #63）';


-- =============================================================================
-- ② RLS：既定は全拒否（§6-7）
--
-- 議事録の本文には会員の実名が含まれうる（PII-A）。認可は **role のみ**で判定し、
-- member_type（親方／街人／ゲスト）はポリシー条件に一切現れてはならない（v13 §2）。
-- =============================================================================

ALTER TABLE public.morning_meetings ENABLE ROW LEVEL SECURITY;

-- ── SELECT：staff だけ（v13 §6 L2106 ／ DB物理設計 §6-6b L1152）─────────
--    staff 以外には**エラーではなく0行**が返る。エラーで返すと
--    「その日に朝会の記録が在ること」自体が漏れる（§6-8⑤）。
CREATE POLICY mm_select_staff ON public.morning_meetings
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- ── INSERT：staff だけ ────────────────────────────────────────────
--    派生設計の `mm_insert_admin`（is_admin() 限定）ではなく is_staff() を採る。
--    正本 v13 §6 L2106 がコアメンバーも〇としているため（CLAUDE.md §1.1）。
CREATE POLICY mm_insert_staff ON public.morning_meetings
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- UPDATE / DELETE：ポリシーを1本も作らず、GRANT も与えない ＝ 全拒否（§8 の既定拒否）。
--   summary_text を埋めるのは WBS 4-2 の生成処理であり、その経路が決まってから
--   必要最小の権限を別マイグレーションで足す。投入した議事録をクライアントから
--   書き換え・削除できる状態を、投入UIしか無い本パッケージで作らない。


-- =============================================================================
-- ③ GRANT（§6-6②）
--
-- ★ 0005・0010 と同じく、**先に既定の広い権限を剥がしてから**必要分だけ与える。
--   GRANT が無いと RLS の評価より手前で 42501 になるため、
--   ポリシーを正しく書いても staff の投入が通らない。
-- =============================================================================

REVOKE ALL ON public.morning_meetings FROM anon, authenticated;

-- 行の絞り込みは上の RLS が行う。staff も authenticated セッションで操作するため、
-- GRANT 自体は authenticated に与える必要がある。UPDATE / DELETE は与えない。
GRANT SELECT, INSERT ON public.morning_meetings TO authenticated;
