-- =============================================================================
-- 0040_link_member_by_matching.sql — 名寄せの成立（結合 ＋ 監査記録）を1トランザクションで行う
--
--   WBS  : 10-2（名寄せロジック ／ 決定 B）
--   根拠 : 正本 v13 §5.8.3（連携完了時に `account_status` を `active` へ ／
--          成立・解除を監査ログへ残す）、`0003`（権限列の変更は操作者の申告が要る）、
--          `0004`（`bind_member_auth_user()` と同じ事情で関数側に閉じる）
--   含む : `link_member_by_matching()` の RPC 1本
--
-- ── なぜ `bind_member_auth_user()`（`0004`）と別に作るのか ────────────────
--
-- `0004` は**招待台帳（経路B）からの結合**である。本関数は**名寄せ（§5.8.3）からの結合**で、
-- 違いは「根拠を監査ログへ残すこと」である。
--
-- 結合と監査記録を**同じトランザクションに置く**のが要点。分けると
-- 「結合したが根拠が残っていない」行が生まれ、**他人の宿泊券・Uii残高・XP を引き継いだ経緯を
-- 後から追えなくなる**（v13 §5.8.3 の [!warning] ③がまさにこれを禁じている）。
--
-- ── 誰が呼べるか ────────────────────────────────────────────────────
--
-- **`service_role` だけ。** 名寄せの実行時点で、本人はまだ `members` へ結合されていない
-- （`auth.uid()` から自分の行を引けない）。したがって RLS 越しには成立させられず、
-- `0004` と同じ理由でサーバ側からの呼び出しになる。
-- `authenticated` から呼べると「操作者を自由に申告して他人の会員行を奪う」入口になる。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.link_member_by_matching(
  p_member_id    uuid,
  p_auth_user_id uuid,
  p_operator_id  uuid,
  p_match_basis  text,
  p_request_id   uuid DEFAULT NULL,
  p_decided_by   uuid DEFAULT NULL,
  -- 照合に使った連絡先。渡されたら**本人確認済みへ昇格させる**（下記 ④）
  p_identifier_kind  text DEFAULT NULL,
  p_identifier_value text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.members;
BEGIN
  IF btrim(coalesce(p_match_basis, '')) = '' THEN
    -- 根拠の無い名寄せを作らせない。監査ログの意味がそこにある（§5.8.3 ③）。
    RAISE EXCEPTION '名寄せの根拠（match_basis）は必須である' USING ERRCODE = '23502';
  END IF;

  -- ── 1. 対象を押さえる（同時に2つの Auth ユーザーが同じ会員へ来る競合を止める）──
  SELECT * INTO target
  FROM   public.members
  WHERE  member_id = p_member_id
  FOR UPDATE;

  IF target.member_id IS NULL THEN
    RAISE EXCEPTION '対象の会員が見つからない: %', p_member_id USING ERRCODE = 'P0002';
  END IF;

  -- ★ 既に結合済みの会員は触らない（`0003` のガード②も同じことを拒むが、
  --   ここで先に落として意味のある例外を返す）。**名寄せは奪取の経路になってはならない。**
  IF target.auth_user_id IS NOT NULL AND target.auth_user_id <> p_auth_user_id THEN
    RAISE EXCEPTION 'この会員は既に別のアカウントへ結合されている' USING ERRCODE = '42501';
  END IF;

  -- 冪等にする。同じ相手への再実行は監査を増やさず黙って終わる
  -- （ログインのたびに呼ばれても安全でなければならない ／ `0004` と同じ方針）。
  IF target.auth_user_id = p_auth_user_id THEN
    RETURN;
  END IF;

  -- ── 2. 結合する（ガードへ操作者を申告する）────────────────────────
  PERFORM set_config('app.operator_id', p_operator_id::text, true);

  UPDATE public.members
  SET    auth_user_id   = p_auth_user_id,
         account_status = 'active'
  WHERE  member_id      = p_member_id
    AND  auth_user_id   IS NULL;   -- ★ 付け替えの防止（`0004` と同じ条件）

  IF NOT FOUND THEN
    RAISE EXCEPTION '結合対象が見つからない（既に auth_user_id が入っている可能性）: %', p_member_id
      USING ERRCODE = '42501';
  END IF;

  -- ── 3. 監査ログ（v13 §5.8.3 ③）────────────────────────────────
  --   ★ 自動成立でも必ず残す。`decided_by` が NULL なら「システムが決めた」という意味である。
  INSERT INTO public.member_link_events
    (member_id, auth_user_id, action, match_basis, decided_by, request_id)
  VALUES
    (p_member_id, p_auth_user_id, '成立', btrim(p_match_basis), p_decided_by, p_request_id);

  -- ── 4. 照合に使った連絡先を本人確認済みへ昇格させる（v13 §5.8.3 ②）────
  --
  --   ★ ここで `is_verified = true` にするのは、**ワンタイム認証を通った事実**を
  --   残すためである（`0025` の `uq_identifier_verified` は「同じ連絡先が2人の会員に
  --   検証済みとして結び付くこと」＝誤名寄せそのものを禁じる索引であり、
  --   ここを埋めておくと以後の照合で二重一致が構造的に起きなくなる）。
  --
  --   ⚠️ 一意制約に当たる場合（他人が同じ連絡先を検証済みで持っている）は
  --   **例外にする**。結合ごとロールバックさせるのが正しい — その状況は
  --   「候補1件」の前提が崩れており、自動成立させてはいけない状態である。
  IF p_identifier_kind IS NOT NULL AND btrim(coalesce(p_identifier_value, '')) <> '' THEN
    UPDATE public.member_identifiers
    SET    is_verified = true,
           verified_at = coalesce(verified_at, now()),
           updated_at  = now()
    WHERE  member_id        = p_member_id
      AND  kind             = p_identifier_kind
      AND  value_normalized = lower(btrim(p_identifier_value))
      AND  is_verified      = false;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.link_member_by_matching(uuid, uuid, uuid, text, uuid, uuid, text, text) IS
  '名寄せの成立（v13 §5.8.3）。結合（auth_user_id ／ account_status）と監査記録を'
  '1トランザクションで行う。★ 分けると「結合したが根拠が残っていない」行が生まれ、'
  '他人の宿泊券・残高を引き継いだ経緯を追えなくなる。service_role からのみ呼べる。';

REVOKE EXECUTE ON FUNCTION public.link_member_by_matching(uuid, uuid, uuid, text, uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.link_member_by_matching(uuid, uuid, uuid, text, uuid, uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.link_member_by_matching(uuid, uuid, uuid, text, uuid, uuid, text, text) FROM authenticated;
