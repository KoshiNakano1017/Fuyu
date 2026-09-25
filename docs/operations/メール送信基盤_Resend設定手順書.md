---
title: メール送信基盤（Resend）設定手順書
description: 送信ドメインの DNS 認証から Supabase のカスタムSMTP・アプリの環境変数までを、作業順に並べた構築手順書。送信経路が2系統ある点と、片方だけ設定しても他方が動かない点を前提に構成している
doc_type: 運用
status: ドラフト
owner: プロジェクトオーナー
date: 2026-09-22
updated: 2026-09-24
version: 0.3.0
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

> [!abstract] この節だけで完結させるための要約
> **誰が**: お名前.com のアカウント保有者（§1-2 で確定させた DNS 管理者）
> **どこで**: レンタルサーバー コントロールパネル <https://cp.onamae.ne.jp/>（**お名前.com Navi ではない**）
> **何を**: レコードを **4件“追加”するだけ**。既存レコードの変更・削除は一切しない
> **所要**: 入力10分 ＋ 反映待ち15分〜最大72時間
> **戻せるか**: 追加した4件を消せば原状復帰。既存メール（`mail89.onamae.ne.jp`）には影響しない

### 3-1. 作業場所の判定 — Navi ではなくコントロールパネル

お名前.com には DNS を編集できる画面が**2つ**あり、**権威DNSとして動いている側でしか設定が効きません**。
判定は現在のネームサーバで行います。

```bash
nslookup -type=NS fuyuugai.com 8.8.8.8
```

| 返ってきた NS | 設定すべき画面 |
| --- | --- |
| **`ns-rs1.gmoserver.jp` / `ns-rs2.gmoserver.jp`** | **← 本件。レンタルサーバー コントロールパネル** |
| `01.dnsv.jp` / `02.dnsv.jp` など | お名前.com Navi の「DNSレコード設定」 |

2026-09-22 時点の実測は `ns-rs*.gmoserver.jp` なので **コントロールパネル側**です。
Navi の「DNS設定/転送設定」に入力しても**1件も反映されません**（最も多い時間の溶かし方）。

**公式手順**

- [DNSレコードを追加/編集したい（ベーシック・RSプラン）](https://help.onamae.com/answer/20311) ← **本件の正**
- [コントロールパネルへのログインについて](https://help.onamae.com/answer/20199) ／ [ログインするアカウント名とは](https://help.onamae.com/answer/20194)
- [ネームサーバー（DNS）の設定方法は？（RSプラン）](https://help.onamae.com/answer/20306)
- [（参考）Navi 側の DNSレコード設定](https://help.onamae.com/answer/14353) ← 本件では**使いません**

### 3-2. ログイン

<https://cp.onamae.ne.jp/>

- ログインIDは **お名前ID（会員ID）** か、コントロールパネル専用の**アカウント名**のどちらでも可
  （[2021-04 の仕様変更](https://www.onamae.com/news/article/11046/)）
- **ドメイン（Navi）のパスワードとサーバー（CP）のパスワードは別物**です。Navi に入れても CP には入れません

### 3-3. 投入前スナップショットを取る（切り戻し用・必須）

**触る前に現状を記録します。** §3-8 の切り戻しはこの出力が無いと成立しません。

```bash
for t in NS MX TXT A CNAME; do echo "=== $t ==="; nslookup -type=$t fuyuugai.com 8.8.8.8; done > dns-before.txt
nslookup -type=A mail.fuyuugai.com 8.8.8.8 >> dns-before.txt
cat dns-before.txt
```

CP 側も、**レコード一覧のスクリーンショットを1枚**残してください。

2026-09-22 時点で **現用のため絶対に触らないもの**:

| レコード | 値 | 用途 |
| --- | --- | --- |
| MX（ルート） | `mail89.onamae.ne.jp` | 既存メールの受信 |
| TXT（ルート） | `v=spf1 include:_spf.onamae.ne.jp ~all` | 既存メールの SPF |
| A `mail` | `160.251.71.112` | 既存メール |
| TXT（ルート） | `google-site-verification=BpMVYMO14LjzCtba3KLaqvOcfH3WIfmnFF-Z3r0JvIE` | Search Console の所有確認 |

> [!danger] SPF は「1ドメインに1本」
> ルートの TXT に **2本目の `v=spf1 ...` を追加してはいけません**。RFC 7208 違反となり、
> **既存の SPF ごと無効**になります（＝既存メールの到達性が落ちる）。
> 今回投入する4件に SPF は含まれないため、**原則として追加は不要**です。
> Resend の Records タブに `v=spf1` 行が表示されている場合は、新規追加ではなく
> **既存行への `include:` 追記**になるため、**必ずここで手を止めてオーナーに確認**してください。

### 3-4. レコード追加画面へ

CP ログイン後 → 左メニュー **「ドメイン」** → 対象ドメイン **`fuyuugai.com`** → **「DNS」/「DNSレコード設定」** → レコード一覧 → **「追加」**

入力欄はおおむね **ホスト名 / TYPE（レコードタイプ）/ VALUE（指定先）/ TTL / 優先** の5つです。

- **TTL は既定の `3600` のままでよい**
- **「優先」は MX 専用**。今回の4件では入力しません
- 画面表記は改修で変わります。食い違ったら [公式手順 20311](https://help.onamae.com/answer/20311) を正としてください

### 3-5. 投入する4件（コピペ用）

> [!warning] 正はダッシュボード。以下は 2026-09-22 時点の写しです
> ドメインを削除・再作成すると DKIM キーも CNAME も変わります。
> 作業時は <https://resend.com/domains> → `fuyuugai.com` → **Records** タブを開き、
> **そちらの値と突き合わせてから**貼ってください。

#### レコード 1/4 — DKIM（TXT）✅必須

TYPE `TXT` ／ TTL `3600` ／ 優先 なし

**ホスト名**

```
resend._domainkey
```

**VALUE**

```
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCfmTJwtyiRglbbfzggLcwPFhoaU1i26H5ffrJKPhp2kzLpeXazVPPsTLReetRHsLyG+aykIRBZfCczpFe60qnu+Bf6NwmQVHvYb1jhWcBU+vYxZogyQhAM1YbbEb/I+uAsTW7zxpyyoVL7rr7mXjXUUAnu3HScYzOXPNe3oiGcRQIDAQAB
```

- 約218文字。TXT の1文字列上限255文字に収まるので **分割不要**
- **引用符 `"` は付けない**（CP 側が自動で付けます）
- 貼り付け後、**末尾が `IDAQAB` で終わっている**ことと、前後に空白・改行が混ざっていないことを確認

#### レコード 2/4 — 送信MTA（CNAME）✅必須

TYPE `CNAME` ／ TTL `3600`

**ホスト名**

```
rsend
```

**VALUE**

```
rsend-apne1.forge.rmta.net
```

> [!danger] `rsend` に `e` は入りません
> レコード1の `resend._domainkey` と1文字違いです。**手打ち禁止・コピペのみ。**
> `partially_verified` で止まる原因の第1位がこれです。

#### レコード 3/4 — 送信MTA（CNAME）✅必須

TYPE `CNAME` ／ TTL `3600`

**ホスト名**

```
send
```

**VALUE**

```
send.forge.rmta.net
```

#### レコード 4/4 — DMARC（TXT）任意

TYPE `TXT` ／ TTL `3600`

**ホスト名**

```
_dmarc
```

**VALUE**

```
v=DMARC1; p=none;
```

**認証に必要なのは 1〜3 です。** 4 は後から足しても構いません。

> [!warning] レコード4はドメイン全体に効きます
> `_dmarc` をルートに置くと、**`@fuyuugai.com` から出る既存のメールすべて**が DMARC の評価対象に
> なります。`p=none` は監視のみで何も拒否しないため安全ですが、既存メール運用への変更である点は
> 認識しておくこと。`p=quarantine` / `p=reject` へ上げるのは、配信が安定してから。

#### ⚠️ ネット上の記事とレコードの形が違います

検索で出てくる「Resend × お名前.com」記事の多くは**旧世代の構成**を載せています。

| | ネット記事に多い旧構成 | **本件（ダッシュボード発行値）** |
| --- | --- | --- |
| SPF | `send` に `v=spf1 include:amazonses.com ~all` | **無し** |
| DKIM | `resend._domainkey.send` の CNAME | **`resend._domainkey` の TXT** |
| バウンス | `send` に MX `feedback-smtp.*.amazonses.com` | **無し** |
| 送信MTA | — | **`rsend` / `send` の CNAME（`forge.rmta.net`）** |

本件は **Tokyo リージョンの `forge.rmta.net` 系**で別物です。**記事に合わせないでください。**
迷ったら常に Resend の **Records タブが正**です。

### 3-6. 保存直後の目視チェック

4件を保存したら、レコード一覧画面で以下を**目で**確認します（§9 の再発防止項目と対応）。

- [ ] ホスト名が `resend._domainkey.fuyuugai.com.fuyuugai.com` のように**二重になっていない**
- [ ] `rsend` と `resend._domainkey` を**取り違えていない**
- [ ] CNAME の VALUE が `send.forge.rmta.net.fuyuugai.com` に**なっていない**
      → なっていたら `send.forge.rmta.net.` と**末尾ピリオド付き**で入れ直す
- [ ] DKIM の VALUE が**途中で切れていない**（末尾 `IDAQAB`）
- [ ] 既存の MX / SPF TXT / A `mail` が **`dns-before.txt` と同じ**
- [ ] 「Enable Receiving」等の**受信有効化を押していない**（押すとルートに MX が入り既存受信と競合）

### 3-7. 反映の確認

```bash
nslookup -type=TXT   resend._domainkey.fuyuugai.com 8.8.8.8
nslookup -type=CNAME rsend.fuyuugai.com             8.8.8.8
nslookup -type=CNAME send.fuyuugai.com              8.8.8.8
```

期待される出力（抜粋）:

```
resend._domainkey.fuyuugai.com  text = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCfmTJw..."
rsend.fuyuugai.com  canonical name = rsend-apne1.forge.rmta.net
send.fuyuugai.com   canonical name = send.forge.rmta.net
```

CLI を使わない担当者向け（ブラウザだけで確認できます）:

- [Google Admin Toolbox Dig](https://toolbox.googleapps.com/apps/dig/)
- [MXToolbox SuperTool](https://mxtoolbox.com/SuperTool.aspx)

反映は通常15分〜1時間、DNS 伝播の都合で最大72時間。**Verify を連打しても早くなりません。**
3件そろったら **§4-2 の Verify** へ進みます。

### 3-8. 切り戻し

追加した4件を CP から**削除**するだけで原状復帰します。

1. CP のレコード一覧から、`resend._domainkey` / `rsend` / `send` / `_dmarc` の4件を削除
2. §3-3 の `dns-before.txt` と突き合わせ、**既存3件（MX / SPF TXT / A `mail`）が投入前と一致**することを確認
3. Resend 側は `unverified` に戻るだけで、課金・アカウントへの影響はありません

### 3-9. 入力時の落とし穴（まとめ）

| # | 落とし穴 | 対策 |
| --- | --- | --- |
| 1 | `rsend` に `e` を入れて `resend` にしてしまう | 手打ち禁止。§3-5 のブロックからコピペ |
| 2 | ホスト名に `.fuyuugai.com` を付けて二重になる | **相対指定**。保存後に一覧で最終形を目視（§3-6） |
| 3 | CNAME の値に自ドメインが後置される | `send.forge.rmta.net.` と**末尾ピリオド付き**で入力 |
| 4 | DKIM を分割してしまう | 約218文字。**255文字以内なので分割不要** |
| 5 | 既存の MX / SPF / A を編集してしまう | §3-3 で現用レコードを確認してから着手 |
| 6 | ルートに2本目の SPF を追加してしまう | **SPF は1ドメイン1本**。追記が必要ならオーナー確認（§3-3） |
| 7 | 「Enable Receiving」を押す | 本件は**送信専用**。押さない |
| 8 | Navi の「DNS設定」に入力して効かない | NS が `ns-rs*.gmoserver.jp` なら **CP 側**（§3-1） |
| 9 | ネット記事の旧レコード構成を混入させる | Records タブが正（§3-5 の比較表） |

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

> [!note] 2026-09-24 追記: `main` にマージ済みです
> 旧記載の「`main` に未マージ」は誤りでした。`src/lib/mail/resend.ts` は `main` に存在します
> （確認: `git rev-parse --abbrev-ref HEAD` ＝ `main` で当該ファイルを検出）。ブランチを分ける必要はありません。

### 6-1. ローカル

```bash
cp .env.example .env
```

```
RESEND_API_KEY=<§2-2 の app-reserve キー>
RESEND_FROM_EMAIL=no-reply@fuyuugai.com
MAIL_FROM_ADDRESS=浮遊街アプリ <no-reply@fuyuugai.com>
```

> [!warning] 送信元の変数が2つあります（2026-09-24 調査）
> `src/lib/mail/resend.ts` の**関数ごとに読む変数名が違います**。
>
> | 関数 | 用途 | 読む変数 | 未設定のとき |
> | --- | --- | --- | --- |
> | `sendReservationOtpMail()` | 公開予約OTP | **`RESEND_FROM_EMAIL`** | 既定値なし → `not_configured` で静かに失敗 |
> | `sendPlainTextEmail()` | 招待の案内メール | `MAIL_FROM_ADDRESS` | 既定値へ落ちる |
>
> `RESEND_FROM_EMAIL` は `.env.example` に項目自体がありませんでした（同日追加済み）。
> `sendPlainTextEmail()` 側も `MAIL_FROM_ADDRESS` → `RESEND_FROM_EMAIL` → 既定値の順に
> 見るよう同日修正しましたが、**両方入れておくのが確実**です。

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

### 7-1. `fuyugai.jp` → `fuyuugai.com` ✅ 2026-09-24 完了

正本 `docs/spec/CONSOLIDATED_DECISIONS.md` §16-2 を直してから派生へ反映する。
**実測は6ファイル15箇所**（当初見積り「12箇所」より3箇所多い）。加えて**コード2ファイル**も誤記していた。

| ファイル | 箇所 | 状態 |
| --- | --- | --- |
| `docs/spec/CONSOLIDATED_DECISIONS.md`（正本） | 5 | ✅ 訂正注記つきで修正 |
| `QUESTIONS.md` | 4 | ✅ |
| `docs/spec/basic-design/infra/システムアーキテクチャ.md` | 2 | ✅ |
| `docs/spec/detailed-design/API設計.md` | 2 | ✅ |
| `docs/spec/detailed-design/非機能要件詳細.md` | 1 | ✅ |
| `docs/spec/WBS_Phase1.md` | 1 | ✅ |
| **`src/lib/mail/resend.ts`** | 2 | ✅ **送信元の既定値が未登録ドメインだった** |
| **`.env.example`** | 1 | ✅ |
| `docs/spec/OLD/2026-08-22_..._OLD.md` | 1 | ⏭️ OLD のため意図的に据え置き |

```
docs/spec/CONSOLIDATED_DECISIONS.md            ← 正本
docs/spec/detailed-design/API設計.md            §2-2b
docs/spec/detailed-design/非機能要件詳細.md
docs/spec/basic-design/infra/システムアーキテクチャ.md
docs/spec/WBS_Phase1.md
QUESTIONS.md
docs/spec/OLD/2026-08-22_..._OLD.md            ← 誤記の出どころ。OLD なので修正しない
```

### 7-2. `scripts/check-env.mjs` に RESEND 検査を追加 ✅ 2026-09-24 完了（**方式を変更**）

> [!danger] 当初案（`errors.push`）は採用しませんでした
> 本節は当初、`VERCEL_ENV === "production"` のとき `errors.push` でビルドを落とす案でした。
> **これは `check-env.mjs` 冒頭の警告と正面から衝突します。**
>
> `RESEND_API_KEY` は §6-2 のとおり Vercel へ **Secret（Sensitive）型**で登録します。
> Sensitive 型の値は**ビルドへ渡りません**。したがって「正しく設定されていてもビルド時には
> `null` に見える」ため、必須にすると**設定が正しいのにビルドが落ちます**。
> これは 2026-09-21 に本番を全滅させた事故と**同じ型**です
> （`SUPABASE_SERVICE_ROLE_KEY` を必須にして起きた）。
>
> よって **`warnings.push` で実装**しました。

```js
// ★ RESEND_* も実行時のみ使う。**エラーにしてはならない**（SUPABASE_SERVICE_ROLE_KEY と同じ理由）。
if (read("RESEND_API_KEY") === null) {
  warnings.push("RESEND_API_KEY がビルド時には見えません。Vercel の Secret 型なら正常なことがあります。…");
}

if (read("RESEND_FROM_EMAIL") === null) {
  warnings.push("RESEND_FROM_EMAIL がビルド時には見えません。…");
}
```

> [!caution] 警告では §6-3 の穴は塞ぎきれません
> 警告はビルドログに変数名を残すだけで、**ビルドは通ります**。
> 「未設定でも緑のまま通る」構造自体は残ります。完全に塞ぐには実行時のヘルスチェック
> （例: 管理画面に送信基盤の疎通状態を出す）が必要です。**未対応**（§10 #5）。

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

> [!note] DNS 入力まわりは §3-9 が正本
> 下表の 1〜2 は要約です。実作業時は **§3-9 の9項目**を見てください。

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
| 1 | SPF/DKIM の DNS 設定担当者 | ✅ **解消**（2026-09-24 にオーナーが投入・認証完了） |
| 2 | 送信元アドレスのローカル部（`no-reply@` で確定か） | 仮決め |
| 3 | ルートドメイン運用か、サブドメインへ分離するか | ルートで着手。到達性が落ちたら再検討 |
| 4 | レート制限 **F-7** の確定値 | §5-2 の実測待ち |
| 5 | `RESEND_*` 未設定の実行時検知 | **未対応**。§7-2 は警告どまりで、ビルドは緑のまま通る |

> [!note] ルート運用にした場合のリスク
> `fuyuugai.com` は既存メール（`mail89.onamae.ne.jp`）と評判を共有します。予約OTPは打ち間違い
> アドレス宛のバウンスが出やすく、それが既存メールの到達性に波及しうる。問題が出たら
> `mail.fuyuugai.com` 等のサブドメインへ移すこと（Resend 公式もサブドメインを推奨）。

---

## 改訂履歴

| 版 | 日付 | 変更内容 |
| --- | --- | --- |
| 0.1.0 | 2026-09-22 | 新規作成。ドメイン誤記（`fuyugai.jp` → `fuyuugai.com`）の調査結果を反映 |
| 0.3.0 | 2026-09-24 | DNS認証完了を反映。§7-1（6ファイル15箇所＋コード2ファイル）と §7-2 を実施。§7-2 はエラー案が 2026-09-21 の事故を再演するため警告方式へ変更。§6 の「main 未マージ」誤記を訂正し、送信元変数が `RESEND_FROM_EMAIL` / `MAIL_FROM_ADDRESS` に割れている問題を追記 |
| 0.2.0 | 2026-09-24 | §3 を作業単位に再構成（3-1〜3-9）。コントロールパネルのログインURL・メニュー経路・入力欄名を追記、レコード4件をコピペ可能な形に分解、投入前スナップショットと切り戻し手順を新設、SPF重複と旧レコード構成混入の注意を追加 |
