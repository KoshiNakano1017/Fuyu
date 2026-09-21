// 公開予約ページの本人確認コード（WBS 3-5b ／ 画面ID `/reserve`）。
//
// 根拠: v13 §5.2.3 TO-BE②（送信前にメールOTPで本人確認）・§5.8.3（名寄せの初回紐付け）、
//       `0022_reservation_otps.sql`。
//
// ★ **service_role を使う。** `reservation_otps` は RLS のポリシーを1本も持たず
//   （＝全拒否）、`anon` にも `authenticated` にも GRANT していない。
//   未ログインの相手のための表なので、触れるのはサーバ側だけである。
//   ⚠️ **この経路を増やさない。** 触る場所が増えるほど、どこかが平文コードを
//   ログへ出す確率が上がる（CLAUDE.md §3.2）。

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/** コードの有効期限。短命にするのは総当たりの試行回数を絞るため（v13 §5.2.3②）。 */
export const OTP_EXPIRY_MINUTES = 10;

/** 1つのコードに許す検証回数。超えたら消費済みとして捨てる。 */
export const OTP_MAX_ATTEMPTS = 5;

/** 同一アドレスへの再送を絞る窓（分）。既定SMTP の 2通/時 制約とは別の、総当たり対策である。 */
export const OTP_RESEND_WINDOW_MINUTES = 1;

/**
 * 6桁コードを作る。
 *
 * ★ `Math.random()` を使わない。予測可能な乱数でコードを作ると、
 * 発行時刻から候補を絞り込めてしまう。`randomInt` は暗号論的乱数を使う。
 * 桁数を6にしているのは会員ログインの OTP（`LoginForm.tsx` の `maxLength={6}`）と
 * 利用者の体験を揃えるためである（v13 §5.2.6）。
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * コードのハッシュ。**平文は保存しない**（`0022` の設計）。
 *
 * ソルトを持たないのは、コードが6桁・10分で失効する短命の値であり、
 * かつ**アドレスごとに1行しか生きていない**ため、総当たりの手間が
 * ソルトの有無でほとんど変わらないからである。守っているのは
 * 「DB が流出しても、その時点で生きているコードが読めない」ことである。
 */
export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** ハッシュの比較。長さが同じ16進文字列どうしを定数時間で比べる。 */
function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type IssueOtpResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; reason: "too_frequent" | "failed" };

/**
 * コードを発行して保存する。**送信はしない**（呼び出し側が Resend へ渡す）。
 *
 * 発行と送信を分けているのは、送信に失敗したときに
 * 「保存されたのに届いていないコード」を作らないためではなく、逆である。
 * **先に保存する。** 送信が成功したのに保存に失敗すると、
 * 利用者の手元にあるコードが永久に通らない。順序はこちらが安全側である。
 */
export async function issueReservationOtp(email: string): Promise<IssueOtpResult> {
  const normalized = email.trim().toLowerCase();
  if (normalized === "") {
    return { ok: false, reason: "failed" };
  }

  const admin = createAdminSupabaseClient();

  // 再送の絞り込み。短い窓で何度も送らせると、メール到達性（送信ドメインの評価）も落ちる
  const since = new Date(Date.now() - OTP_RESEND_WINDOW_MINUTES * 60_000).toISOString();
  const { data: recent } = await admin
    .from("reservation_otps")
    .select("otp_id")
    .eq("email", normalized)
    .gte("created_at", since)
    .limit(1);

  if (recent !== null && recent.length > 0) {
    return { ok: false, reason: "too_frequent" };
  }

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000).toISOString();

  const { error } = await admin.from("reservation_otps").insert({
    email: normalized,
    code_hash: hashOtpCode(code),
    expires_at: expiresAt,
  });

  if (error) {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, code, expiresAt };
}

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "too_many_attempts" | "mismatch" };

/**
 * コードを検証し、合っていれば消費済みにする。
 *
 * ## 失敗の理由を利用者へそのまま返さない
 *
 * 戻り値では理由を分けているが、**画面には同じ文面を出す**こと。
 * 「そのアドレスにはコードが発行されていない」と返すと、
 * どのアドレスが予約手続き中かを総当たりで調べられる
 * （`requestLoginCode`（`src/app/login/actions.ts`）が同じ理由で文面を統一している）。
 *
 * ## 試行回数を先に増やす
 *
 * 照合の前に `attempt_count` を進める。照合後に増やすと、
 * 照合で例外が出た経路だけ回数が増えず、そこを突くと無限に試せる。
 */
export async function verifyReservationOtp(email: string, code: string): Promise<VerifyOtpResult> {
  const normalized = email.trim().toLowerCase();
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("reservation_otps")
    .select("otp_id, code_hash, expires_at, attempt_count, consumed_at")
    .eq("email", normalized)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: "not_found" };
  }

  const row = data as {
    otp_id: string;
    code_hash: string;
    expires_at: string;
    attempt_count: number;
  };

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  if (row.attempt_count >= OTP_MAX_ATTEMPTS) {
    // 使い切った行を消費済みにして、以降この行では試せなくする
    await admin
      .from("reservation_otps")
      .update({ consumed_at: new Date().toISOString() })
      .eq("otp_id", row.otp_id);
    return { ok: false, reason: "too_many_attempts" };
  }

  await admin
    .from("reservation_otps")
    .update({ attempt_count: row.attempt_count + 1 })
    .eq("otp_id", row.otp_id);

  if (!hashesMatch(row.code_hash, hashOtpCode(code.trim()))) {
    return { ok: false, reason: "mismatch" };
  }

  await admin
    .from("reservation_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("otp_id", row.otp_id);

  return { ok: true };
}
