/**
 * チェックイン時の宿泊者名簿収集（WBS 3-2 ／ v13 §5.2.7 ／ `API設計.md` §3-5）。
 *
 * ## プレフィルは「参照」であって「確定」ではない
 *
 * `fetchLodgingRegisterPrefill()` は既存会員の `member_profiles_private` と、
 * 訂正中であれば既存の名簿行を**下書きとして**返すだけである。名簿を実際に作成・更新する
 * `submitLodgingRegisterEntry()` は、呼び出し側が本人確認を取った申告
 * （`fullNameConfirmed = true`）を必須とする。プレフィルされた値をそのまま流し込んでも、
 * このフラグが立っていなければ 422 に相当する検証エラーで拒否する（v13 §5.2.7 の
 * 「本人の自己申告のみでは確定させない」を、値の出所ではなく確認申告の有無で担保する）。
 *
 * ## 認可はここでしない
 *
 * `cancellation.ts` と同じ分担。呼び出し元（Server Action / Route Handler）が
 * `readViewer()` ＋ `isStaff()` で判定してから呼ぶ。ここで使うのは RLS が効く通常の
 * サーバクライアントなので、判定漏れがあっても `lre_insert_staff` / `lre_update_staff` が
 * 最後に拒否する（v13 §5.9.3 の二重防御）。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

export type LodgingRegisterPrefill = {
  checkinId: string;
  memberId: string;
  checkInDate: string;
  checkOutDate: string;
  roomTypeLabel: string;
  /**
   * 予約人数（大人＋子ども）。**名簿の枚数が足りているかを店員が目で確かめるために出す。**
   * 一致を強制はしない（乳幼児・当日の人数変更があり、名簿の側を正とは決められない）。
   */
  bookedHeadcount: number;
  /** 既存の名簿行があればその値、無ければ会員プロフィールの現在値。どちらも無ければ null（初回客扱い） */
  fullNameSnapshot: string | null;
  fullNameKanaSnapshot: string | null;
  address: string | null;
  previousLocation: string | null;
  nextDestination: string | null;
  /** true = 既存の名簿行を訂正する（送信すると 200）。false = 新規作成（201） */
  hasExistingEntry: boolean;
};

/**
 * 指定チェックインの宿泊者名簿プレフィルを取得する。
 *
 * v13 §5.2.7「既存会員は `member_profiles_private` の現在値をタブレットに初期表示し、
 * 本人に確認のうえ確定してコピーする」の初期表示部分。**コピー前（表示のみ）**なので、
 * ここではまだ `lodging_register_entries` へ書き込まない。
 */
export async function fetchLodgingRegisterPrefill(
  checkinId: string,
): Promise<LodgingRegisterPrefill | null> {
  const supabase = await createServerSupabaseClient();

  const { data: checkIn, error: checkInError } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, check_in_date, check_out_date, adults_count, children_count, accommodation_types(display_name)",
    )
    .eq("checkin_id", checkinId)
    .maybeSingle();

  if (checkInError || !checkIn) {
    return null;
  }

  const memberId = checkIn.member_id as string;

  const { data: profile } = await supabase
    .from("member_profiles_private")
    .select("full_name, full_name_kana, address")
    .eq("member_id", memberId)
    .maybeSingle();

  // 代表者（is_representative = true）の既存行のうち最新のもの。
  // 同伴者の管理はこの画面のスコープ外（本人＝代表者の名簿のみを扱う）。
  const { data: existingEntries } = await supabase
    .from("lodging_register_entries")
    .select("full_name_snapshot, full_name_kana_snapshot, address_snapshot, previous_location, next_destination")
    .eq("checkin_id", checkinId)
    .eq("is_representative", true)
    .order("recorded_at", { ascending: false })
    .limit(1);

  const existingEntry = existingEntries?.[0] ?? null;

  // Supabase の埋め込みリソース型は、生成済み型定義（Database ジェネリクス）を持たないこの
  // プロジェクトでは配列と単一オブジェクトのどちらにも推論されうる。FK（多対1）なので実体は
  // 常に単一オブジェクトだが、型としては両方を許容して安全側に倒す。
  const accommodationTypeRaw = checkIn.accommodation_types as unknown;
  const accommodationType = (
    Array.isArray(accommodationTypeRaw) ? accommodationTypeRaw[0] : accommodationTypeRaw
  ) as { display_name: string } | null | undefined;

  return {
    checkinId: checkIn.checkin_id as string,
    memberId,
    checkInDate: checkIn.check_in_date as string,
    checkOutDate: checkIn.check_out_date as string,
    roomTypeLabel: accommodationType?.display_name ?? "不明",
    bookedHeadcount:
      ((checkIn.adults_count as number | null) ?? 0) +
      ((checkIn.children_count as number | null) ?? 0),
    fullNameSnapshot: existingEntry?.full_name_snapshot ?? profile?.full_name ?? null,
    fullNameKanaSnapshot: existingEntry?.full_name_kana_snapshot ?? profile?.full_name_kana ?? null,
    address: existingEntry?.address_snapshot ?? profile?.address ?? null,
    previousLocation: existingEntry?.previous_location ?? null,
    nextDestination: existingEntry?.next_destination ?? null,
    hasExistingEntry: existingEntry !== null,
  };
}

export type LodgingRegisterValidationReason =
  | "full_name_not_confirmed"
  | "full_name_blank"
  | "address_blank"
  | "previous_location_blank";

/**
 * 入力の検証だけを行う純関数（`cancellation.ts` の `validateCancellation()` と同じ分担）。
 *
 * `API設計.md` §3-5 の必須項目（`full_name_confirmed` / `address` / `previous_location`）を
 * そのまま反映する。`full_name_confirmed` が false なら、住所等が埋まっていても拒否する。
 */
export function validateLodgingRegisterInput(input: {
  fullNameConfirmed: boolean;
  fullNameSnapshot: string;
  address: string;
  previousLocation: string;
}): { ok: true } | { ok: false; reason: LodgingRegisterValidationReason } {
  if (!input.fullNameConfirmed) {
    return { ok: false, reason: "full_name_not_confirmed" };
  }
  if (input.fullNameSnapshot.trim() === "") {
    return { ok: false, reason: "full_name_blank" };
  }
  if (input.address.trim() === "") {
    return { ok: false, reason: "address_blank" };
  }
  if (input.previousLocation.trim() === "") {
    return { ok: false, reason: "previous_location_blank" };
  }
  return { ok: true };
}

export type SubmitLodgingRegisterResult =
  | { ok: true; created: boolean; entryId: string }
  | { ok: false; reason: LodgingRegisterValidationReason | "checkin_not_found" | "denied" | "failed" };

/**
 * 宿泊者名簿（代表者分）を作成・訂正する。
 *
 * ## 作成と訂正の切り分け
 *
 * 代表者（`is_representative = true`）の既存行が無ければ新規作成（201相当）、
 * あれば訂正として UPDATE する（200相当・チェックアウト前の訂正／`DB物理設計.md` §3-13②）。
 * 同伴者行の作成・訂正はこの関数のスコープ外（呼び出し側でこの関数を使わず別途 INSERT する）。
 */
export async function submitLodgingRegisterEntry(params: {
  checkinId: string;
  recordedByMemberId: string;
  fullNameConfirmed: boolean;
  fullNameSnapshot: string;
  fullNameKanaSnapshot: string | null;
  address: string;
  previousLocation: string;
  nextDestination: string | null;
}): Promise<SubmitLodgingRegisterResult> {
  const validation = validateLodgingRegisterInput(params);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const supabase = await createServerSupabaseClient();

  const { data: checkIn, error: checkInError } = await supabase
    .from("check_ins")
    .select("checkin_id, member_id, check_in_date")
    .eq("checkin_id", params.checkinId)
    .maybeSingle();

  if (checkInError) {
    return { ok: false, reason: checkInError.code === "42501" ? "denied" : "failed" };
  }
  if (!checkIn) {
    return { ok: false, reason: "checkin_not_found" };
  }

  const { data: existingEntries, error: existingError } = await supabase
    .from("lodging_register_entries")
    .select("entry_id")
    .eq("checkin_id", params.checkinId)
    .eq("is_representative", true)
    .order("recorded_at", { ascending: false })
    .limit(1);

  if (existingError) {
    return { ok: false, reason: existingError.code === "42501" ? "denied" : "failed" };
  }

  const existingEntryId = existingEntries?.[0]?.entry_id as string | undefined;

  const snapshot = {
    checkin_id: checkIn.checkin_id,
    member_id: checkIn.member_id,
    full_name_snapshot: params.fullNameSnapshot.trim(),
    full_name_kana_snapshot: emptyToNull(params.fullNameKanaSnapshot),
    address_snapshot: params.address.trim(),
    previous_location: params.previousLocation.trim(),
    next_destination: emptyToNull(params.nextDestination),
    checked_in_on: checkIn.check_in_date,
    is_representative: true,
    recorded_by: params.recordedByMemberId,
    source: "checkin" as const,
    updated_at: new Date().toISOString(),
  };

  if (existingEntryId !== undefined) {
    const { error: updateError } = await supabase
      .from("lodging_register_entries")
      .update(snapshot)
      .eq("entry_id", existingEntryId);

    if (updateError) {
      return { ok: false, reason: updateError.code === "42501" ? "denied" : "failed" };
    }
    return { ok: true, created: false, entryId: existingEntryId };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("lodging_register_entries")
    .insert(snapshot)
    .select("entry_id")
    .single();

  if (insertError || !inserted) {
    return { ok: false, reason: insertError?.code === "42501" ? "denied" : "failed" };
  }

  return { ok: true, created: true, entryId: inserted.entry_id as string };
}

function emptyToNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 同伴者の名簿行（`is_representative = false` ／ v13 §5.2.7「同伴者も1名につき1名簿行」）。
 *
 * ⚠️ **`memberId` を持たせない。** 同伴者は会員とは限らず、仮に代表者の `member_id` を
 * 入れると `lre_select_self`（`member_id = current_member_id()`）により
 * **代表者が同伴者の氏名・住所を読める**ようになる。PII-A を予約者へ開く経路を作らない
 * （`0010` の RLS ／ `DB物理設計.md` §3-13①「check_ins に住所を足すと同伴者の住所が予約者へ返る」
 * と同じ理由である）。
 */
export type CompanionRegisterEntry = {
  entryId: string;
  fullNameSnapshot: string;
  fullNameKanaSnapshot: string | null;
  address: string;
  previousLocation: string | null;
  nextDestination: string | null;
};

/** そのチェックインに紐づく同伴者の名簿行。古い順（登録した並びで読めるようにする）。 */
export async function fetchCompanionRegisterEntries(
  checkinId: string,
): Promise<CompanionRegisterEntry[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("lodging_register_entries")
    .select(
      "entry_id, full_name_snapshot, full_name_kana_snapshot, address_snapshot, previous_location, next_destination",
    )
    .eq("checkin_id", checkinId)
    .eq("is_representative", false)
    .order("recorded_at", { ascending: true });

  if (error || !data) {
    return [];
  }

  return data.map((row) => ({
    entryId: row.entry_id as string,
    fullNameSnapshot: row.full_name_snapshot as string,
    fullNameKanaSnapshot: (row.full_name_kana_snapshot as string | null) ?? null,
    address: row.address_snapshot as string,
    previousLocation: (row.previous_location as string | null) ?? null,
    nextDestination: (row.next_destination as string | null) ?? null,
  }));
}

export type SubmitCompanionResult =
  | { ok: true; created: boolean; entryId: string }
  | {
      ok: false;
      reason:
        | LodgingRegisterValidationReason
        | "checkin_not_found"
        | "entry_not_found"
        | "denied"
        | "failed";
    };

/**
 * 同伴者の名簿行を1件作成・訂正する（`API設計.md` §3-5 の `is_representative: false`）。
 *
 * ## 代表者の行と独立に訂正する
 *
 * 訂正の対象は `entryId` で明示させる。同伴者は同じチェックインに複数並ぶので、
 * 代表者のように「最新の1行」では対象が決まらない。
 *
 * ⚠️ **`entryId` が指す行が「このチェックインの同伴者行」であることを必ず確かめる。**
 * 確かめないと、細工した `entryId` で**代表者の行**や**別のチェックインの名簿**を
 * 上書きできる（どちらも法定記録の改変になる）。RLS は staff なら全行を書けるので、
 * ここが唯一の関門である。
 *
 * ## 必須項目は代表者と同じ
 *
 * `validateLodgingRegisterInput()` を共用する。同伴者だけ氏名確認や住所を省けるようにすると、
 * 「同伴者として登録すれば必須項目を飛ばせる」抜け道になる（v13 §5.2.7「全宿泊者」）。
 */
export async function submitCompanionRegisterEntry(params: {
  checkinId: string;
  recordedByMemberId: string;
  /** 訂正するときだけ渡す。未指定なら新規の同伴者として作る。 */
  entryId?: string | null;
  fullNameConfirmed: boolean;
  fullNameSnapshot: string;
  fullNameKanaSnapshot: string | null;
  address: string;
  previousLocation: string;
  nextDestination: string | null;
}): Promise<SubmitCompanionResult> {
  const validation = validateLodgingRegisterInput(params);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const supabase = await createServerSupabaseClient();

  const { data: checkIn, error: checkInError } = await supabase
    .from("check_ins")
    .select("checkin_id, check_in_date")
    .eq("checkin_id", params.checkinId)
    .maybeSingle();

  if (checkInError) {
    return { ok: false, reason: checkInError.code === "42501" ? "denied" : "failed" };
  }
  if (!checkIn) {
    return { ok: false, reason: "checkin_not_found" };
  }

  const snapshot = {
    checkin_id: checkIn.checkin_id,
    // 同伴者は会員に紐づけない（上の型コメントの理由）。
    member_id: null,
    full_name_snapshot: params.fullNameSnapshot.trim(),
    full_name_kana_snapshot: emptyToNull(params.fullNameKanaSnapshot),
    address_snapshot: params.address.trim(),
    previous_location: params.previousLocation.trim(),
    next_destination: emptyToNull(params.nextDestination),
    checked_in_on: checkIn.check_in_date,
    is_representative: false,
    recorded_by: params.recordedByMemberId,
    source: "checkin" as const,
    updated_at: new Date().toISOString(),
  };

  const entryId = params.entryId?.trim() ?? "";
  if (entryId === "") {
    const { data: inserted, error: insertError } = await supabase
      .from("lodging_register_entries")
      .insert(snapshot)
      .select("entry_id")
      .single();

    if (insertError || !inserted) {
      return { ok: false, reason: insertError?.code === "42501" ? "denied" : "failed" };
    }
    return { ok: true, created: true, entryId: inserted.entry_id as string };
  }

  // ★ 対象が「このチェックインの同伴者行」であることを確かめてから更新する。
  //   `update().eq(...)` の条件に混ぜるだけでは、0件更新と権限拒否を区別できない。
  const { data: target, error: targetError } = await supabase
    .from("lodging_register_entries")
    .select("entry_id")
    .eq("entry_id", entryId)
    .eq("checkin_id", params.checkinId)
    .eq("is_representative", false)
    .maybeSingle();

  if (targetError) {
    return { ok: false, reason: targetError.code === "42501" ? "denied" : "failed" };
  }
  if (!target) {
    return { ok: false, reason: "entry_not_found" };
  }

  const { error: updateError } = await supabase
    .from("lodging_register_entries")
    .update(snapshot)
    .eq("entry_id", entryId);

  if (updateError) {
    return { ok: false, reason: updateError.code === "42501" ? "denied" : "failed" };
  }
  return { ok: true, created: false, entryId };
}
