-- =============================================================================
-- WBS 3-2（チェックイン画面・宿泊者名簿）: lodging_register_entries.checkin_id の FK 回収
--
-- 根拠: v13 §5.2.7「★ チェックイン時の宿泊者名簿収集（2026-09-20 決定）」、
--       `0010_lodging_register_entries.sql` のコメント
--       「`check_ins` は WBS 3-2（Issue #54）の成果物であり、まだ存在しない。
--        3-2 が `check_ins` を作った時点で、次の ALTER を追加すること」
--
-- `0014_check_ins_and_accommodation_types.sql` が `check_ins` を作成済みのため、
-- 0010 が先送りしていた FK をここで回収する。CLAUDE.md §4.5「既存マイグレーションを
-- 書き換えない」に従い、0010・0014 のどちらも書き換えず ALTER で追加する。
-- =============================================================================

ALTER TABLE public.lodging_register_entries
  ADD CONSTRAINT fk_lodging_register_check_in
  FOREIGN KEY (checkin_id) REFERENCES public.check_ins (checkin_id)
  ON DELETE SET NULL;
