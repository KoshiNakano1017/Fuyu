"use client";

import { useRef, useState } from "react";

import { readCaptureMetadataFromFile } from "@/lib/media/exif";
import {
  overallProgressPercent,
  retryableItems,
  toBrowserHeaders,
  type SignedUploadTicket,
  type UploadItem,
} from "@/lib/media/upload-client";

/**
 * アップロード画面（画面ID A10 ／ WBS 14-2 ／ v13 §5.11.7）。
 *
 * 手順は仕様の4段そのままである。
 *   ① ファイル選択／その場で撮影 → ② 用途タグ（最低1つ必須）→ ③ 進捗表示 → ④ 失敗分のみ再試行
 *
 * ## 実体はブラウザから直接ストレージへ送る
 *
 * アプリのサーバを経由しない（v13 §5.11.2 不可侵ルール1）。サーバがするのは
 * 署名付きURLの発行だけで、200MB の動画が Vercel の関数を通ることはない。
 * したがってこのコンポーネントは **`fetch` でチケットを取り、`XMLHttpRequest` で
 * ストレージへ PUT する**。`fetch` を使わないのは、**アップロードの進捗を取れない**ためである
 * （リクエスト側ストリームの進捗は取得できない）。
 *
 * ## 1件ずつ順番に送る
 *
 * 並列にすると現場のモバイル回線を食い合い、全部が同時に遅くなる。
 * 順番に送れば、少なくとも先頭から確実に着く（途中で電波が切れても、着いた分は残る）。
 */
export function UploadForm({ presets }: { presets: readonly string[] }) {
  const [selectedTags, setSelectedTags] = useState<readonly string[]>([]);
  const [freeTag, setFreeTag] = useState("");
  const [items, setItems] = useState<readonly UploadItem[]>([]);
  const [isSending, setIsSending] = useState(false);

  // itemId → File。再試行のために元のファイルを保つ。state に入れないのは、
  // File を state に置くと再描画のたびに参照が配られ、取り違えの温床になるため。
  const filesByItemId = useRef(new Map<string, File>());

  const purposeTags = buildPurposeTags(selectedTags, freeTag);
  const failed = retryableItems(items);
  const waiting = items.filter((item) => item.state === "waiting");

  function updateItem(itemId: string, patch: Partial<UploadItem>) {
    setItems((current) =>
      current.map((item) => (item.itemId === itemId ? { ...item, ...patch } : item)),
    );
  }

  async function sendItems(targets: readonly UploadItem[]) {
    setIsSending(true);
    for (const target of targets) {
      const file = filesByItemId.current.get(target.itemId);
      if (file === undefined) {
        continue;
      }
      updateItem(target.itemId, { state: "uploading", progressPercent: 0, errorMessage: undefined });
      const result = await uploadOneFile(file, purposeTags, (percent) =>
        updateItem(target.itemId, { progressPercent: percent }),
      );
      updateItem(
        target.itemId,
        result.ok
          ? { state: "done", progressPercent: 100, mediaId: result.mediaId }
          : { state: "failed", errorMessage: result.message },
      );
    }
    setIsSending(false);
  }

  function handleSelect(fileList: FileList | null) {
    if (fileList === null) {
      return;
    }
    const added = Array.from(fileList).map((file, index) => {
      const itemId = `${Date.now()}-${index}`;
      filesByItemId.current.set(itemId, file);
      return {
        itemId,
        fileName: file.name,
        sizeBytes: file.size,
        state: "waiting" as const,
        progressPercent: 0,
      };
    });
    setItems((current) => [...current, ...added]);
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">① 写真・動画を選ぶ</h2>
        <input
          type="file"
          multiple
          // スマートフォンでは同じ入力欄から「カメラで撮る」も選べる（v13 §5.11.7 ①）
          accept="image/jpeg,image/png,image/heic,image/heif,image/webp,video/mp4,video/quicktime"
          onChange={(event) => handleSelect(event.target.files)}
          className="text-sm"
        />
        <p className="text-xs text-neutral-600">画像は1件 20MB まで、動画は 200MB までです。</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">② 用途タグ（1つ以上・必須）</h2>
        <p className="text-xs text-neutral-600">
          何に使う写真かを選びます。<strong>後からまとめて付け直すことは実質できない</strong>ため、
          ここで入れてください（v13 §5.11.3）。
        </p>
        <ul className="flex flex-wrap gap-2">
          {presets.map((preset) => {
            const checked = selectedTags.includes(preset);
            return (
              <li key={preset}>
                <label
                  className={`cursor-pointer rounded border px-2 py-1 text-xs ${
                    checked ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() =>
                      setSelectedTags((current) =>
                        checked ? current.filter((tag) => tag !== preset) : [...current, preset],
                      )
                    }
                  />
                  {preset}
                </label>
              </li>
            );
          })}
        </ul>
        <input
          type="text"
          value={freeTag}
          onChange={(event) => setFreeTag(event.target.value)}
          placeholder="その他のタグ（読点・カンマ区切り）"
          className="rounded border border-neutral-300 px-3 py-2 text-sm"
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">③ アップロード</h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isSending || purposeTags.length === 0 || waiting.length === 0}
            onClick={() => void sendItems(waiting)}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {isSending ? "アップロード中…" : "アップロードする"}
          </button>
          {failed.length === 0 ? null : (
            <button
              type="button"
              disabled={isSending || purposeTags.length === 0}
              onClick={() => void sendItems(failed)}
              className="rounded border border-neutral-400 px-4 py-2 text-sm disabled:opacity-50"
            >
              失敗した {failed.length} 件だけ再試行する
            </button>
          )}
          {items.length === 0 ? null : (
            <span className="text-xs text-neutral-600">全体 {overallProgressPercent(items)}%</span>
          )}
        </div>
        {purposeTags.length === 0 && items.length > 0 ? (
          <p className="text-xs text-red-700">用途タグを1つ以上選んでください。</p>
        ) : null}
        <UploadItemList items={items} />
      </section>
    </div>
  );
}

const STATE_LABEL: Record<UploadItem["state"], string> = {
  waiting: "待機中",
  uploading: "送信中",
  done: "完了",
  failed: "失敗",
};

function UploadItemList({ items }: { items: readonly UploadItem[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.itemId} className="rounded border border-neutral-200 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{item.fileName}</span>
            <span className={item.state === "failed" ? "text-red-700" : "text-neutral-600"}>
              {STATE_LABEL[item.state]}
              {item.state === "uploading" ? ` ${item.progressPercent}%` : ""}
            </span>
          </div>
          {item.errorMessage === undefined ? null : (
            <p className="mt-1 text-red-700">{item.errorMessage}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 選択したプリセットと自由入力を1つの配列にする。重複と空白は `decideUploadPolicy()` が落とす。 */
function buildPurposeTags(selected: readonly string[], freeTag: string): string[] {
  const free = freeTag
    .split(/[,、]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return [...selected, ...free];
}

type UploadOutcome = { ok: true; mediaId: string } | { ok: false; message: string };

/**
 * 1件をアップロードする。
 *   ① Exif から撮影日時・位置を読む（JPEG のみ）→ ② 署名付きURLを受け取る → ③ ストレージへ PUT
 *
 * ③ が終わっても**アプリへ完了を通知しない**。記録は Object Finalize が起点である
 * （v13 §5.11.2 note）。通知に頼ると、通信断やアプリ離脱で「実体はあるのに記録が無い」状態になる。
 */
async function uploadOneFile(
  file: File,
  purposeTags: readonly string[],
  onProgress: (percent: number) => void,
): Promise<UploadOutcome> {
  const capture = await readCaptureMetadataFromFile(file);

  let ticket: SignedUploadTicket;
  try {
    const response = await fetch("/api/media/signed-upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentType: file.type,
        purposeTags,
        declaredSizeBytes: file.size,
        takenAt: capture.takenAt,
        geoLocation: capture.geoLocation,
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      return { ok: false, message: readErrorMessage(body) };
    }
    ticket = body as SignedUploadTicket;
  } catch {
    return { ok: false, message: "通信に失敗しました。電波の良い場所で再試行してください。" };
  }

  return putToStorage(ticket, file, onProgress);
}

function readErrorMessage(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error !== "") {
      return error;
    }
  }
  return "アップロードの受付に失敗しました。";
}

function putToStorage(
  ticket: SignedUploadTicket,
  file: File,
  onProgress: (percent: number) => void,
): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open(ticket.method, ticket.uploadUrl);

    for (const [name, value] of Object.entries(toBrowserHeaders(ticket.requiredHeaders))) {
      request.setRequestHeader(name, value);
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.floor((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      resolve(
        request.status >= 200 && request.status < 300
          ? { ok: true, mediaId: ticket.mediaId }
          : // ⚠️ ストレージの応答本文を画面へ出さない。署名付きURLの一部が混ざりうるため
            //    （v13 §5.11.2 トレードオフ：URL を知る者は誰でも開ける）。
            { ok: false, message: `保存に失敗しました（${request.status}）。再試行してください。` },
      );
    });
    request.addEventListener("error", () =>
      resolve({ ok: false, message: "通信に失敗しました。再試行してください。" }),
    );
    request.addEventListener("abort", () =>
      resolve({ ok: false, message: "アップロードが中断されました。" }),
    );

    request.send(file);
  });
}
