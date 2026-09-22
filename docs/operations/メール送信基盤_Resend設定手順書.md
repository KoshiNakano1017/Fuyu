---
title: メール送信基盤（Resend）設定手順書
description: 送信ドメインの DNS 認証から Supabase のカスタムSMTP・アプリの環境変数までを、作業順に並べた構築手順書。送信経路が2系統ある点と、片方だけ設定しても他方が動かない点を前提に構成している
doc_type: 運用
status: ドラフト
owner: プロジェクトオーナー
date: 2026-09-22
updated: 2026-09-22
version: 0.1.0
tags:
  - 浮遊街アプリ
  - メール送信
  - Resend
  - Supabase Auth
  - DNS
  - 構築手順
---

# メール送信基盤（Resend）設定手順書

> [!info] この手順書の立ち位置
> **正本は [[Projects/fuyuugai-app/docs/spec/CONSOLIDATED_DECISIONS.md|CONSOLIDATED_DECISIONS]] §16-2 です。**
> ここは「何を決めたか」ではなく「**どの画面で何を押すか**」だけを作業順に並べたものです。
> 方針が食い違ったら正本が勝ちます。

> [!danger] このリポジトリは public です
> APIキー・SMTPパスワードの**実値をこのファイルに書かないこと**（`CLAUDE.md` §3）。
> 実値の置き場所は `.env`（gitignore 済み）と Vercel / Supabase のダッシュボードだけです。

---

## 0. 前提

### 0.1 送信経路は2系統ある（最重要）

同じ Resend アカウント・同じ送信ドメインを使いますが、**呼び出す側が別物**です。
**片方だけ設定しても、他方は動きません。**

| | 経路① 会員系 | 経路② 公開予約 |
| --- | --- | --- |
| 送るもの | 招待リンク、ログインOTP、パスワードリセット | `/reserve` の本人確認コード |
| 実装 | Supabase Auth (GoTrue) | 自前（`reservation_otps`） |
| 送信を起こすコード | `src/lib/auth/invitations.ts`<br>`admin.auth.admin.inviteUserByEmail()` | `src/lib/mail/resend.ts`<br>`sendReservationOtpMail()` |
| **Resend の配線先** | **Supabase ダッシュボードに SMTP 資格情報** | **環境変数 `RESEND_API_KEY` / `RESEND_FROM_EMAIL`** |
| 本文テンプレート | Supabase の Email Templates | `resend.ts` 内に直書き |

**→ Supabase のダッシュボード設定だけでは公開予約は動きません。**

### 0.2 確定している事実（2026-09-22 調査）

| 項目 | 値 | 確認方法 |
| --- | --- | --- |
| 送信ドメイン | **`fuyuugai.com`** | RDAP |
| レジストラ | GMO Internet Group d/b/a Onamae.com（IANA ID 49） | Verisign RDAP |
| ドメイン有効期限 | **2026-11-13** | RDAP |
| ネームサーバ | `ns-rs1.gmoserver.jp` / `ns-rs2.gmoserver.jp`（RSプラン側） | NS レコード |
| 既存メール | `mail89.onamae.ne.jp`（稼働中・触らない） | MX レコード |
| 既存 SPF | `v=spf1 include:_spf.onamae.ne.jp ~all`（触らない） | TXT レコード |
| Resend 登録ドメイン | `fuyuugai.com`（ルート） | Resend ダッシュボード |

再現コマンド:

```bash
curl -s https://rdap.verisign.com/com/v1/domain/fuyuugai.com   # 登録情報（レジストラ・期限）
nslookup -type=NS  fuyuugai.com 8.8.8.8
nslookup -type=MX  fuyuugai.com 8.8.8.8
nslookup -type=TXT fuyuugai.com 8.8.8.8
```

> [!warning] 仕様書の `fuyugai.jp` は誤記
> 正本を含む6ファイル12箇所に `fuyugai.jp` と書かれていますが、**このドメインは未登録**です
> （JPRS WHOIS で「該当するデータがありません」）。誤記は `docs/spec/OLD/2026-08-22_..._OLD.md` の
> `support@fuyugai.jp` という記載1件から決定文書へ引き写されたものです。§7 で修正します。

### 0.3 無料枠

**月3,000通・かつ1日100通**（2026-09-22 時点。要実機確認）。超過時は Pro $20/月。

> [!caution] 日次キャップが先に効く
> 平常運転（収容66名）は収まりますが、**370名への一括招待は往復約740通で超過します**。
> 段階的な現地登録を維持する前提を崩さないこと。

### 0.4 自動化の可否

| 工程 | 実行者 |
| --- | --- |
| §1 事前確認 | ✋ 人間（オーナー／DNS管理者） |
| §2 Resend 設定 | 🤖 エージェント可（Full access キーが必要） |
| **§3 DNS レコード投入** | **✋ 人間のみ**（お名前.com に公開APIが無い） |
| §4〜§7 | 🤖 エージェント可 |

---

## 1. 事前確認（ブロッカー）

着手前に3点を確定させること。**ここが通らないと §3 で止まります。**

1. **送信ドメインは `fuyuugai.com` でよいか** — オーナー確認。§7 の12箇所修正を伴う
2. **DNS 管理者は誰か** — お名前.com のアカウント保有者。レコード4件の追加を依頼できるか
3. **ドメインの自動更新は有効か** — 2026-11-13 期限。失効するとサイト・既存メール・Resend が同時に止まる

---

## 2. Resend の設定（🤖）

### 2-1. ドメインを追加

https://resend.com/domains → **Add Domain**

- ドメイン名: `fuyuugai.com`
- リージョン: **Tokyo (ap-northeast-1)**
- 入力欄には**ドメイン名だけ**を入れる。`https://`・末尾スラッシュ・メールアドレス・全角文字はすべて弾かれる

### 2-2. APIキーを2本発行

https://resend.com/api-keys

| 名前 | 権限 | 用途 |
| --- | --- | --- |
| `supabase-smtp` | Sending access | 経路①（§5 で使用） |
| `app-reserve` | Sending access | 経路②（§6 で使用） |

**2本に分ける理由**: 片方を失効・ローテーションしても他方が止まらないようにするため。
1本にすると、予約OTPのキーを回した瞬間に会員ログインも止まる。

> [!danger] キーは発行直後にしか表示されない
> Resend は発行後の再表示ができません。その場で `.env` / ダッシュボードへ入れること。

---

## 3. DNS レコード投入（✋ 手作業）

### 3-1. 作業場所

ネームサーバが `ns-rs*.gmoserver.jp` なので、**お名前.com Navi の「DNS設定」ではなく
レンタルサーバー（RSプラン）のコントロールパネル**側です。

- [DNSレコードを追加/編集したい（RSプラン）](https://help.onamae.com/answer/20311)
- [DNSレコードの設定方法は？](https://help.onamae.com/answer/14353)

### 3-2. 入れるレコード

> [!warning] 以下は 2026-09-22 時点の発行値
> ドメインを削除・再作成すると DKIM キーも CNAME も変わります。
> **必ずダッシュボードの Records タブの値を正としてください。**

| # | Type | Name | Content | 必須 |
| --- | --- | --- | --- | :---: |
| 1 | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCfmTJwtyiRglbbfzggLcwPFhoaU1i26H5ffrJKPhp2kzLpeXazVPPsTLReetRHsLyG+aykIRBZfCczpFe60qnu+Bf6NwmQVHvYb1jhWcBU+vYxZogyQhAM1YbbEb/I+uAsTW7zxpyyoVL7rr7mXjXUUAnu3HScYzOXPNe3oiGcRQIDAQAB` | ✅ |
| 2 | CNAME | `rsend` | `rsend-apne1.forge.rmta.net` | ✅ |
| 3 | CNAME | `send` | `send.forge.rmta.net` | ✅ |
| 4 | TXT | `_dmarc` | `v=DMARC1; p=none;` | 任意 |

**認証に必要なのは 1〜3 です。** 4 は後から足しても構いません。

> [!warning] レコード4はドメイン全体に効く
> `_dmarc` をルートに置くと、**`@fuyuugai.com` から出る既存のメールすべて**が DMARC の評価対象に
> なります。`p=none` は監視のみで何も拒否しないため安全ですが、既存メール運用への変更である点は
> 認識しておくこと。`p=quarantine` / `p=reject` へ上げるのは、配信が安定してから。

### 3-3. 入力時の落とし穴

1. **`rsend` に `e` は入らない** — レコード1の `resend._domainkey` と別物。手打ちせず必ずコピペ
2. **ホスト名は相対指定** — `resend._domainkey` とだけ入れる。`.fuyuugai.com` を付けると
   `resend._domainkey.fuyuugai.com.fuyuugai.com` になる。保存後に一覧で最終形を目視すること
3. **CNAME の末尾ピリオド** — 値が `send.forge.rmta.net.fuyuugai.com` になる場合は
   `send.forge.rmta.net.` と末尾ピリオド付きで入力
4. **DKIM は分割不要** — 約218文字で TXT の1文字列上限255文字に収まる
5. **既存レコードを触らない** — ルートの `MX mail89.onamae.ne.jp`、`TXT v=spf1 include:_spf.onamae.ne.jp ~all`、
   `mail.fuyuugai.com` の A レコード（`160.251.71.112`）はすべて現用
6. **「Enable Receiving」は押さない** — 本件は送信専用。押すとルートに MX が入り既存の受信と競合する

---

## 4. 検証（🤖）

### 4-1. DNS の反映確認

```bash
nslookup -type=TXT   resend._domainkey.fuyuugai.com 8.8.8.8
nslookup -type=CNAME rsend.fuyuugai.com             8.8.8.8
nslookup -type=CNAME send.fuyuugai.com              8.8.8.8
```

### 4-2. Resend で Verify

https://resend.com/domains → **Verify**

- 通常15分ほど。DNS 伝播で最大72時間かかることがある
- CNAME 方式は**レコードごとに独立して検証**されるため、片方だけ通って `partially_verified` で
  止まることがある。その場合は §3-3 の落とし穴1（`rsend` の綴り）を最初に疑う
- 通らないとき: [Resend トラブルシュート](https://resend.com/docs/knowledge-base/what-if-my-domain-is-not-verifying)

---

## 5. Supabase の設定 ＝ 経路①（🤖）

### 5-1. カスタムSMTP

**Authentication → Emails → SMTP Settings**
（[Supabase 公式](https://supabase.com/docs/guides/auth/auth-smtp) ／ [Resend 側の手順](https://resend.com/docs/send-with-supabase-smtp)）

```
Host:         smtp.resend.com
Port:         465            # 暗黙SSL/TLS。587 / 2587 は STARTTLS
Username:     resend
Password:     <§2-2 の supabase-smtp キー>
Sender email: no-reply@fuyuugai.com
Sender name:  浮遊街
```

### 5-2. レート制限

**Authentication → Rate Limits**

既定SMTP は 2通/時、カスタムSMTP 設定後の初期値は **30通/時**。ここから必要値へ引き上げる。

> [!caution] 設定後に必ず実測すること
> 設定したレート制限が期待どおり適用されない旨の公開Issue報告（supabase/auth #2333 等）があります。
> 非機能要件 **F-7** の値は、この実測値をもって確定させること。

### 5-3. OTP 有効期限

**Authentication → Providers → Email → Email OTP Expiration**

`src/lib/auth/invitations.ts` の `INVITATION_EXPIRY_HOURS = 24` と揃える。
**86,400秒（24時間）超はダッシュボードで設定できない**（Management API のみ）。

### 5-4. メールテンプレート

**Authentication → Email Templates**
（[公式](https://supabase.com/docs/guides/auth/auth-email-templates)）

`inviteUserByEmail()` が使うのは **「Invite user」テンプレート**。日本語化するならここ。

### 5-5. API から一括設定する場合

[`PATCH /v1/projects/{ref}/config/auth`](https://supabase.com/docs/reference/api/v1-update-auth-service-config)
で `smtp_host` / `smtp_port` / `smtp_user` / `smtp_pass` / `smtp_admin_email` / `smtp_sender_name` /
`rate_limit_email_sent` / `mailer_otp_exp` をまとめて設定できる。
必要権限は `auth_config_write` ＋ `project_admin_write`。

---

## 6. アプリの設定 ＝ 経路②（🤖）

> [!warning] ブランチに注意
> Resend の実装（`src/lib/mail/resend.ts`）は **`main` に未マージ**です。
> 作業は `fix/reserve-nodejs-runtime` / `feature/2-1d-2-7-auth-impl` 等で行うこと。

### 6-1. ローカル

```bash
cp .env.example .env
```

```
RESEND_API_KEY=<§2-2 の app-reserve キー>
RESEND_FROM_EMAIL=no-reply@fuyuugai.com
```

### 6-2. Vercel

```bash
vercel env add RESEND_API_KEY production
vercel env add RESEND_FROM_EMAIL production
# preview 環境にも同様に（PRプレビューで /reserve を試すなら必須）
```

**型の判断**: `RESEND_*` は `NEXT_PUBLIC_` 接頭辞が無く**実行時にしか読まれない**ため、
**Secret 型（Sensitive）で問題ない**。`CLAUDE.md` §6.3 が禁じているのは `NEXT_PUBLIC_*` を
Sensitive にすることだけ（2026-09-21 障害の原因）。

登録後は**再デプロイ**が必要。

### 6-3. ⚠️ ビルドチェックは Resend を見ていない

`scripts/check-env.mjs`（`prebuild` で自動実行）の検査対象は `NEXT_PUBLIC_SUPABASE_*` と
`SUPABASE_SERVICE_ROLE_KEY` のみで、**`RESEND_*` は一切チェックしていない**。

したがってキーを入れ忘れても:

- ビルドは**緑のまま通る**
- Vercel も **Ready と表示する**
- `/reserve` で OTP を送ろうとした瞬間に `sendReservationOtpMail` が `not_configured` を返し、
  `console.error` だけ残して**静かに失敗する**

これは `check-env.mjs` 冒頭が「2026-09-21 に実際に起きた」と記録している障害と**同じ型**である。
§7-2 で塞ぐこと。

---

## 7. リポジトリ側の修正（🤖）

### 7-1. `fuyugai.jp` → `fuyuugai.com`（6ファイル12箇所）

正本 `docs/spec/CONSOLIDATED_DECISIONS.md` §16-2 を直してから派生へ反映する。

```
docs/spec/CONSOLIDATED_DECISIONS.md            ← 正本
docs/spec/detailed-design/API設計.md            §2-2b
docs/spec/detailed-design/非機能要件詳細.md
docs/spec/basic-design/infra/システムアーキテクチャ.md
docs/spec/WBS_Phase1.md
QUESTIONS.md
docs/spec/OLD/2026-08-22_..._OLD.md            ← 誤記の出どころ。OLD なので修正しない
```

### 7-2. `scripts/check-env.mjs` に RESEND 検査を追加

```js
if (isVercelProduction) {
  if (read("RESEND_API_KEY") === null) {
    errors.push("RESEND_API_KEY が未設定です（公開予約の本人確認コードが送れません）");
  }
  if (read("RESEND_FROM_EMAIL") === null) {
    errors.push("RESEND_FROM_EMAIL が未設定です");
  }
}
```

`VERCEL_ENV === "production"` のときだけ必須にすれば CI は赤くならない。

---

## 8. 動作確認の順序

1. Resend の [Domains](https://resend.com/domains) が `verified` であること
2. **経路①** — 運営画面から招待を1通送る → 届くこと
3. **経路②** — `/reserve` から本人確認コードを1通送る → 届くこと

②だけ失敗する場合、原因は `RESEND_FROM_EMAIL` が未設定か、認証済みドメイン外のアドレス。

| 確認先 | 見るもの |
| --- | --- |
| https://resend.com/emails | 配信ログ（30日保持）。Delivered / Bounced / Complained |
| `vercel logs <デプロイURL>` | `[reserve]` のエラー。**HTTPステータスのみ**（宛先・コード本文は出さない設計） |
| Supabase → Auth Logs | 経路①の送信結果 |

> [!note] テスト用アドレス
> `delivered@resend.dev` / `bounced@resend.dev` / `complained@resend.dev` 宛に送ると、
> 配信成功・バウンス・苦情の挙動を検証できる（[公式](https://resend.com/docs/dashboard/emails/send-test-emails)）。
> DNS 認証を待つ間の実装検証に使える。

---

## 9. 既知の落とし穴（再発防止）

| # | 落とし穴 | 対策 |
| --- | --- | --- |
| 1 | `rsend` と `resend._domainkey` の取り違え | コピペのみ。手打ち禁止 |
| 2 | ホスト名に `.fuyuugai.com` を付けて二重になる | 保存後に一覧で最終形を目視 |
| 3 | Supabase だけ設定して公開予約が動かない | §0-1 の2系統表を毎回確認 |
| 4 | `RESEND_*` 未設定でも**ビルドが緑のまま通る** | §7-2 で `check-env.mjs` に追加 |
| 5 | `NEXT_PUBLIC_*` を Sensitive 型で登録 | `CLAUDE.md` §6.3。`RESEND_*` は該当しない |
| 6 | 370名への一括招待で日次100通を超過 | 段階的な現地登録を維持する |
| 7 | ドメイン失効（2026-11-13） | 自動更新と支払い方法を確認 |

---

## 10. 未決事項

| # | 論点 | 状態 |
| --- | --- | --- |
| 1 | SPF/DKIM の DNS 設定担当者 | **未指名**（仕様書3ファイルに同じ注記） |
| 2 | 送信元アドレスのローカル部（`no-reply@` で確定か） | 仮決め |
| 3 | ルートドメイン運用か、サブドメインへ分離するか | ルートで着手。到達性が落ちたら再検討 |
| 4 | レート制限 **F-7** の確定値 | §5-2 の実測待ち |

> [!note] ルート運用にした場合のリスク
> `fuyuugai.com` は既存メール（`mail89.onamae.ne.jp`）と評判を共有します。予約OTPは打ち間違い
> アドレス宛のバウンスが出やすく、それが既存メールの到達性に波及しうる。問題が出たら
> `mail.fuyuugai.com` 等のサブドメインへ移すこと（Resend 公式もサブドメインを推奨）。

---

## 改訂履歴

| 版 | 日付 | 変更内容 |
| --- | --- | --- |
| 0.1.0 | 2026-09-22 | 新規作成。ドメイン誤記（`fuyugai.jp` → `fuyuugai.com`）の調査結果を反映 |
