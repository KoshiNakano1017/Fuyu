-- =============================================================================
-- 0022_reservation_otps.sql — 公開予約ページの本人確認コード
--
--   WBS  : 3-5b（★ 公開予約ページ `/reserve`）／Issue #107
--   根拠 : v13 §5.2.3 TO-BE②（送信前にメールOTPで本人確認）・§5.8.3（名寄せの初回紐付け）
--          `DB物理設計.md` §3-6③
--   含む : reservation_otps のスキーマ・索引・RLS・GRANT
--
-- ── なぜ会員ログインの OTP と別の仕組みが要るのか ──────────────────────
--
-- 会員ログインの6桁コードは **Supabase Auth（GoTrue）の Email OTP** であり、
-- `auth.users` に行があることが前提である（`src/app/login/actions.ts` は
-- `shouldCreateUser: false` で新規作成を禁じている。招待していない相手に
-- 会員アカウントを作らせないため ／ v13 §5.2.6）。
--
-- 公開予約ページは **アカウントを作らない導線**である。v13 §5.2.3 は
-- Googleフォームを廃止し（§9 #46）、初回来訪者がログインせずに予約を完結できることを
-- 要件にしている。したがって Auth の OTP は使えず、本表で自前に持つ。
--
-- ⚠️ **送信基盤は共通である。** v13 §5.2.6 の決着表が「OTP の送信基盤は Resend ／
--    **送信基盤を新設しない**」と定めている（`QUESTIONS.md` 2026-09-10 決着）。
--    違うのは呼び出し側だけで、
--      - 会員ログイン・招待リンク → Supabase Auth の SMTP 設定に Resend（WBS 1-1e）
--      - 公開予約OTP（ここ）     → アプリから Resend API を直接叩く（`RESEND_API_KEY`）
--    同じ Resend アカウント・同じ送信ドメインを使う。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.reservation_otps (
  otp_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 予約者のメールアドレス。**個人情報**である（CLAUDE.md §3.1）
  email         text NOT NULL
                  CONSTRAINT chk_reservation_otp_email_present
                  CHECK (btrim(email) <> ''),

  -- ★ 平文のコードは保存しない。DB が流出しても、そこから有効なコードは作れない
  code_hash     text NOT NULL
                  CONSTRAINT chk_reservation_otp_hash_present
                  CHECK (btrim(code_hash) <> ''),

  expires_at    timestamptz NOT NULL,

  -- 総当たり防止。上限を超えたら消費済みとして無効化する（判定はアプリ側）
  attempt_count integer NOT NULL DEFAULT 0
                  CONSTRAINT chk_reservation_otp_attempts_non_negative
                  CHECK (attempt_count >= 0),

  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- 期限は発行より後でなければならない。過去日で作られた行は永久に検証を通らず、
  -- 「コードが届いたのに通らない」という原因の分からない詰まりになる
  CONSTRAINT chk_reservation_otp_expiry_after_creation
    CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.reservation_otps IS
  '公開予約ページ /reserve の本人確認コード（v13 §5.2.3②）。'
  '平文コードは保存せず code_hash のみを持つ。期限切れ・消費済みの行は定期的に削除する'
  '（メールアドレスは個人情報であり、不要な保持期間を作らない）。';
COMMENT ON COLUMN public.reservation_otps.code_hash IS
  'コードのハッシュ。平文はメール本文にしか存在しない。ログにも出さない（CLAUDE.md §3.2）';

-- 同一アドレスの最新行を引く経路（再送のレート制限と検証）
CREATE INDEX IF NOT EXISTS ix_reservation_otps_email
  ON public.reservation_otps (email, created_at DESC);

-- 期限切れ行の掃除に使う。保持期間を延ばさないための運用索引
CREATE INDEX IF NOT EXISTS ix_reservation_otps_expired
  ON public.reservation_otps (expires_at)
  WHERE consumed_at IS NULL;


-- =============================================================================
-- ② RLS（DB物理設計 §6）
--
--   ★ **ポリシーを1つも作らない。** RLS を有効にしたうえでポリシーが無い表は
--     全拒否になる。これは書き忘れではなく設計である。
--
--   本表はログインしていない相手のために使う。したがって
--     - `anon` から読めてはならない（他人のアドレス宛のコードを総当たりできる）
--     - `authenticated` から読める必要も無い（会員ログインは Auth 側の OTP を使う）
--   操作するのは **サーバ側（service_role）だけ**である。
--   0015 のコメントが「未ログインの公開予約ページは anon キーで直接 DB を読まず、
--   必ずサーバ側（service_role）を経由する」と定めているのと同じ経路に乗せる
--   （`API設計.md` §1-1・`非機能要件詳細.md` §2-2b）。
--
--   ⚠️ service_role は RLS も GRANT も迂回する。**この表を触るサーバ側の実装を増やさない。**
--      触る場所が増えるほど、コードのどこかが平文コードをログへ出す確率が上がる。
-- =============================================================================

ALTER TABLE public.reservation_otps ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- ③ GRANT（DB物理設計 §6-6②）
--
--   anon・authenticated いずれにも与えない。RLS の全拒否と GRANT の剥奪を二重に置く。
--   片方だけだと、後からポリシーを1本足した瞬間に読めるようになってしまう。
-- =============================================================================

REVOKE ALL ON public.reservation_otps FROM anon, authenticated;
