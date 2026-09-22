import { NextResponse } from "next/server";

import { isStaff, readViewer } from "@/lib/auth/session";
import { submitLodgingRegisterEntry } from "@/lib/lodging/register";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * `POST /api/checkins/{id}/lodging-register` — 宿泊者名簿の登録・確定
 * （`API設計.md` §3-5 ／ v13 §5.2.7）。`{id}` は `check_ins.checkin_id`。
 *
 * ⚠️ **本エンドポイントの認可を本人に広げない。** `lodging_register_entries` の
 * INSERT/UPDATE は staff（`admin` / `core_member`）限定であり、これは意図的である
 * （API設計.md §3-5 の warning）。旅館業法対応の法定記録を宿泊者自身の自己申告のみで
 * 確定させると、記録の正確性の担保（本人確認）が失われる。
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return NextResponse.json({ error: "この操作を行う権限がありません。" }, { status: 403 });
  }

  const body = await readJsonBody(request);
  if (body === null) {
    return NextResponse.json({ error: "リクエストの形式が不正です。" }, { status: 400 });
  }

  const { id: checkinId } = await context.params;

  const result = await submitLodgingRegisterEntry({
    checkinId,
    recordedByMemberId: viewer.memberId,
    fullNameConfirmed: body.full_name_confirmed === true,
    fullNameSnapshot: typeof body.full_name_snapshot === "string" ? body.full_name_snapshot : "",
    fullNameKanaSnapshot:
      typeof body.full_name_kana_snapshot === "string" ? body.full_name_kana_snapshot : null,
    address: typeof body.address === "string" ? body.address : "",
    previousLocation: typeof body.previous_location === "string" ? body.previous_location : "",
    nextDestination: typeof body.next_destination === "string" ? body.next_destination : null,
  });

  if (result.ok) {
    return NextResponse.json({ entryId: result.entryId }, { status: result.created ? 201 : 200 });
  }

  const VALIDATION_REASONS = new Set([
    "full_name_not_confirmed",
    "full_name_blank",
    "address_blank",
    "previous_location_blank",
  ]);

  if (VALIDATION_REASONS.has(result.reason)) {
    return NextResponse.json({ error: "入力内容を確認してください。" }, { status: 422 });
  }
  if (result.reason === "checkin_not_found") {
    return NextResponse.json({ error: "指定されたチェックインが見つかりません。" }, { status: 404 });
  }
  if (result.reason === "denied") {
    return NextResponse.json({ error: "この操作を行う権限がありません。" }, { status: 403 });
  }
  return NextResponse.json({ error: "登録に失敗しました。時間をおいて再試行してください。" }, { status: 500 });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
