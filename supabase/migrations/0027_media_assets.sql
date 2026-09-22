-- =============================================================================
-- WBS 2-1c（`media_assets` のスキーマ ＋ RLS）／ WBS 1-4（署名付きURL基盤）の DB 側
--
-- 根拠: v13 §5.11.2（署名付きURL方式・認可を二重化しない）・§5.11.5（サイズ／contentType の強制）・
--       §5.11.7（全ロール開放・用途タグ必須）・§7「★ メディアアセット」L2326（保持項目の正）・
--       §9 #9（ストレージ認可）・§9 #57（AIタグはアップロード時の事前計算）、
--       `DB物理設計.md` §3-7（L461-497 の DDL）・§6-1 #22（PII-B と公開範囲）・§6-6（RLS ／ GRANT）
--
-- ── 列構成は「正本 v13 §7 の全面採用」で確定した（2026-09-22 オーナー決定 C）─────
--   `QUESTIONS.md`「[2026-09-20] `media_assets` の列構成が正本 v13 §7 と `DB物理設計.md` §3-7 の
--   DDL で食い違う」の決着。選択肢 C（正本 §7 を全面採用）が選ばれたため、§3-7 の DDL に対して
--   次を加えている。**派生設計（§3-7）側が正本に追随する方向での解消である**（CLAUDE.md §1.1）。
--
--   | 加えたもの                          | 正本の根拠                                                          |
--   | ----------------------------------- | ------------------------------------------------------------------- |
--   | `media_type` に `pdf` を追加（3値） | §7「ファイル種別（image / video / pdf）」                            |
--   | `content_type` / `file_size_bytes`  | §7「`contentType`、ファイルサイズ」                                  |
--   | `usage_scene text[]`                | §7「`usage_scene[]`」                                                |
--   | `ai_tags text[]`                    | §7 ／ §9 #57（§3-7 は v1.21.0 の反映漏れ）                           |
--   | `knowledge_id` / `category_id`      | §7「紐付けキー（quest_id / knowledge_id / place_id / category_id）」 |
--
--   ⚠️ `media_type` の値域は §3-7 の `('photo','video')` ではなく **§7 の `('image','video','pdf')`** を採る。
--      `photo` → `image` の読み替えが起きるのはここだけであり、既存データは無い（本表が初回作成）。
--
--   ⚠️ **`pdf` と §5.11.7 の関係**: §5.11.7「対応形式」は画像・動画のみを挙げており、正本内部で
--      食い違っている（`QUESTIONS.md` の論点 ③）。決定 C はこの食い違いを **`pdf` を持つ側へ寄せて**解消する。
--      根拠は §7 のほかに v13 L1274（ナレッジの「補足マニュアル・画像／動画」＝「写真・PDF の添付」）と
--      L1315（「画像・動画・PDFは Cloud Storage for Firebase へ格納」）であり、**PDF の投入経路は
--      ナレッジ添付**である。§5.11.7 の全ロール向けアップロードUI（カメラロール／その場で撮影）が
--      画像・動画に限られること自体は変わらない。どの `content_type` を受け付けるかは
--      アプリ側の許可リスト（`src/lib/media/upload-policy.ts`）が経路ごとに決める。
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : `media_assets` の DDL ／ RLS ／ GRANT ／ 先送りされていた3本の FK の接続
--   含まない:
--     - 署名付きURLの発行（アプリ層）          → `src/lib/media/`（同じ PR の別ファイル）
--     - 運営措置（他者投稿の非表示化）の操作UI → WBS 14-3
--     - AI タグ・キャプションの生成            → Phase 2（本表は列だけ用意する）
-- =============================================================================


-- =============================================================================
-- ① media_assets — DB物理設計 §3-7 ＋ 正本 v13 §7 による補正（決定 C）
-- =============================================================================

CREATE TABLE public.media_assets (
  media_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- アップロード者。**全ロール（ゲストを含む）が投稿できる**（v13 §5.11.7）。
  member_id             uuid NOT NULL REFERENCES public.members (member_id),

  -- ★ 値域は正本 §7 の3値（決定 C）。§3-7 の ('photo','video') は採らない。
  media_type            text NOT NULL
                          CONSTRAINT chk_media_type
                          CHECK (media_type IN ('image', 'video', 'pdf')),

  -- 署名付きURLに焼き込んだ `Content-Type` をそのまま保存する（v13 §5.11.5）。
  -- 署名と DB が食い違うと「何を許可して発行したか」を後から追えなくなるため NOT NULL。
  content_type          text NOT NULL
                          CONSTRAINT chk_media_content_type_present
                          CHECK (btrim(content_type) <> ''),

  -- 実体のバイト数。**署名発行の時点では未確定**（クライアントが PUT するまで分からない）ため
  -- NULL を許し、Object Finalize（③）で確定値を書き戻す。孤児ファイル検出と課金の突合に使う。
  file_size_bytes       bigint
                          CONSTRAINT chk_media_file_size_positive
                          CHECK (file_size_bytes IS NULL OR file_size_bytes > 0),

  storage_path          text NOT NULL,   -- Cloud Storage のオブジェクト名（バケット名は含めない）
  thumbnail_path        text,            -- 動画のサムネイル（静止画は storage_path と同一で可）

  -- ★ 用途タグ（Phase 2 の検索精度を決める最重要項目／v13 §5.11.7 ②）。
  --   「タグ入力を任意にしないでください」（§5.11.3 note）に従い、最低1つを CHECK で強制する。
  purpose_tags          text[] NOT NULL DEFAULT '{}',

  -- 利用シーン（正本 §7 の `usage_scene[]`）。用途タグが「何に使うか」なら、こちらは
  -- 「どの場面で撮られたか」。Phase 2 の検索軸として先に持つ（後から足すと全件の再解析になる）。
  usage_scene           text[] NOT NULL DEFAULT '{}',

  -- ▼ 紐付けキー（正本 §7）。参照先が実在するものだけ FK を張る。
  place_id              uuid,            -- 拠点タグ。FEL共通スキーマ側のため FK なし（§3-7 と同じ扱い）
  linked_quest_id       uuid REFERENCES public.quests (quest_id),
  linked_work_log_id    uuid REFERENCES public.work_logs (log_id),

  -- ⚠️ `knowledge_id` / `category_id` は **FK を張らない**。参照先のマスタが未作成であるため
  --    （ナレッジ本体は `0100` の `knowledge_chunks` が chunk 単位で持つのみ、カテゴリマスタは
  --    `work_categories` がクエスト用として存在するだけで、メディアのカテゴリとは別物）。
  --    `0006` の `rooms.place_id` ／ `0017` の `work_logs.before_photo_media_id` と同じ作法で
  --    **値だけ持ち、参照先ができた作業パッケージが ALTER で FK を足す**。
  knowledge_id          uuid,
  category_id           uuid,

  -- ▼ 撮影メタデータ（Exif 由来。ユーザーに入力させない／§3-7）
  taken_at              timestamptz,
  -- ⚠️ PII-B（`DB物理設計.md` §6-1 #22）。撮影地の座標は個人の行動履歴になりうるため、
  --    一般会員・ゲストへは「公開」の行しか見せない（下の RLS）。ログにも出さない（CLAUDE.md §3.2）。
  geo_location          text,

  -- ▼ 全ロール開放に伴う項目（v13 §5.11.7 ／ §9 #33）
  visibility            text NOT NULL DEFAULT '公開'
                          CONSTRAINT chk_media_visibility
                          CHECK (visibility IN ('公開', '運営のみ')),

  -- 論理削除。運営措置による非表示化も同じ経路を通る（v13 §7 ／ WBS 14-3）。
  deleted_at            timestamptz,
  deleted_by            uuid REFERENCES public.members (member_id),
  delete_reason         text,

  -- ▼ アップロードの生死（★ 本 DDL で新設。§3-7 にも §7 にも無い）
  --
  --   v13 §5.11.2 note は「`pending` のまま一定期間（例：24時間）実体が現れないレコードは、
  --   定期ジョブで自動削除する」と定める。その判定に **`ai_processing_status` は使えない**。
  --   Phase 1 は AI 解析を動かさないため（§5.11.3「Phase 1 は `ai_tags[]` カラムのみ用意」）、
  --   全行が `pending` のまま残り、孤児判定が**正常な行まで巻き込んで消す**ことになる。
  --   「実体が着いたか（本列）」と「AI が処理したか（`ai_processing_status`）」は
  --   起こる時点も担当も違うため、列を分ける。
  --
  --     pending … 署名付きURLを発行し、レコードだけ先に作った状態（v13 §5.11.2 ①-b）
  --     stored  … Object Finalize が実体の到着を通知した状態（同 ③）
  --     expired … 実体が現れないまま期限を過ぎ、定期ジョブが失効させた状態
  upload_state          text NOT NULL DEFAULT 'pending'
                          CONSTRAINT chk_media_upload_state
                          CHECK (upload_state IN ('pending', 'stored', 'expired')),
  stored_at             timestamptz,     -- Object Finalize を受け取った時刻

  -- ▼ Phase 2 で使用（Phase 1 は値を入れない。後から列を足すと全件の再解析が必要になる／§7 note）
  ai_caption            text,
  ai_caption_edited     boolean NOT NULL DEFAULT false,
  ai_purpose_score      jsonb,           -- {"instagram": 0.82, "資料作成": 0.55}
  ai_processed_at       timestamptz,
  ai_processing_status  text NOT NULL DEFAULT 'pending'
                          CONSTRAINT chk_media_ai_processing_status
                          CHECK (ai_processing_status IN ('pending', 'processing', 'done', 'failed')),
  -- ★ エンジンは Claude（v13 §9 #57 ／ v1.19.0）。人間が追加・修正・削除できる（§5.11.3）。
  ai_tags               text[] NOT NULL DEFAULT '{}',

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- 用途タグは最低1つ必須（Phase 2 の検索・推薦が成立しなくなるため／v13 §5.11.7 ②）
  CONSTRAINT ck_media_purpose_tags_required CHECK (cardinality(purpose_tags) >= 1),

  -- 論理削除には操作者が要る。「誰が消したか分からない非表示化」を残さない（運営措置の監査／§7）。
  CONSTRAINT ck_media_deleted_has_operator CHECK (
    deleted_at IS NULL OR deleted_by IS NOT NULL
  ),

  -- 実体が着いていないのに着いた時刻だけがある、という状態を作らない。
  CONSTRAINT ck_media_stored_at_agrees CHECK (
    (upload_state = 'stored') = (stored_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.media_assets IS
  'メディア資産のメタデータの正（v13 §5.11.2・§7 ／ DB物理設計 §3-7）。実体は Cloud Storage。'
  '列構成は 2026-09-22 オーナー決定 C（正本 §7 の全面採用）。media_type は image / video / pdf の3値。'
  'PII-B（geo_location＝Exif 位置情報・ai_caption）。公開範囲は本人＋staff は全件、他は 公開 のみ。';

COMMENT ON COLUMN public.media_assets.upload_state IS
  '実体が Cloud Storage に着いたか。ai_processing_status（AI が処理したか）とは別物であり、'
  '統合してはならない。Phase 1 は AI を動かさないため ai_processing_status は常に pending であり、'
  '孤児ファイル検出（v13 §5.11.2 note）の判定に使えない。';

COMMENT ON COLUMN public.media_assets.geo_location IS
  'Exif 由来の位置情報。PII-B（DB物理設計 §6-1 #22）。ログ・外部サービスへ出力しない。';

CREATE INDEX ix_media_member            ON public.media_assets (member_id);
CREATE INDEX ix_media_purpose_tags      ON public.media_assets USING gin (purpose_tags);
CREATE INDEX ix_media_ai_tags           ON public.media_assets USING gin (ai_tags);
CREATE INDEX ix_media_processing_status ON public.media_assets (ai_processing_status)
  WHERE ai_processing_status IN ('pending', 'processing');

-- 一覧表示は削除済みを除外する（論理削除のため常に条件が付く）
CREATE INDEX ix_media_active ON public.media_assets (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_media_place  ON public.media_assets (place_id)        WHERE deleted_at IS NULL;

-- 孤児ファイル検出の定期ジョブが引く索引（v13 §5.11.2 note）。
CREATE INDEX ix_media_pending_upload ON public.media_assets (created_at)
  WHERE upload_state = 'pending';


-- =============================================================================
-- ② 先送りされていた外部キーを接続する
--
--   `0017`（work_logs）と `0018`（menu_items）は、本表が未作成だったため
--   「FK を張らず値だけ持つ」形で作られ、**本表を作る作業パッケージが ALTER を足すこと**と
--   コメントで申し送られていた（`0017` L124-129 ／ `0018` L55-58）。ここで回収する。
-- =============================================================================

ALTER TABLE public.work_logs
  ADD CONSTRAINT fk_worklog_before_photo
  FOREIGN KEY (before_photo_media_id) REFERENCES public.media_assets (media_id);

ALTER TABLE public.work_logs
  ADD CONSTRAINT fk_worklog_after_photo
  FOREIGN KEY (after_photo_media_id)  REFERENCES public.media_assets (media_id);

ALTER TABLE public.menu_items
  ADD CONSTRAINT fk_menu_items_image
  FOREIGN KEY (image_media_id)        REFERENCES public.media_assets (media_id);


-- =============================================================================
-- ③ RLS（§6-7 デフォルト拒否 ／ §6-1 #22）
--
--   公開範囲: **投稿者本人 ＋ staff は全件／一般会員・ゲストは「公開」のもののみ**（v13 §6）。
-- =============================================================================

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY media_assets_select_self ON public.media_assets
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY media_assets_select_staff ON public.media_assets
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- ★ 他人の投稿が見えるのは「公開」かつ未削除のものだけ（DB物理設計 §6-7 差分表 `_select_public`）。
--   論理削除を条件に入れないと、運営措置で非表示にした投稿が一般会員から見え続ける。
CREATE POLICY media_assets_select_public ON public.media_assets
  FOR SELECT TO authenticated
  USING ( visibility = '公開' AND deleted_at IS NULL );

-- 全ロール（ゲストを含む）が**自分名義で**投稿できる（v13 §5.11.7 ①）。
-- ⚠️ 他人名義の投稿を作れないよう member_id を自分に固定する。
CREATE POLICY media_assets_insert_self ON public.media_assets
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id()) );

-- 本人は自分の投稿を直せる（用途タグの追加・キャプション編集・論理削除／API設計 §2-10）。
CREATE POLICY media_assets_update_self ON public.media_assets
  FOR UPDATE TO authenticated
  USING       ( member_id = (SELECT public.current_member_id()) )
  WITH CHECK  ( member_id = (SELECT public.current_member_id()) );

-- 運営措置（他者投稿の非表示化・削除）は staff（v13 §5.11.7 ／ WBS 14-3）。
CREATE POLICY media_assets_update_staff ON public.media_assets
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。削除は `deleted_at` による論理削除である（v13 §7）。


-- =============================================================================
-- ④ GRANT（§6-6②）— 先に既定の広い権限を剥がしてから必要分だけ与える
-- =============================================================================

REVOKE ALL ON public.media_assets FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.media_assets TO authenticated;  -- 行は RLS で本人／staff

-- ⚠️ `anon` には何も与えない。未ログインからの参照は存在しない（署名付きURLが唯一の経路であり、
--    その発行はサーバ側で認可を判定してから行う／v13 §5.11.5「未認証には発行しない」）。

-- ⚠️ `service_role` からは `0101` と同じ理由で DELETE / TRUNCATE を剥がす。
--    本表は論理削除で運用するため、物理削除の経路をアプリ側に残さない。
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.media_assets FROM service_role;
