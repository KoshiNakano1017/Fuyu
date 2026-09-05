import { NextResponse } from "next/server";

// 死活監視用エンドポイント。認証不要のため、固定値のみを返し
// 内部状態・環境情報を一切含めない（CLAUDE.md §3.2 — ログ・応答に機密を出さない）
export function GET(): NextResponse {
  return NextResponse.json({ ok: true });
}
