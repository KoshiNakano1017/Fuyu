/**
 * アップロード画面（WBS 14-2）とサーバの受け渡しの形、およびブラウザ側の小さな決まりごと。
 *
 * 画面（`UploadForm`）から切り出しているのは、ここが**テストできる判断**を含むためである。
 * React のコンポーネントに埋めると、ヘッダの取り扱いを変えたときに気づく手段が無くなる。
 */

/** `POST /api/media/signed-upload-url` の応答。 */
export type SignedUploadTicket = {
  mediaId: string;
  storagePath: string;
  uploadUrl: string;
  method: "PUT";
  requiredHeaders: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
};

/**
 * 署名に含まれるヘッダのうち、**ブラウザが自分で付けるもの**を落とす。
 *
 * `host` は禁止ヘッダ（forbidden header name）であり、`XMLHttpRequest` や `fetch` から
 * 設定しようとしても無視される（ブラウザによっては例外になる）。
 * 署名は `host` を含んだまま計算されているが、ブラウザは宛先ホストを自動で付けるので
 * **結果として署名は一致する**。ここで落とすのは「設定しようとして失敗する」ことを避けるためである。
 *
 * 逆に `content-type` と `x-goog-content-length-range` は**必ず送る**。
 * どちらも署名に焼き込まれており、欠けるとストレージ側が拒否する（v13 §5.11.5）。
 */
export function toBrowserHeaders(requiredHeaders: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(requiredHeaders).filter(([name]) => name.toLowerCase() !== "host"),
  );
}

/** アップロード1件の進行状態（画面の一覧に出す）。 */
export type UploadItemState = "waiting" | "uploading" | "done" | "failed";

export type UploadItem = {
  /** 同じ名前のファイルを複数選べるため、名前ではなく採番で識別する */
  itemId: string;
  fileName: string;
  sizeBytes: number;
  state: UploadItemState;
  /** 0〜100。`uploading` の間だけ意味を持つ */
  progressPercent: number;
  /** 失敗した理由（利用者向けの文言） */
  errorMessage?: string;
  mediaId?: string;
};

/** 再試行の対象＝失敗したものだけ（v13 §5.11.7 ④「失敗分のみ再試行」）。 */
export function retryableItems(items: readonly UploadItem[]): UploadItem[] {
  return items.filter((item) => item.state === "failed");
}

/**
 * 全体の進捗（%）。**ファイル数ではなくバイト数で重み付けする。**
 *
 * 件数で割ると、200MB の動画1本と 2MB の写真1枚で「50%」が同じ意味を持たなくなり、
 * 進捗バーが動かない時間が延々と続く（現場では「固まった」と読まれる）。
 */
export function overallProgressPercent(items: readonly UploadItem[]): number {
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (totalBytes === 0) {
    return 0;
  }
  const doneBytes = items.reduce(
    (sum, item) => sum + (item.sizeBytes * clampPercent(item.state === "done" ? 100 : item.progressPercent)) / 100,
    0,
  );
  return Math.floor((doneBytes / totalBytes) * 100);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 100 ? 100 : value;
}
