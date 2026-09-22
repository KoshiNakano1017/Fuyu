// 公開予約（未ログイン）の確定処理。WBS 3-5b ／ 画面ID `/reserve`。
//
// 根拠: v13 §5.2.3（公開予約ページ化・§9 #46）・§5.2.4・§5.8.3（名寄せの初回紐付け）、
//       2026-09-21 オーナー決定（既定ロールは最小限＝`guest` ／ 連絡先はユーザー側の表へ）。
//
// ★ **service_role を使う。** 未ログインの相手が `members` と `check_ins` へ行を作る操作であり、
//   `anon` には GRANT が無い（0015 の方針）。RLS を迂回する経路なので、
//   **入口はこの1関数だけに保つ**（CLAUDE.md §3.2 ／ `src/lib/supabase/admin.ts` の注記）。

import { createAdminSupabaseClient } from "@/lib/supabase/admin";

import { verifyReservationOtp } from "./otp";

export type PublicReservationInput = {
  email: string;
  code: string;
  fullName: string;
  phone: string;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  arrivalTime: string;
  adultsCount: number;
  childrenCount: number;
  transportMethod: string;
  selfDeclaredMachibito: boolean;
  note: string;
  consented: boolean;
};

export type PublicReservationResult =
  | { ok: true; checkinId: string; autoConfirmed: boolean }
  | {
      ok: false;
      reason: "invalid_code" | "not_consented" | "invalid_input" | "failed";
    };

/**
 * 公開予約を確定する。
 *
 * ## 順序に意味がある
 *
 * 1. **OTP を検証する。** ここを通らない入力で会員行を作ると、他人のアドレスで
 *    会員を量産できる（v13 §5.8.3 が本人確認を必須としている理由）。
 * 2. **検証済みの連絡先から会員を探す**（名寄せの初回紐付け）。
 * 3. 見つからなければ会員を作る。**既定は最小限の権限**（2026-09-21 オーナー決定）。
 * 4. 連絡先を `member_identifiers` へ入れる。**`check_ins` には持たせない**（同決定）。
 * 5. 予約を作る。
 *
 * ## 備考が空なら自動確定（v13 §5.2.3 TO-BE④）
 *
 * 判定基準は §9 #30-③ のまま「**完全な空欄のみ**」である。空白1文字でも入っていれば
 * 要確認にする。現場の要望は「定型的な予約を人手で触らない」ことであり、
 * 何か書かれている予約は読む前提だからである。
 */
export async function createPublicReservation(
  input: PublicReservationInput,
): Promise<PublicReservationResult> {
  if (!input.consented) {
    return { ok: false, reason: "not_consented" };
  }
  if (
    input.fullName.trim() === "" ||
    input.roomType.trim() === "" ||
    input.checkOutDate <= input.checkInDate ||
    input.adultsCount + input.childrenCount < 1
  ) {
    return { ok: false, reason: "invalid_input" };
  }

  const verified = await verifyReservationOtp(input.email, input.code);
  if (!verified.ok) {
    // 理由（未発行／期限切れ／不一致）を呼び出し元へ分けて返さない。
    // 分けると、どのアドレスが手続き中かを総当たりで調べられる（`otp.ts` の注記）
    return { ok: false, reason: "invalid_code" };
  }

  const admin = createAdminSupabaseClient();
  const email = input.email.trim().toLowerCase();

  const memberId = await findOrCreateMember(admin, { email, fullName: input.fullName.trim() });
  if (memberId === null) {
    return { ok: false, reason: "failed" };
  }

  await upsertContact(admin, memberId, "email", email, true);
  if (input.phone.trim() !== "") {
    // 電話は OTP を通していないので未検証のまま入れる（`uq_identifier_verified` の対象外）
    await upsertContact(admin, memberId, "phone", input.phone.trim(), false);
  }

  // ★ 「完全な空欄のみ」自動確定（v13 §9 #30-③）。trim して空かどうかで見る
  const autoConfirmed = input.note.trim() === "";

  const { data, error } = await admin
    .from("check_ins")
    .insert({
      member_id: memberId,
      room_type: input.roomType,
      check_in_date: input.checkInDate,
      check_out_date: input.checkOutDate,
      adults_count: input.adultsCount,
      children_count: input.childrenCount,
      status: autoConfirmed ? "confirmed" : "pre_registered",
      reservation_source: "web_public",
      arrival_time: input.arrivalTime === "" ? null : input.arrivalTime,
      transport_method: input.transportMethod === "" ? null : input.transportMethod,
      self_declared_machibito: input.selfDeclaredMachibito,
      note: input.note.trim() === "" ? null : input.note.trim(),
      // ⚠️ `consent_version` は入れない。版数の採番規則が未決のため（Issue #115 B）。
      //    同意した「事実と時刻」だけを残す。決まってから遡って埋めないこと
      consented_at: new Date().toISOString(),
    })
    .select("checkin_id")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, checkinId: data.checkin_id as string, autoConfirmed };
}

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

/**
 * 検証済みメールから会員を引き、無ければ作る（v13 §5.8.3 の初回紐付け）。
 *
 * ## なぜ検証済みだけを見るのか
 *
 * 未検証の識別子は**同じ値が複数の会員に紐づきうる**（`uq_identifier_verified` は
 * 検証済みにしか効かない）。未検証まで照合に使うと、移行データの同名・同アドレスに
 * 引き当たって**他人の予約履歴へ合流**してしまう。
 * 未検証との突合＝名寄せ本体は WBS `10-2` の担当であり、ここではやらない。
 *
 * ## 新規会員の既定値（2026-09-21 オーナー決定）
 *
 * **現行の最小限のロール**＝ `role = 'guest'`。`member_type` は立場であって権限ではないので
 * （v13 §2）`ゲスト` を置く。`account_status` は `pre_registered`（まだログインしていない）。
 * アプリへログインできるようになるのは招待（経路B）か来訪時の登録（経路A）を経た後である。
 */
async function findOrCreateMember(
  admin: AdminClient,
  params: { email: string; fullName: string },
): Promise<string | null> {
  const { data: existing } = await admin
    .from("member_identifiers")
    .select("member_id")
    .eq("kind", "email")
    .eq("value_normalized", params.email)
    .eq("is_verified", true)
    .limit(1);

  if (existing !== null && existing.length > 0) {
    return (existing[0] as { member_id: string }).member_id;
  }

  const { data: created, error } = await admin
    .from("members")
    .insert({
      member_type: "ゲスト",
      role: "guest",
      account_status: "pre_registered",
    })
    .select("member_id")
    .maybeSingle();

  if (error || !created) {
    return null;
  }
  const memberId = created.member_id as string;

  // 氏名は PII-A。`member_profiles_private` が持つ（§2 の原則7）。`members` へは置かない
  await admin
    .from("member_profiles_private")
    .insert({ member_id: memberId, full_name: params.fullName });

  return memberId;
}

/** 連絡先を1件入れる。既に同じ値があれば触らない（重複行を増やさない）。 */
async function upsertContact(
  admin: AdminClient,
  memberId: string,
  kind: "email" | "phone",
  value: string,
  isVerified: boolean,
): Promise<void> {
  const { data: existing } = await admin
    .from("member_identifiers")
    .select("identifier_id")
    .eq("member_id", memberId)
    .eq("kind", kind)
    .eq("value_normalized", value.toLowerCase())
    .limit(1);

  if (existing !== null && existing.length > 0) {
    return;
  }

  await admin.from("member_identifiers").insert({
    member_id: memberId,
    kind,
    value,
    is_verified: isVerified,
    verified_at: isVerified ? new Date().toISOString() : null,
  });
}
