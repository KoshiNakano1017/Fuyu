// アップロード画面（WBS 14-2）がブラウザ側で行う判断の単体テスト。
//
// 画面そのもの（`UploadForm`）ではなく、そこから切り出した純関数を対象にする。
// ヘッダの取り扱いと進捗の計算は、間違えても画面上は「なんとなく動いている」ように見えるため、
// ここで形を固定しておく必要がある。

import {
  overallProgressPercent,
  retryableItems,
  toBrowserHeaders,
  type UploadItem,
} from "@/lib/media/upload-client";

function item(overrides: Partial<UploadItem>): UploadItem {
  return {
    itemId: "i1",
    fileName: "photo.jpg",
    sizeBytes: 1_000_000,
    state: "waiting",
    progressPercent: 0,
    ...overrides,
  };
}

describe("ストレージへ送るヘッダ（v13 §5.11.5）", () => {
  test("署名に焼き込まれた content-type をそのまま送る", () => {
    const headers = toBrowserHeaders({ host: "storage.googleapis.com", "content-type": "image/jpeg" });
    expect(headers["content-type"]).toBe("image/jpeg");
  });

  test("サイズ上限のヘッダを落とさない（落とすとストレージ側の強制が効かない）", () => {
    const headers = toBrowserHeaders({
      host: "storage.googleapis.com",
      "x-goog-content-length-range": "1,20971520",
    });
    expect(headers["x-goog-content-length-range"]).toBe("1,20971520");
  });

  test("ブラウザが自分で付ける host は送らない", () => {
    expect(toBrowserHeaders({ Host: "storage.googleapis.com" })).toEqual({});
  });
});

describe("失敗分のみの再試行（v13 §5.11.7 ④）", () => {
  test("再試行の対象は失敗したものだけで、完了・送信中は含めない", () => {
    const targets = retryableItems([
      item({ itemId: "a", state: "done" }),
      item({ itemId: "b", state: "failed" }),
      item({ itemId: "c", state: "uploading" }),
      item({ itemId: "d", state: "waiting" }),
    ]);
    expect(targets.map((target) => target.itemId)).toEqual(["b"]);
  });
});

describe("全体進捗", () => {
  test("件数ではなくバイト数で重み付けする", () => {
    // 1MB 完了 ＋ 99MB 未送信。件数で割ると 50% になるが、実際には 1% である
    const percent = overallProgressPercent([
      item({ itemId: "a", sizeBytes: 1_000_000, state: "done" }),
      item({ itemId: "b", sizeBytes: 99_000_000, state: "waiting" }),
    ]);
    expect(percent).toBe(1);
  });

  test("ファイルが1件も無ければ 0% を返す（0 除算にしない）", () => {
    expect(overallProgressPercent([])).toBe(0);
  });

  test("送信中のファイルの途中経過も全体へ反映する", () => {
    const percent = overallProgressPercent([
      item({ sizeBytes: 100, state: "uploading", progressPercent: 50 }),
    ]);
    expect(percent).toBe(50);
  });
});
