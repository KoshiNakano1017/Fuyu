"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

export type ModerateAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 1件ぶんの表示と、その投稿へ出せる操作。
 *
 * ★ **出せる操作はサーバ側で決めて渡す**（`offers` / `requiresReason`）。
 * ここでロールを見て分岐すると、判定が画面とサーバの2箇所に分かれる。
 * このコンポーネントはクライアントで動くので、判定を持たせると**利用者の手元で書き換えられる**。
 */
export type ModerationEntry = {
  mediaId: string;
  uploaderLabel: string;
  /** 自分の投稿か（見出しの出し方だけに使う） */
  isOwnPost: boolean;
  mediaType: string;
  purposeTags: readonly string[];
  visibility: "公開" | "運営のみ";
  isDeleted: boolean;
  createdAt: string;
  /** 出す操作。サーバが `decideModeration()` で決めた結果だけを並べる */
  offers: readonly { action: "hide" | "unhide" | "delete"; label: string; requiresReason: boolean }[];
};

/**
 * メディアの運営措置（画面ID A10 の下段 ／ WBS 14-3 ／ v13 §5.11.7）。
 *
 * ## なぜアップロード画面に置くのか
 *
 * メディアライブラリ画面（`14-5`）は Phase 2 である（v13 §9 #33）。
 * それを待つと、**アップロードは開いているのに措置の手段が無い**期間が残る。
 * v13 §5.11.7 の警告が禁じているのはまさにその状態なので、投稿の直後に見える場所へ置く。
 *
 * ## 一覧に「削除済み」も残す
 *
 * 運営から消えると、措置の結果を確認できない（同じ投稿へ二重に措置しようとする）。
 * 論理削除なので行は残っており、そのことが分かる表示にする。
 */
export function MediaModerationList({
  entries,
  moderate,
  canModerateOthers,
}: {
  entries: readonly ModerationEntry[];
  moderate: ModerateAction;
  canModerateOthers: boolean;
}) {
  return (
    <section className="rounded border border-neutral-200 bg-white p-4">
      <h2 className="text-lg font-bold">最近の投稿</h2>
      <p className="mt-1 text-xs text-neutral-600">
        {canModerateOthers
          ? "不適切な投稿・第三者が写り込んだ写真は、ここから非表示化または削除してください。他の人の投稿へ措置するときは理由の入力が必要です。"
          : "自分の投稿は、ここから公開範囲の変更・取り下げができます。"}
      </p>

      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-600">まだ投稿がありません。</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {entries.map((entry) => (
            <MediaModerationRow key={entry.mediaId} entry={entry} moderate={moderate} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MediaModerationRow({
  entry,
  moderate,
}: {
  entry: ModerationEntry;
  moderate: ModerateAction;
}) {
  const [state, submit, isPending] = useActionState(moderate, SUBMIT_IDLE);
  // 理由欄は、出す操作のどれかが理由を要るときだけ置く（1件につき1つでよい）。
  const needsReason = entry.offers.some((offer) => offer.requiresReason);

  return (
    <li className="flex flex-col gap-2 rounded border border-neutral-200 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {entry.isOwnPost ? "自分の投稿" : entry.uploaderLabel}
        </span>
        <span className="flex items-center gap-2 text-xs">
          <span className="rounded bg-neutral-100 px-2 py-0.5">{entry.mediaType}</span>
          <span className="rounded bg-neutral-200 px-2 py-0.5">{entry.visibility}</span>
          {entry.isDeleted ? (
            <span className="rounded bg-red-100 px-2 py-0.5 text-red-800">削除済み</span>
          ) : null}
        </span>
      </div>

      {entry.purposeTags.length > 0 ? (
        <p className="text-xs text-neutral-700">用途: {entry.purposeTags.join(" / ")}</p>
      ) : null}

      {entry.offers.length > 0 ? (
        <form action={submit} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="mediaId" value={entry.mediaId} />
          {needsReason ? (
            <input
              type="text"
              name="reason"
              required
              placeholder="措置の理由（他の人の投稿には必須）"
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
            />
          ) : null}
          {entry.offers.map((offer) => (
            <button
              key={offer.action}
              type="submit"
              name="action"
              value={offer.action}
              disabled={isPending}
              className={
                offer.action === "delete"
                  ? "rounded bg-red-700 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                  : "rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              }
            >
              {offer.label}
            </button>
          ))}
        </form>
      ) : null}

      {state.status !== "idle" && state.message !== undefined ? (
        <p
          className={
            state.status === "error" ? "text-xs text-red-700" : "text-xs text-neutral-700"
          }
        >
          {state.message}
        </p>
      ) : null}
    </li>
  );
}
