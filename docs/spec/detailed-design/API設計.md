---
title: "詳細設計：API設計（Phase 1）"
doc_type: 設計
status: "詳細設計ドラフト（要オーナーレビュー）"
owner: プロジェクトオーナー
date: "2026-08-16"
updated: 2026-09-05
tags: ["浮遊街アプリ"]
up: "[[浮遊街アプリ 総合要件定義・設計書_v13]]"
---

# API設計（Phase 1）

> 本書は `docs/spec/detailed-design/DB物理設計.md`・`画面設計.md` を踏まえ、両者をつなぐAPI層を
> 設計するドキュメントである。**実装コードではなく設計書**であり、一部はOpenAPI形式のyaml断片で
> 記述するが、これは仕様の明確化のためであって、実際のサーバー実装ではない。

---

## 1. 設計方針

| 項目 | 方針 |
| --- | --- |
| API方式 | Next.js API Routes（Vercel） ＋ Supabase Edge Function の併用。単純なCRUD（一覧・詳細取得）は**Supabase クライアントからRLS越しに直接アクセス**し、独自APIを作らない。ビジネスロジックを伴う操作（承認処理・QR発行・トリガー処理・RAG検索・ロール昇格等）のみ専用エンドポイントを設ける |
| 認証 | Supabase Auth のセッショントークン（JWT）をAuthorizationヘッダで送信。全エンドポイントで検証必須 |
| 認可 | サーバー側で`role`に基づく認可を必ず行う（正本§5.9.3の不可侵ルール）。RLSと二重に効かせる（Edge Function側の認可はRLSを迂回する`service_role`使用時の代替であり、必須） |
| 命名規則 | リソース指向のREST（`/api/{resource}/{id}/{sub-resource}`）。一覧は複数形、作成は`POST`、部分更新は`PATCH` |
| 共通レスポンス | 成功時 `{ data, meta }`、エラー時 `{ error: { code, message } }`。HTTPステータスコードと併用 |
| 監査ログ | 顧客管理画面の伝票編集・宿泊日数調整・免除操作等、**理由入力必須の操作は全て`operator_id`＋`reason`をリクエストボディ必須項目とする**（正本§5.6.4の編集理由必須ルールをAPI層でも強制） |
| べき等性 | ~~Webhook系（宿泊予約フォーム連携等）は外部からの再送に備え、`idempotency_key`または送信元の一意ID（フォーム回答ID等）で重複作成を防止する~~ → **2026-08-23：宿泊予約フォーム連携の廃止（§9 #46）により、外部からの再送を前提とするべき等性制御は不要**。公開予約ページは OTP セッショントークン単位で二重送信を抑止する |


### 1-1. `anon` ロールの権限は原則ゼロとする（2026-09-05 オーナー決定 ／ 非機能 F-9）

> [!important] 原則: **ブラウザの `anon` キーに、テーブル・ビュー・関数の権限を与えない**
> 上表の原則①により、**トラフィックの相当部分は Vercel を通らず Supabase へ直接届く**。
> この経路には Vercel WAF が効かないため、**`anon` ロールの権限を削り込むこと自体が、
> 直アクセス経路に対する実質的なファイアウォールになる**。

`anon` キーは `NEXT_PUBLIC_` でクライアントJSへ埋め込まれる**公開情報**であり、秘密として守ることはできない。
しかし **`anon` で読めるものが何も無ければ、キーが公開されていること自体は問題にならない。**
「キーを隠す」のではなく「**キーが開いても、その先に何も開かない状態にする**」ことで攻撃面を消す。

**本書のエンドポイント設計は、この原則を既に満たしている。**

| 経路 | `anon` のテーブル権限 | 根拠 |
| --- | --- | --- |
| 公開予約フロー（§2-2b `/api/public/*`） | **不要** | サーバ側 `service_role` 経由で処理する設計（§2-2b の警告ボックス） |
| 未認証の残枠・料金表示（`/api/public/availability`・`/api/public/rates`） | **不要** | 同じくサーバ側で読む。ブラウザは Vercel の API を叩く |
| 認可「全員」のエンドポイント（`/api/quests`・`/api/menu-items`・`/api/accommodation-rates`・`/api/availability`） | **不要** | 「全員」は**全ロール**の意味であり未認証ではない。上表「認証：全エンドポイントで検証必須」のとおり **JWT 必須**。未認証向けには別途 `/api/public/*` を設けており、**この分離自体が認証必須である傍証**にあたる |
| メディア（§2-10） | **不要** | 認可は「本人」。実体は GCS（署名付きURL） |
| Supabase Storage | **不要** | 使用しない（メディアは Cloud Storage for Firebase へ一本化） |

> [!note] DDL はここに書かない
> **`GRANT` / `REVOKE` の具体的な DDL は `DB物理設計.md` §6 に記載する。**
> 本書は「どのエンドポイントが `anon` を必要としないか」という**API 設計側の根拠**だけを扱う。
> 防御構成の全体像（3前線）は `basic-design/infra/システムアーキテクチャ.md`
> 「ネットワーク層の防御 → ★ 採用する構成」を正とする。

> [!warning] ⚠️ 「`anon` 権限ゼロ」と「`anon` キーの廃止」は別物
> `anon` キーは **Supabase Auth（GoTrue）を呼ぶ際の `apikey` ヘッダとして必須**であり、
> サインアップ・ログイン・パスワードリセットには引き続き必要である。
> ここで削るのは **PostgREST 経由で到達できるテーブル・ビュー・関数の権限**であって、キーそのものではない。

> [!warning] ⚠️ 要確認（実装着手前に確定させること）
> 1. **未ログインの `/reserve` が残枠を Realtime で購読する設計なのか**。
>    v13 §5.2.5 は残枠の表示箇所に `/reserve`（未ログイン）を挙げ、更新手段を「Supabase Realtime で即時反映」と
>    書いている。字義どおりなら **`anon` に権限が必要**になる。本書の設計意図は
>    **`GET /api/public/availability` によるサーバ取得**であり、`anon` は不要という前提に立つ。**明記が無いため要確定**
> 2. **`/reserve` の実装がクライアントSDKで `v_room_availability` を直接読まないこと**を実装レビューで確認する

### 1-2. 監査ログ方針（上表）と保管設計の関係（2026-09-05 追記）

上表の**監査ログ**の行（理由入力必須の操作は `operator_id` ＋ `reason` を必須項目とする）は、
**「何を記録するか」を API 層で強制するルール**である。**この方針は変更しない。**

2026-09-05 のオーナー決定により、**「記録したものをどこへ・どれだけ置くか」**が別途定まった。

| 観点 | 定める場所 |
| --- | --- |
| **何を記録するか**（入口） | **本書 §1 の監査ログ方針**（`operator_id` ＋ `reason` の必須化） |
| **どこへ・どれだけ置くか**（保管） | `basic-design/infra/システムアーキテクチャ.md`「**監査ログの保管構成**」 |

要点のみ再掲する（詳細は同節を正とする）:

- **長期保管の正本は GCS 側**。運用画面から参照する直近分のみ Postgres に置く
- **10年保存（非機能 A6）は GCS の Retention Policy ＋ Bucket Lock（WORM）で担保する**
- **⚠️ Postgres の外に出た時点で RLS は効かない。** GCS 上の監査ログのアクセス制御は **GCP IAM** に移る
- 🚫 **監査ログと AI対話履歴を `line-rag-bot` のナレッジ空間へ投入してはならない**
  （v13 §9 #61 の個人情報ガードが未決のため）

> [!warning] ⚠️ 新規論点: A6 の「AI対話履歴」は本書のエンドポイント設計上、**本体 DB に存在しない**
> §2-6 のとおり**浮遊街アプリ本体はアプリ内AIチャットUIを持たず、当該領域のエンドポイントはゼロ件**である。
> AI との対話は `line-rag-bot`（LINE Webhook・Firestore）側で発生するため、
> **A6 を満たすにはエクスポート元が2系統になる**（Supabase ／ Firestore）。
> **②の経路は本書にも他のどの設計文書にも存在しない。** `QUESTIONS.md` へ起票済み。

---
---

## 2. エンドポイント一覧

### 2-1. 認証・アカウント

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| POST | `/api/members/link-identifier` | 現地での電話番号入力→`is_verified=true`化（名寄せ確定） | core_member, admin | `member_identifiers` |
| GET | `/api/members/me` | 自分の会員情報取得 | 本人 | `members` |

### 2-2. 予約・宿泊管理

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| ~~POST~~ | ~~`/api/reservations/webhook`~~ | ~~宿泊予約フォーム送信トリガー~~ → ❌ **廃止（2026-08-23 ／ v13 §9 #46）**：Googleフォームを廃止し公開予約ページへ置換したため、Webhook 自体が不要になった（§3-4 参照） | — | — |
| POST | `/api/checkins` | チェックイン（QR/画面タップ） | core_member, admin, 本人 | `check_ins` |
| PATCH | `/api/checkins/{id}/checkout` | チェックアウト | core_member, admin, 本人 | `check_ins`, `stay_ticket_transactions`（consume） |
| DELETE | `/api/checkins/{id}` | 予約キャンセル・ノーショー（論理削除、理由必須） | core_member, admin | `check_ins`, `room_assignments` |
| POST | `/api/checkins/{id}/room-assignments` | 部屋割当 | core_member, admin | `room_assignments` |
| PATCH | `/api/room-assignments/{id}/move` | 部屋移動（既存終了＋新規追加） | core_member, admin | `room_assignments` |
| GET | `/api/rooms?status=available` | 空き部屋一覧 | core_member, admin | `rooms` |
| GET | `/api/admin/stay-calendar` | 宿泊予定カレンダー（**2026-08-20：ドラフト保留を解除**。§9 #30-⑤ 決着によりGoogleカレンダー同等の操作感で確定）。**2026-08-23：日別の食数サマリー（朝/昼/夜）を含める**（v13 §5.4.1b） | core_member, admin | `check_ins`×`room_assignments`×`rooms`×`meal_reservations` |

### 2-3. 朝会・議事録・クエスト自動起案

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| POST | `/api/morning-meetings` | 録音終了→音声アップロード起点（Gemini連携をサーバ側で実行） | admin | `morning_meetings` |
| GET | `/api/morning-meetings/{id}` | 議事録・クエスト候補の取得 | admin, core_member | `morning_meetings` |
| POST | `/api/morning-meetings/{id}/quest-candidates/{idx}/publish` | クエスト候補をボードへ公開 | admin | `quests` |

### 2-4. クエスト管理

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| GET | `/api/quests` | クエスト一覧（`guest_allowed`でフィルタ） | 全員 | `quests` |
| POST | `/api/quests` | クエスト新規作成（手動） | admin, core_member | `quests` |
| POST | `/api/quests/{id}/applications` | 受注申請 | member, guest（`guest_allowed=true`のみ） | `quest_applications` |
| PATCH | `/api/quest-applications/{id}/review` | 審査・実行指示 | admin, core_member | `quest_applications` |
| POST | `/api/quest-applications/{id}/work-logs` | 完了報告（Before/After写真必須） | 申請者本人 | `work_logs` |
| ~~PATCH~~ | ~~`/api/work-logs/{id}/approve`~~ | ~~日次承認／差戻し~~ | **2026-08-20：二段階化により分割**（下記2本＋差戻し） | ― |
| PATCH | `/api/work-logs/{id}/review` | **コアメンバー確認**（`報告済み → コアメンバー確認済`）。1人目の確認で遷移し、2人目以降は `work_log_reviews` へ追加記録 | admin, core_member | `work_logs.reviewed_by/at`, `work_log_reviews` |
| PATCH | `/api/work-logs/{id}/approve` | **最終承認**（`コアメンバー確認済 → 承認完了`）。確定Uii額を入力し、**同時に `eumo_grants` を起票**。`報告済み` から直接呼ぶことも可（その場合 `review_skipped=true`） | **admin のみ** | `work_logs.approved_by/at`, `eumo_grants`, `members.earned_xp` |
| PATCH | `/api/work-logs/{id}/reject` | 差戻し（理由必須）。いずれのステージからも可 | admin, core_member | `work_logs.rejected_*` |

### 2-4b. Eumo給付の送付・受領追跡（2026-08-20 新設 ／ v13 §5.3.1・§9 #35）

| メソッド | パス | 概要 | 権限 | 主な対象テーブル |
| --- | --- | --- | --- | --- |
| GET | `/api/eumo-grants?status=未送付` | 給付一覧（「誰にいくら」を確定表示）。ステータス別タブ | admin, core_member | `eumo_grants` |
| POST | `/api/eumo-grants/{id}/send` | 送付用リンクを発行し登録アドレスへ送付。**送付日時・送付者・送付先を記録** | admin, core_member | `eumo_grants`（`未送付 → 送付済`） |
| PATCH | `/api/eumo-grants/{id}/confirm-receipt` | **受領確認（手動）**。EUMO API連携はPhase 2のため自動検知しない | admin, core_member | `eumo_grants`（`送付済 → 受領確認済`） |
| GET | `/api/eumo-grants/stale` | `送付済` のまま14日超の滞留一覧 | admin, core_member | `eumo_grants` |

> **`send` と `confirm-receipt` を1本のAPIにまとめないこと。** 送付と受領は別の事実であり、
> 統合すると「送ったが届いていない」給付が検出できなくなる（v13 §5.3.1）。

### 2-5. 注文管理・会計

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| POST | `/api/orders` | 注文作成（セルフ／代理、チェックイン中限定） | 本人, core_member, admin | `orders`, `order_items` |
| PATCH | `/api/orders/{id}/items/{itemId}` | 明細編集（単価上書き含む、理由必須） | admin, core_member | `order_items` |
| POST | `/api/orders/{id}/settlement-qr` | 精算QR発行（即時／一括） | 本人, admin, core_member | `orders.settlement_qr_token` |
| POST | `/api/orders/{id}/settlement-adjustments` | 差額計上（追加請求/返金） | admin, core_member | `settlement_adjustments` |
| PATCH | `/api/settlement-adjustments/{id}` | 精算／免除（**免除権限範囲は要確認**） | admin（core_memberの可否は未確認） | `settlement_adjustments` |
| PATCH | `/api/orders/{id}/serving-status` | **提供ステータス切替**（未提供 ⇄ 提供済み）。**決済ステータスとは独立**。Realtime で客側へ即時反映（2026-08-20 新設／§9 #39） | core_member, admin | `orders.serving_status/served_at/served_by` |
| GET | `/api/orders?serving_status=未提供` | 厨房の作業待ち行列（B1カンバン用） | core_member, admin | `orders` |
| GET | `/api/orders/paid-unserved` | **「精算済みだが未提供」の要注意一覧**（2026-08-20 新設） | core_member, admin | `orders` |
| PATCH | `/api/menu-items/{id}/toggle-soldout` | SOLDOUTトグル（**コアメンバーも可**） | core_member, admin | `menu_items.is_sold_out` |

### 2-5b. マスタ管理（カフェメニュー／宿泊料金）（2026-08-20 新設 ／ v13 §5.4.2・§9 #40）

| メソッド | パス | 概要 | 権限 | 主な対象テーブル |
| --- | --- | --- | --- | --- |
| GET | `/api/menu-items` | メニュー一覧（客用は `is_published=true` のみ） | 全員 | `menu_items` |
| POST | `/api/menu-items` | メニュー登録。**Uii価格は受け取らない**（`floor(単価×0.8)` で都度算出） | **admin のみ** | `menu_items` |
| PATCH | `/api/menu-items/{id}` | メニュー編集（価格・表示順・公開フラグ・有効期間） | **admin のみ** | `menu_items` |
| GET | `/api/accommodation-rates?date=YYYY-MM-DD` | 指定日に適用される宿泊料金（6形態 × 会員区分） | 全員 | `accommodation_rates` |
| POST | `/api/accommodation-rates` | 料金改定。**既存行を上書きせず適用期間を区切って追加**（期間重複は `EXCLUDE` 制約で拒否） | **admin のみ** | `accommodation_rates` |

### 2-2b. 宿泊予約（公開ページ／アプリ内）・残枠（2026-08-20 新設 ／ **2026-08-23 改訂** ／ v13 §5.2.3・§5.2.4・§5.2.5・§9 #36・#37・#46）

| メソッド | パス | 概要 | 権限 | 主な対象テーブル |
| --- | --- | --- | --- | --- |
| GET | `/api/availability?from=&to=&room_type=` | **宿泊枠の残数**（`v_room_availability` から都度算出。保存値ではない） | 全員 | `v_room_availability` |
| POST | `/api/reservations` | **アプリ内予約**。氏名・連絡先・住所は会員マスタから自動補完。備考欄が空なら自動確定、記載があれば「要確認」 | `active` の全ロール | `check_ins`（`reservation_source='in_app'`） |
| GET | `/api/me/stay-calendar` | **本人の宿泊予定・履歴カレンダー** | 本人 | `check_ins`×`room_assignments` |

**★ 公開予約ページ関連（2026-08-23 新設 ／ v13 §5.2.3 ／ §9 #46）**

| メソッド | パス | 概要 | 権限 | 主な対象テーブル |
| --- | --- | --- | --- | --- |
| POST | `/api/public/reservations/otp` | **メールOTPの発行**。予約送信の前段で本人確認を行う（v13 §5.8.3 の本人確認要件を予約時点で満たす） | **公開（未認証）** | `reservation_otps`（短命・TTL付き） |
| POST | `/api/public/reservations/otp/verify` | OTP検証。成功時に**短命の予約セッショントークン**を返す | **公開（未認証）** | — |
| POST | `/api/public/reservations` | **公開予約ページからの予約作成**。OTP検証済みトークン必須。備考欄が空なら自動確定、記載があれば「要確認」 | **公開（未認証・要OTP）** | `check_ins`（`reservation_source='web_public'`）, `meal_reservations` |
| GET | `/api/public/availability?from=&to=` | 未認証で参照できる残枠。**非会員料金**で表示する | **公開（未認証）** | `v_room_availability` |
| GET | `/api/public/rates` | 宿泊料金・送迎料金の公開表示（Uii 主・円 副） | **公開（未認証）** | `accommodation_rates`, `menu_items` |
| POST | `/api/reservations/{id}/meals` | 事前予約注文の登録・変更（滞在日別・朝/昼/夜／**任意**） | 本人, core_member, admin | `meal_reservations` |
| GET | `/api/admin/meal-summary?date=` | **日別の食数サマリー**（仕込み数量の把握用） | core_member, admin | `meal_reservations` |

> [!warning] 公開エンドポイントは anon キーで直接DBを触らせない
> `/api/public/*` は未認証で到達できるため、**クライアントから Supabase へ直接 INSERT させてはならない**。
> Server Action / Route Handler の内部で `service_role` を用い、サーバ側でのみ書き込む（`CLAUDE.md` §3.2）。
> anon キーに `check_ins` の INSERT 権限を与えると、**RLS の緩みがそのまま個人情報テーブルへの書き込み口**になる。
>
> あわせて必須の防御：**Cloudflare Turnstile**（ボット対策）、**レート制限**（同一メール24時間3件・同一IP単位）、
> OTP の**試行回数制限と短いTTL**。フォーム時代は検証手段が無く、架空の予約で枠が埋まっても検知できなかった。

### 2-6. FAQ・ナレッジ・RAG

> [!success] 2026-08-16再確定：本領域のエンドポイントはゼロ件（API連携なし）
> ナレッジ・RAG基盤は浮遊街コンシェルジュ（line-rag-bot、Firestore）へ統合済み。ナレッジの
> 「登録・編集」、「未回答エスカレーションの閲覧・代理回答」は**すべて**浮遊街コンシェルジュの
> Streamlit管理画面で完結させ、浮遊街アプリ本体から浮遊街コンシェルジュを呼び出すREST APIは
> **一切実装しない**（読み取り専用APIも含めて不採用。外部連携設計.md §2-2参照）。
> `~~POST /api/ai/ask~~`（アプリ内検索・回答生成）も不要（旧仕様は §3-3 に参考記録）。
> 浮遊街アプリ側の対応は管理画面（B9/C5）から浮遊街コンシェルジュ管理画面への外部リンク実装のみ
> （API不要）。

| メソッド | パス | 概要 | 認可 | 対応先 |
| --- | --- | --- | --- | --- |
| ~~POST~~ | ~~`/api/knowledge`~~ | ~~ナレッジ登録（4ステップフォーム送信）~~ | **削除（2026-08-16）**：Streamlit継続のため、REST API不要。管理画面（B9/C5）から Streamlit への外部リンクで対応 | ― |
| ~~PATCH~~ | ~~`/api/knowledge/{id}/publish`~~ | ~~`review_status`変更~~ | **削除（2026-08-16）**：同上 | ― |
| ~~`POST /api/ai/ask`~~ | ~~AIコンシェルジュへの質問~~ | **削除（2026-08-16）**：アプリ内チャットUIを持たないため不要。案内はLINE（line-rag-bot自身のWebhook）で完結 | ― | ― |
| ~~GET~~ | ~~`/api/escalations`~~ | ~~未回答エスカレーション一覧の取得~~ | **削除（2026-08-16再確定）**：読み取り専用APIも不採用。line-rag-bot Streamlit管理画面で直接閲覧する運用に統一 | ― |
| ~~POST~~ | ~~`/api/escalations/{id}/resolve`~~ | ~~エスカレーション解消・代理回答登録~~ | **削除（2026-08-16）**：line-rag-bot Streamlitで対応 | ― |

### 2-7. 既存街人データ移行・名寄せ

> [!note] 2026-08-16：一括インポートAPIは実装不要（画面設計.md C6と連動）
> C6画面（会員データ一括インポート）が実装不要になったため、以下の`preview`/`confirm`エンドポイントも
> 不要。初期移行はVault側`01_schema.sql`で完了済みで、以後の会員追加はA1（通常のオンボーディング）
> 経由のみを前提とする。

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| ~~POST~~ | ~~`/api/admin/members/import/preview`~~ | ~~インポートCSVの列マッピング・プレビュー~~ | **不要（2026-08-16）** | ― |
| ~~POST~~ | ~~`/api/admin/members/import/confirm`~~ | ~~インポート確定~~ | **不要（2026-08-16）** | ― |
| PATCH | `/api/members/{id}/stay-days` | 宿泊日数の手動増減（理由必須） | admin | `stay_ticket_transactions`(`staff_adjust`) |

### 2-10. メディアライブラリ（画面設計.md A10、2026-08-16新設）

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| POST | `/api/media/signed-upload-url` | Cloud Storage for Firebaseへの署名付きアップロードURL発行 | 全員 | ― |
| POST | `/api/media` | 用途タグ・メタデータ登録（AI解析を非同期トリガー）。**アップロード完了の確定は本APIではなくGCS Object Finalizeイベントが起点**（クライアント通知に依存しない・v13 §5.11.2） | 全員（本人のみ） | `media_assets` |
| PATCH | `/api/media/{id}/purpose` | 用途タグの追加・変更（AI再解析を非同期トリガー） | 本人 | `media_assets` |
| GET | `/api/media?purpose=instagram&sort=relevance` | 用途タグでの絞り込み・適合度順取得 | 本人（自分のアップロード分のみ） | `media_assets` |
| PATCH | `/api/media/{id}/caption` | AIキャプション案の編集・確定 | 本人 | `media_assets` |
| DELETE | `/api/media/{id}` | 削除 | 本人 | `media_assets` |

> [!warning] 非機能要件・オーナー確認事項（画面設計.md §6 #5〜#7と同一論点）
> AI解析（Gemini）は`POST /api/media`のレスポンスをブロックしない非同期処理とする（`ai_processing_status`
> で進捗管理、DB物理設計.md §3-7参照）。コスト・レイテンシの見積り、動画サムネイル生成方式、
> 肖像権チェックの要否は未確認のまま。

### 2-8. ゲスト→街人アップグレード

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| POST | `/api/membership-applications` | 申請（決済情報は含めない） | guest | `membership_applications` |
| POST | `/api/membership-applications/{id}/issue-qr` | 決済QR発行・送付 | admin | `membership_applications` |
| POST | `/api/membership-applications/{id}/approve` | 入金確認・承認（ロール昇格＋特典付与を1トランザクションで実行） | admin | `membership_applications`, `members.role`, `stay_ticket_transactions`(`plan_grant`) |

### 2-9. 管理者ダッシュボード

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/dashboard-summary` | 本日のKPI集計 | admin | 各テーブルの集計 |
| GET | `/api/admin/outstanding-stay-tickets` | 未使用宿泊券残高（経営報告用） | admin | `v_outstanding_stay_tickets`（DB物理設計参照） |

---

## 3. 主要エンドポイントの詳細（OpenAPI風スニペット）

### 3-1. 街人登録：承認処理（ロール昇格のトリガー）

```yaml
paths:
  /api/membership-applications/{id}/approve:
    post:
      summary: 街人登録申請の承認（入金確認後）。ロール昇格と特典付与を同時に行う
      security: [{ supabaseAuth: [] }]
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string, format: uuid }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [operator_id]
              properties:
                operator_id: { type: string, format: uuid, description: "承認操作者（admin）" }
                note: { type: string }
      responses:
        "200":
          description: 承認成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      application_id: { type: string, format: uuid }
                      member_id: { type: string, format: uuid }
                      new_role: { type: string, example: "member" }
                      granted_nights: { type: integer, example: 4 }
                      granted_uii_cashback: { type: integer, example: 5000, description: "Phase1はExcel手動記録のためシステム上は参考値" }
        "409":
          description: 既に承認済み、または`payment_confirmed_by`未設定（入金未確認）
```

### 3-2. 顧客管理：注文明細編集（理由必須ルールの反映）

```yaml
paths:
  /api/orders/{id}/items/{itemId}:
    patch:
      summary: 注文明細の編集（単価上書き・数量変更）。理由入力を必須とする
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [operator_id, edit_reason]
              properties:
                unit_price_yen: { type: integer }
                quantity: { type: integer }
                operator_id: { type: string, format: uuid }
                edit_reason: { type: string, minLength: 1, description: "正本§5.6.4：理由なし編集は不可" }
      responses:
        "200":
          description: 編集成功。差額（追加請求/返金）を含むレスポンス
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      order_id: { type: string, format: uuid }
                      amount_diff_yen: { type: integer, description: "正なら追加請求、負なら返金" }
                      settlement_adjustment_id:
                        type: string
                        format: uuid
                        nullable: true
                        description: "精算済み伝票の遡及編集時のみ生成される"
```

### 3-3.（削除・参考記録）AIコンシェルジュ：質問応答

> [!note] 2026-08-16削除
> 浮遊街アプリ本体はアプリ内AIチャットUIを持たない方針が確定したため、以下の`POST /api/ai/ask`は
> **不要となった**。案内はLINE（line-rag-bot自身のWebhook経路）で完結し、浮遊街アプリのAPI層を
> 経由しない。決定の経緯を追跡できるよう、当初案のスニペットを参考として残す（実装対象ではない）。

```yaml
# 不採用（参考記録）
paths:
  /api/ai/ask:
    post:
      summary: 質問に対しRAG検索→回答生成。target_roleによる事前フィルタをサーバ側で必須実行
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [question]
              properties:
                question: { type: string }
                context_tag: { type: string, example: "キッチン" }
      responses:
        "200":
          description: 回答成功、または信頼度不足によるエスカレーション
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      answer: { type: string, nullable: true }
                      confidence: { type: number }
                      sources:
                        type: array
                        items: { type: string, format: uuid }
                      escalated: { type: boolean, description: "信頼度が閾値未満の場合true。運営LINE通知をサーバ側でトリガー" }
```

### 3-4. ~~宿泊予約フォーム連携 Webhook~~ → **廃止（2026-08-23 ／ v13 §9 #46）**

> [!important] このエンドポイントは実装しない
> Googleフォームを廃止し、ログイン不要の**公開予約ページ `/reserve`** へ置き換える決定（v13 §5.2.3）により、
> **外部フォームからの Webhook 受信という経路そのものが存在しなくなった**。
> 旧ドラフトが未確定としていたリクエストスキーマ・べき等性キー・署名検証は、**確定させる必要がなくなった**。
> 詳細な廃止理由は外部連携設計.md §5 を参照。

代わりに実装するのは以下（§2-2b「公開予約ページ関連」の詳細）。

```yaml
paths:
  /api/public/reservations:
    post:
      summary: "公開予約ページからの予約作成（未認証・OTP検証済みトークン必須）"
      description: >
        v13 §5.2.3 に基づく。ログイン不要で予約でき、備考欄が完全な空欄なら自動確定、
        記載があれば「要確認」として予約担当者へ通知する（§9 #30-③ の判定基準を踏襲）。
        会員料金はログイン状態からのみ判定し、自己申告では適用しない（§5.2.3）。
      security:
        - reservationSessionToken: []   # POST /api/public/reservations/otp/verify で取得
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [guest_name, email, phone, check_in_date, check_out_date, room_type, adults_count, children_count, consent_version]
              properties:
                guest_name:      { type: string }
                email:           { type: string, format: email, description: "OTP を検証済みのアドレスと一致すること" }
                phone:           { type: string, description: "当日連絡用" }
                check_in_date:   { type: string, format: date }
                check_in_time:   { type: string, description: "到着予定時刻。案内は15:00以降" }
                check_out_date:  { type: string, format: date }
                room_type:
                  type: string
                  enum: [dormitory, cottage, campsite, car, earthbag, salon]
                  description: "v13 §5.4.2 の6形態。満室の形態はUI側で選択不可（残枠は都度算出）"
                adults_count:    { type: integer, minimum: 1, description: "高校生以上・代表者を含む" }
                children_count:  { type: integer, minimum: 0, description: "中学生以下" }
                children_ages:
                  type: array
                  items: { type: string, enum: ["0-2", "3-5", "elementary", "juniorhigh"] }
                transport:
                  type: string
                  enum: [car, taxi, shuttle, other]
                  description: "shuttle を選ぶと送迎（1,900円＝1,520Uii・片道）がチェックイン時に計上される（v13 §5.4.2③）"
                meal_reservations:
                  type: array
                  description: "カフェ事前予約注文。**任意**（未指定でも予約は成立する／v13 §5.4.1b）"
                  items:
                    type: object
                    required: [served_on, meal_slot, menu_item_id]
                    properties:
                      served_on:    { type: string, format: date, description: "滞在日。チェックイン当日を含む" }
                      meal_slot:    { type: string, enum: [breakfast, lunch, dinner] }
                      menu_item_id: { type: string, format: uuid, description: "is_pre_orderable = true の商品のみ" }
                      quantity:     { type: integer, minimum: 1 }
                consent_version: { type: string, description: "同意した「浮遊街に宿泊される方へ」の版数を記録する" }
                remarks:
                  type: string
                  nullable: true
                  description: "**完全な空欄なら自動確定**。「特になし」等の定型文言は要確認扱い（§9 #30-③）"
      responses:
        "201":
          description: 予約作成完了
          content:
            application/json:
              schema:
                type: object
                properties:
                  checkin_id: { type: string, format: uuid }
                  status:     { type: string, enum: [confirmed, needs_review], description: "備考欄の有無で分岐" }
                  matched_member_hint:
                    type: object
                    nullable: true
                    description: >
                      名寄せ候補が1件に定まった場合のみ返す。**候補が複数ある場合は返さず、運営承認キューへ回す**
                      （v13 §5.8.3 の誤名寄せ防止要件）。宿泊券・Uii残高・XPの引き継ぎはここでは行わない
        "409":
          description: 満室（送信までの間に他の予約で枠が埋まった場合）
        "429":
          description: レート制限（同一メール/IPからの過剰な予約試行）
```

> [!warning] 名寄せを予約時に「成立」させない
> OTP により**メールアドレスの本人性は確認できる**が、それだけで既存会員アカウントへ結合してはならない。
> 同姓同名・家族間での連絡先共有があり得るため、v13 §5.8.3 のとおり
> **候補が複数件ヒットした場合は自動連携せず運営承認キューへ回す**。
> 予約時点で確定させるのは**宿泊枠であって人物の同定ではない**、という切り分けを守ること。

---

## 4. Webhook・外部トリガー一覧

| # | トリガー元 | 用途 | 状態 |
| --- | --- | --- | --- |
| ~~1~~ | ~~Googleフォーム（Apps Script経由 or 直接）~~ | ~~宿泊予約の自動反映~~ | ❌ **廃止（2026-08-23 ／ §9 #46）**：フォームを廃止し公開予約ページへ置換。**Webhook・署名検証・べき等性・再送台帳のいずれも実装しない**（外部連携設計.md §5） |
| 2 | Eumo（将来） | Uii/Eumo同期（Phase2、非同期キャッシュ方式） | Phase2スコープ外 |
| ~~3~~ | ~~line-rag-bot~~ | ~~ナレッジCRUD連携~~ | **API連携なし（2026-08-16再確定）**：line-rag-botとのWebhook/API連携は一切存在しない。ナレッジ登録・エスカレーション閲覧は全てline-rag-bot Streamlit管理画面で完結（外部連携設計.md §2参照） |

---

## 5. オーナー確認事項まとめ

| # | 内容 | 関連QUESTIONS.md項目 |
| --- | --- | --- |
| ~~1~~ | ~~`PATCH /api/settlement-adjustments/{id}`の免除操作をcore_memberにも許すか~~ | ✅解消済み（2026-08-16）：Phase1はコアメンバーにも許可 |
| ~~2~~ | ~~`POST /api/reservations/webhook`の正式スキーマ確定~~ | ❌ **不要になった（2026-08-23 ／ v13 §9 #46）**：Googleフォーム廃止によりエンドポイント自体を実装しない。代わりに `POST /api/public/reservations`（§3-4）を実装する |
| ~~3~~ | ~~`GET /api/admin/stay-calendar`のレスポンス粒度~~ | ✅解消済み（2026-08-16）：Googleカレンダーと同等の操作感 |
| ~~4~~ | ~~line-rag-bot連携APIの認証方式（APIキー／署名検証等）~~ | ✅解消済み（2026-08-16）：Streamlit継続決定により、REST API実装自体が当面不要に。将来API化する際の課題として引き継ぎ |

---

## 改訂履歴

| 日付 | 内容 |
| --- | --- |
| **2026-09-05** | **§1-1（`anon` ロールの権限は原則ゼロ）と §1-2（監査ログ方針と保管設計の関係）を新設**。①非機能 **F-9**（ネットワーク層の防御）への回答として、直アクセス経路は Vercel WAF が効かないため **`anon` 権限の削り込みが実質的なファイアウォールになる**という原則を明記し、**本書のエンドポイント一覧を全件突き合わせて `anon` のテーブル権限が不要であることを検証**した（`GRANT`/`REVOKE` の DDL 本体は `DB物理設計.md` §6 が正）。②§1 の監査ログ方針（`operator_id`＋`reason` の必須化）を**変更せず**、「記録したものをどこへ・どれだけ置くか」を `システムアーキテクチャ.md`「監査ログの保管構成」へ委ねる役割分担を明記。③**A6 の「AI対話履歴」が §2-6 のとおり本体 DB に存在しない**（発生源は `line-rag-bot` 側）ことを新規論点として起票。 |
| 2026-08-28 | §2-10 `POST /api/media` の概要を正本 v13 §5.11.2 に整合させる修正。「アップロード完了通知」という表現が、正本の「完了確定はGCS Object Finalizeイベント起点・クライアント完了通知に依存しない」（非機能要件詳細.md §2-2と同旨）と食い違っていたため、本APIの役割を用途タグ・メタデータ登録に限定する記述へ改めた（正本優先ルールの適用。CLAUDE.md §1.1）。 |
| **2026-08-23** | **Googleフォーム連携の廃止と公開予約ページ化を反映（v13 §9 #46〜#49）**。①§2-2 の `POST /api/reservations/webhook` と §4 Webhook一覧 #1 を**廃止**として取消線化。②§3-4 のドラフトyamlを削除し、**`POST /api/public/reservations` の正式スキーマ**へ差し替え（宿泊形態6種のenum・送迎・**任意**の事前予約注文・同意版数・名寄せ候補の返却方針・409/429）。③§2-2b に公開予約ページ関連7エンドポイント（OTP発行/検証・公開予約作成・公開残枠・公開料金・事前予約注文・日別食数サマリー）を新設し、**anonキーで直接DBを触らせない**旨と Turnstile／レート制限／OTP試行制限を明記。④§1 のべき等性方針から外部Webhook前提の記述を撤回。⑤`GET /api/admin/stay-calendar` に日別食数サマリーを追加。⑥オーナー確認事項 #2 を「不要になった」へ更新。 |
| 2026-08-16 | 初版作成。DB物理設計・画面設計を踏まえ、9機能領域・約35エンドポイントを一覧化。主要4エンドポイント（街人登録承認・注文明細編集・AIコンシェルジュ質問・宿泊予約Webhook）はOpenAPI風yamlで詳細化。宿泊予約フォーム連携関連は未コミットドラフトのため確定スキーマとせず「参考イメージ」に留めた。 |
| 2026-08-16（追記） | オーナー回答（ナレッジ・RAG基盤をline-rag-botへ統合、アプリ内チャットUIなし）を反映。
`POST /api/ai/ask`を削除（§3-3へ参考記録として移動）、`/api/knowledge`系をline-rag-bot APIへの
プロキシとして再定義、`GET /api/escalations`を新設。差額繰越・宿泊予約フォーム連携・カレンダー粒度の
オーナー確認事項を解消済みへ更新。 |
| 2026-08-16（重要変更） | **Streamlit継続方針の確定反映**（2026-08-16オーナー最終判断）。ナレッジ登録・編集は当面line-rag-bot Streamlit で行い、REST API は実装しない決定を反映。§2-6の`POST /api/knowledge`・`PATCH /api/knowledge/{id}/publish`・`POST /api/escalations/{id}/resolve`を削除。`GET /api/escalations`のみ読み取り専用として残す。§5のオーナー確認事項 #4 を「解消済み」に変更。 |
| 2026-08-16（再確定） | **`GET /api/escalations`も削除**。読み取り専用APIも含めてline-rag-bot連携APIは一切実装しない方針が確定（オーナー最終判断）。§2-6を全面書き換えし、本領域のエンドポイントをゼロ件に。§4 Webhook一覧の line-rag-bot 行を「API連携なし」に変更。 |
| 2026-08-16（オーナー指示反映） | ①**呼称変更**：§2-6見出しの説明文をline-rag-bot単独表記から「浮遊街コンシェルジュ（line-rag-bot）」表記に統一。②**§2-7 会員一括インポートAPI（`preview`/`confirm`）を実装不要に変更**：画面設計.md C6と連動。③**§2-10 メディアライブラリAPIを新設**：`POST /api/media/signed-upload-url`等6エンドポイント。画面設計.md A10・DB物理設計.md §3-7と連動。 |
