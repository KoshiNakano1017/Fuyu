// 公開予約ページの本人確認コード（WBS 3-5b ／ Issue #107）の純関数部分の受入テスト。
//
// DB を要する発行・検証（`issueReservationOtp` / `verifyReservationOtp`）は
// service_role を使うためここでは扱わない。ここで固定するのは
// **コードの作り方とハッシュの性質**であり、これが崩れると総当たりが容易になる。
//
// 根拠: v13 §5.2.3②、`0022_reservation_otps.sql`、CLAUDE.md §3.2（ログに値を出さない）。

import {
  generateOtpCode,
  hashOtpCode,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
} from "@/lib/reservations/otp";

describe("generateOtpCode", () => {
  test("6桁である（会員ログインの OTP と桁数を揃える）", () => {
    expect(generateOtpCode()).toHaveLength(6);
  });

  test("数字だけで構成される", () => {
    expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  // 先頭が 0 のコードを文字列として扱えていないと、`012345` が `12345` になって
  // 5桁のコードが利用者へ届く。padStart を外すと落ちる試験である。
  test("先頭が0でも6桁を保つ", () => {
    const codes = Array.from({ length: 300 }, () => generateOtpCode());
    expect(codes.every((code) => code.length === 6)).toBe(true);
  });

  test("毎回同じ値にならない", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("hashOtpCode", () => {
  test("同じコードからは同じハッシュになる", () => {
    expect(hashOtpCode("123456")).toBe(hashOtpCode("123456"));
  });

  test("違うコードからは違うハッシュになる", () => {
    expect(hashOtpCode("123456")).not.toBe(hashOtpCode("123457"));
  });

  // ★ 平文を保存しないことが `0022` の設計の要。ハッシュの中にコードが
  //   そのまま現れていないことを固定する。
  test("ハッシュにコードの平文が含まれない", () => {
    expect(hashOtpCode("123456")).not.toContain("123456");
  });

  test("sha256 の16進64桁である", () => {
    expect(hashOtpCode("123456")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("総当たりを抑える定数", () => {
  test("有効期限は短命である（v13 §5.2.3② の「数分」）", () => {
    expect(OTP_EXPIRY_MINUTES).toBeLessThanOrEqual(15);
  });

  test("1つのコードで試せる回数に上限がある", () => {
    expect(OTP_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
