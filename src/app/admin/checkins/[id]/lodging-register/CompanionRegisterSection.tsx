"use client";

import { useActionState, useState } from "react";

import type { CompanionRegisterEntry } from "@/lib/lodging/register";

import { submitCompanionRegisterAction, type LodgingRegisterFormState } from "./actions";

const INITIAL: LodgingRegisterFormState = { status: "idle" };

/**
 * 同伴者の名簿（v13 §5.2.7「同伴者も1名につき1名簿行」）。
 *
 * ## 1名につき1フォーム
 *
 * まとめて入力する欄にしない。旅館業法が要求するのは**宿泊者ごとの**氏名・住所・前泊地であり、
 * 1つの欄に「家族3名」と書ける形にすると、後から名簿として出力できない。
 *
 * ## 訂正は行ごと・独立
 *
 * 既に登録した同伴者は `entryId` を持つフォームで開く。代表者の行とは独立に訂正できる
 * （`DB物理設計.md` §3-13② のチェックアウト前の訂正）。
 *
 * ## 消す口を作らない
 *
 * 名簿は法定記録であり、`0010` は DELETE のポリシーも GRANT も与えていない。
 * 3年経過分の削除は定期ジョブだけが行う。**画面に削除ボタンを置かない**のはその反映である。
 * 人数を間違えて登録した場合の扱いは運用（訂正）で吸収する。
 *
 * ## 確認チェックは親切であって防壁ではない
 *
 * 代表者フォームと同じく、送信ボタンは「本人へ提示し確認した」チェックまで非活性にする。
 * サーバ側（`submitCompanionRegisterEntry()` → `validateLodgingRegisterInput()`）が
 * 同じ条件を必ず再検証する（v13 §5.9.3）。
 */
export function CompanionRegisterSection({
  checkinId,
  companions,
  bookedHeadcount,
}: {
  checkinId: string;
  companions: readonly CompanionRegisterEntry[];
  /** 予約人数。**足りているかを店員が目で確かめるための表示**で、一致は強制しない。 */
  bookedHeadcount: number;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold">同伴者の名簿</h2>
        <p className="text-sm text-neutral-600">
          代表者を含む名簿 {companions.length + 1}名 ／ 予約人数 {bookedHeadcount}名。
          旅館業法は<strong>宿泊者ごと</strong>の氏名・住所・前泊地を求めます（v13 §5.2.7）。
        </p>
        <p className="text-xs text-neutral-500">
          登録した名簿は法定記録のため削除できません。誤りは訂正で直してください。
        </p>
      </div>

      {companions.map((companion, index) => (
        <CompanionForm
          key={companion.entryId}
          checkinId={checkinId}
          companion={companion}
          heading={`同伴者 ${index + 1}名目（登録済み）`}
        />
      ))}

      <CompanionForm
        // 登録が終わるたびに入力欄を空へ戻す。`key` に件数を混ぜてあるのは、
        // 保存後に同じ値が残っていると同じ人をもう一度登録しやすいためである。
        key={`new-${companions.length}`}
        checkinId={checkinId}
        companion={null}
        heading="同伴者を追加する"
      />
    </section>
  );
}

function CompanionForm({
  checkinId,
  companion,
  heading,
}: {
  checkinId: string;
  companion: CompanionRegisterEntry | null;
  heading: string;
}) {
  const [state, submit] = useActionState(submitCompanionRegisterAction, INITIAL);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <form action={submit} className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
      <h3 className="text-sm font-medium text-neutral-700">{heading}</h3>

      <input type="hidden" name="checkinId" value={checkinId} />
      {companion ? <input type="hidden" name="entryId" value={companion.entryId} /> : null}

      <label className="flex flex-col gap-1 text-sm">
        氏名
        <input
          type="text"
          name="fullNameSnapshot"
          required
          defaultValue={companion?.fullNameSnapshot ?? ""}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        フリガナ
        <input
          type="text"
          name="fullNameKanaSnapshot"
          defaultValue={companion?.fullNameKanaSnapshot ?? ""}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        住所
        <textarea
          name="address"
          required
          rows={2}
          defaultValue={companion?.address ?? ""}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        前泊地
        <input
          type="text"
          name="previousLocation"
          required
          defaultValue={companion?.previousLocation ?? ""}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        後泊地／行先（任意）
        <input
          type="text"
          name="nextDestination"
          defaultValue={companion?.nextDestination ?? ""}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="fullNameConfirmed"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-1"
        />
        <span>
          氏名・カナを本人へ提示し、確認した
          <span className="text-red-700">（必須）</span>
        </span>
      </label>

      <button
        type="submit"
        disabled={!confirmed}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-white disabled:bg-neutral-300"
      >
        {companion ? "この同伴者の名簿を更新する" : "同伴者の名簿を追加する"}
      </button>

      {state.message ? (
        <p className={state.status === "error" ? "text-sm text-red-700" : "text-sm text-green-700"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
