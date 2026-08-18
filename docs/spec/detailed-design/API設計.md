---
title: "詳細設計：API設計（Phase 1）"
date: "2026-08-16"
status: "詳細設計ドラフト（要オーナーレビュー）"
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
| べき等性 | Webhook系（宿泊予約フォーム連携等）は外部からの再送に備え、`idempotency_key`または送信元の一意ID（フォーム回答ID等）で重複作成を防止する |

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
| POST | `/api/reservations/webhook` | 宿泊予約フォーム送信トリガー（**ドラフト保留・§9 #30参照**） | システム間（署名検証） | `check_ins`（`pre_registered`） |
| POST | `/api/checkins` | チェックイン（QR/画面タップ） | core_member, admin, 本人 | `check_ins` |
| PATCH | `/api/checkins/{id}/checkout` | チェックアウト | core_member, admin, 本人 | `check_ins`, `stay_ticket_transactions`（consume） |
| DELETE | `/api/checkins/{id}` | 予約キャンセル・ノーショー（論理削除、理由必須） | core_member, admin | `check_ins`, `room_assignments` |
| POST | `/api/checkins/{id}/room-assignments` | 部屋割当 | core_member, admin | `room_assignments` |
| PATCH | `/api/room-assignments/{id}/move` | 部屋移動（既存終了＋新規追加） | core_member, admin | `room_assignments` |
| GET | `/api/rooms?status=available` | 空き部屋一覧 | core_member, admin | `rooms` |
| GET | `/api/admin/stay-calendar` | 宿泊予定カレンダー（**ドラフト保留**） | core_member, admin | `check_ins`×`room_assignments`×`rooms` |

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
| PATCH | `/api/work-logs/{id}/approve` | 日次承認／差戻し | admin, core_member | `work_logs`, `uii_transactions`(Phase2), `members.earned_xp` |

### 2-5. 注文管理・会計

| メソッド | パス | 概要 | 認可 | 対応DB |
| --- | --- | --- | --- | --- |
| POST | `/api/orders` | 注文作成（セルフ／代理、チェックイン中限定） | 本人, core_member, admin | `orders`, `order_items` |
| PATCH | `/api/orders/{id}/items/{itemId}` | 明細編集（単価上書き含む、理由必須） | admin, core_member | `order_items` |
| POST | `/api/orders/{id}/settlement-qr` | 精算QR発行（即時／一括） | 本人, admin, core_member | `orders.settlement_qr_token` |
| POST | `/api/orders/{id}/settlement-adjustments` | 差額計上（追加請求/返金） | admin, core_member | `settlement_adjustments` |
| PATCH | `/api/settlement-adjustments/{id}` | 精算／免除（**免除権限範囲は要確認**） | admin（core_memberの可否は未確認） | `settlement_adjustments` |
| PATCH | `/api/checkout/{id}/toggle-soldout` | SOLDOUTトグル | core_member, admin | 商品マスタ（別途要定義） |

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
| POST | `/api/media` | アップロード完了通知＋用途タグ登録（AI解析を非同期トリガー） | 全員（本人のみ） | `media_assets` |
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

### 3-4. 宿泊予約フォーム連携 Webhook（ドラフト・未確定）

```yaml
paths:
  /api/reservations/webhook:
    post:
      summary: "【ドラフト・未確定】Googleフォーム送信をトリガーに予約を自動生成する想定のWebhook"
      description: >
        v13 §5.2.3（未コミット）に基づく暫定案。備考欄の空判定基準（§9 #30-③）・
        旅館業法必須項目の収集方式（§9 #30-③②）が未確定のため、リクエストスキーマは
        確定していない。以下は参考イメージ。
      requestBody:
        content:
          application/json:
            schema:
              type: object
              description: "確定次第、正式スキーマに置き換える"
              properties:
                form_response_id: { type: string, description: "べき等性キー" }
                guest_name: { type: string }
                room_type_requested: { type: string, description: "現行フォームは4択。運用実態6種との差分は§9 #30-②参照" }
                remarks: { type: string, nullable: true, description: "空/非空でauto_confirm判定（基準未確定）" }
      responses:
        "202":
          description: 受理（実際の確定/要確認判定ロジックは未実装）
```

---

## 4. Webhook・外部トリガー一覧

| # | トリガー元 | 用途 | 状態 |
| --- | --- | --- | --- |
| 1 | Googleフォーム（Apps Script経由 or 直接） | 宿泊予約の自動反映 | ドラフト保留（§9 #30） |
| 2 | Eumo（将来） | Uii/Eumo同期（Phase2、非同期キャッシュ方式） | Phase2スコープ外 |
| ~~3~~ | ~~line-rag-bot~~ | ~~ナレッジCRUD連携~~ | **API連携なし（2026-08-16再確定）**：line-rag-botとのWebhook/API連携は一切存在しない。ナレッジ登録・エスカレーション閲覧は全てline-rag-bot Streamlit管理画面で完結（外部連携設計.md §2参照） |

---

## 5. オーナー確認事項まとめ

| # | 内容 | 関連QUESTIONS.md項目 |
| --- | --- | --- |
| ~~1~~ | ~~`PATCH /api/settlement-adjustments/{id}`の免除操作をcore_memberにも許すか~~ | ✅解消済み（2026-08-16）：Phase1はコアメンバーにも許可 |
| ~~2~~ | ~~`POST /api/reservations/webhook`の正式スキーマ確定~~ | ✅5/5点回答済み（2026-08-16）。正式スキーマ化は次回サイクルで実施 |
| ~~3~~ | ~~`GET /api/admin/stay-calendar`のレスポンス粒度~~ | ✅解消済み（2026-08-16）：Googleカレンダーと同等の操作感 |
| ~~4~~ | ~~line-rag-bot連携APIの認証方式（APIキー／署名検証等）~~ | ✅解消済み（2026-08-16）：Streamlit継続決定により、REST API実装自体が当面不要に。将来API化する際の課題として引き継ぎ |

---

## 改訂履歴

| 日付 | 内容 |
| --- | --- |
| 2026-08-16 | 初版作成。DB物理設計・画面設計を踏まえ、9機能領域・約35エンドポイントを一覧化。主要4エンドポイント（街人登録承認・注文明細編集・AIコンシェルジュ質問・宿泊予約Webhook）はOpenAPI風yamlで詳細化。宿泊予約フォーム連携関連は未コミットドラフトのため確定スキーマとせず「参考イメージ」に留めた。 |
| 2026-08-16（追記） | オーナー回答（ナレッジ・RAG基盤をline-rag-botへ統合、アプリ内チャットUIなし）を反映。
`POST /api/ai/ask`を削除（§3-3へ参考記録として移動）、`/api/knowledge`系をline-rag-bot APIへの
プロキシとして再定義、`GET /api/escalations`を新設。差額繰越・宿泊予約フォーム連携・カレンダー粒度の
オーナー確認事項を解消済みへ更新。 |
| 2026-08-16（重要変更） | **Streamlit継続方針の確定反映**（2026-08-16オーナー最終判断）。ナレッジ登録・編集は当面line-rag-bot Streamlit で行い、REST API は実装しない決定を反映。§2-6の`POST /api/knowledge`・`PATCH /api/knowledge/{id}/publish`・`POST /api/escalations/{id}/resolve`を削除。`GET /api/escalations`のみ読み取り専用として残す。§5のオーナー確認事項 #4 を「解消済み」に変更。 |
| 2026-08-16（再確定） | **`GET /api/escalations`も削除**。読み取り専用APIも含めてline-rag-bot連携APIは一切実装しない方針が確定（オーナー最終判断）。§2-6を全面書き換えし、本領域のエンドポイントをゼロ件に。§4 Webhook一覧の line-rag-bot 行を「API連携なし」に変更。 |
| 2026-08-16（オーナー指示反映） | ①**呼称変更**：§2-6見出しの説明文をline-rag-bot単独表記から「浮遊街コンシェルジュ（line-rag-bot）」表記に統一。②**§2-7 会員一括インポートAPI（`preview`/`confirm`）を実装不要に変更**：画面設計.md C6と連動。③**§2-10 メディアライブラリAPIを新設**：`POST /api/media/signed-upload-url`等6エンドポイント。画面設計.md A10・DB物理設計.md §3-7と連動。 |
