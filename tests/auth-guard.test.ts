import { isAdmin, isStaff, type Role } from "@/lib/auth/session";
import { INVITATION_EXPIRY_HOURS } from "@/lib/auth/invitations";
import { SYSTEM_OPERATOR_MEMBER_ID } from "@/lib/auth/binding";

/**
 * 認可判定の単体テスト（CLAUDE.md §4.4「認可に関わるロジックは必ずテストを書く」）。
 *
 * DB を必要としない純粋な判定だけをここで固める。RLS・トリガーの検証は
 * `tests/db/` 側（Supabase ローカルスタックが要る）で行う。
 */

describe("isStaff（運営の定義 ／ DB物理設計 §6-2① の is_staff() と同じ）", () => {
  test("admin は運営である", () => {
    expect(isStaff("admin")).toBe(true);
  });

  test("core_member は運営である", () => {
    expect(isStaff("core_member")).toBe(true);
  });

  test("member は運営ではない", () => {
    expect(isStaff("member")).toBe(false);
  });

  test("guest は運営ではない", () => {
    expect(isStaff("guest")).toBe(false);
  });

  test("custom は運営として扱わない（権限内容が未定義のため ／ DB物理設計 §6-9⑥）", () => {
    expect(isStaff("custom")).toBe(false);
  });
});

describe("isAdmin", () => {
  test("admin だけが true", () => {
    const roles: Role[] = ["admin", "core_member", "member", "guest", "custom"];
    expect(roles.filter(isAdmin)).toEqual(["admin"]);
  });
});

describe("招待リンクの有効期限（v13 §5.2.6 ／ 2026-09-15 決定）", () => {
  test("24時間である", () => {
    expect(INVITATION_EXPIRY_HOURS).toBe(24);
  });

  test("Supabase の上限（86,400秒）を超えない", () => {
    // Email OTP Expiration は 86,400秒超をダッシュボードで設定できない。
    // ここを超える値にすると、コード上の期限と実際の期限が食い違う。
    expect(INVITATION_EXPIRY_HOURS * 60 * 60).toBeLessThanOrEqual(86_400);
  });
});

describe("システム操作者（決定B ／ 0004 マイグレーション）", () => {
  test("マイグレーションと同じ固定 UUID を参照している", () => {
    // ここがズレると、初回結合でガードトリガーが
    // 「申告された操作者が members に存在しない」で拒否する。
    expect(SYSTEM_OPERATOR_MEMBER_ID).toBe("00000000-0000-0000-0000-000000000001");
  });
});
