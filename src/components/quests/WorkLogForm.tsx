"use client";

import { useActionState, useState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import { uploadFileToStorage } from "@/lib/media/upload-client";
import type { MyApplication } from "@/lib/quests/fetch-my-applications";

export type WorkLogAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/** 写真1枚の状態。アップロードが終わるまで提出させないために持つ。 */
type PhotoSlot = {
  mediaId: string | null;
  uploadState: "empty" | "uploading" | "done" | "failed";
  message?: string;
};

const EMPTY_SLOT: PhotoSlot = { mediaId: null, uploadState: "empty" };

/**
 * 完了報告フォーム（WBS 5-3 ／ v13 §5.3-4）。
 *
 * ## 写真は「先に送って、IDだけ提出する」
 *
 * 画像の実体はブラウザから直接ストレージへ送る（v13 §5.11.2 不可侵ルール1）。
 * Server Action へファイルを載せると、アプリのサーバが巨大なリクエストを受けることになり、
 * §5.11.2 が避けようとした形そのものになる。ここでは**送信済みの `media_id`** を
 * hidden で渡す。
 *
 * ## 送信中は提出ボタンを止める
 *
 * 写真が上がりきる前に提出できると、「写真なしの報告」が普通に発生する。
 * 必須判定はサーバ側（`decideWorkLogSubmission()`）にもあるが、
 * 現場で弾かれてから撮り直すのでは遅い。
 */
export function WorkLogForm({
  application,
  submit,
}: {
  application: MyApplication;
  submit: WorkLogAction;
}) {
  const [state, formAction, isPending] = useActionState(submit, SUBMIT_IDLE);
  const [before, setBefore] = useState<PhotoSlot>(EMPTY_SLOT);
  const [after, setAfter] = useState<PhotoSlot>(EMPTY_SLOT);
  const [hasIssue, setHasIssue] = useState(false);

  async function upload(file: File, set: (slot: PhotoSlot) => void, purpose: string) {
    set({ mediaId: null, uploadState: "uploading" });
    const result = await uploadFileToStorage({
      file,
      // 用途タグは最低1つ必須（v13 §5.11.7 ②）。報告の写真は用途が決まっているので固定で付ける
      purposeTags: ["クエスト報告", purpose],
    });
    set(
      result.ok
        ? { mediaId: result.mediaId, uploadState: "done" }
        : { mediaId: null, uploadState: "failed", message: result.message },
    );
  }

  const photosReady = before.uploadState === "done" && after.uploadState === "done";

  return (
    <form action={formAction} className="mt-3 flex flex-col gap-3 border-t border-neutral-200 pt-3">
      <input type="hidden" name="applicationId" value={application.applicationId} />
      <input type="hidden" name="beforePhotoMediaId" value={before.mediaId ?? ""} />
      <input type="hidden" name="afterPhotoMediaId" value={after.mediaId ?? ""} />

      <div className="grid gap-3 sm:grid-cols-2">
        <PhotoField
          label="作業前の写真（必須）"
          slot={before}
          onSelect={(file) => void upload(file, setBefore, "作業前")}
        />
        <PhotoField
          label="作業後の写真（必須）"
          slot={after}
          onSelect={(file) => void upload(file, setAfter, "作業後")}
        />
      </div>

      <label className="flex flex-col gap-1 text-xs">
        作業時間（時間・任意）
        <input
          type="number"
          name="workHours"
          min={0.25}
          max={24}
          step={0.25}
          className="w-32 rounded border border-neutral-300 px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        メモ（任意）
        <textarea name="notes" rows={2} className="rounded border border-neutral-300 px-2 py-1" />
      </label>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          name="issueFlag"
          checked={hasIssue}
          onChange={(event) => setHasIssue(event.target.checked)}
        />
        作業中に気づいた問題がある
      </label>
      {hasIssue ? (
        <label className="flex flex-col gap-1 text-xs">
          問題の内容（必須）
          <textarea
            name="issueNote"
            rows={2}
            required
            className="rounded border border-neutral-300 px-2 py-1"
          />
        </label>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={isPending || !photosReady}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {isPending ? "提出しています…" : "完了報告を提出する"}
        </button>
        {photosReady ? null : (
          <p className="mt-1 text-xs text-neutral-600">
            作業前・作業後の写真が両方そろうと提出できます。
          </p>
        )}
      </div>

      {state.message === undefined ? null : (
        <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-green-700"}>
          {state.message}
        </p>
      )}
    </form>
  );
}

function PhotoField({
  label,
  slot,
  onSelect,
}: {
  label: string;
  slot: PhotoSlot;
  onSelect: (file: File) => void;
}) {
  const STATUS_TEXT = {
    empty: "未選択",
    uploading: "送信中…",
    done: "送信済み",
    failed: "失敗",
  } as const;

  return (
    <label className="flex flex-col gap-1 text-xs">
      {label}
      <input
        type="file"
        accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) {
            onSelect(file);
          }
        }}
      />
      <span className={slot.uploadState === "failed" ? "text-red-700" : "text-neutral-600"}>
        {STATUS_TEXT[slot.uploadState]}
        {slot.message === undefined ? "" : `（${slot.message}）`}
      </span>
    </label>
  );
}
