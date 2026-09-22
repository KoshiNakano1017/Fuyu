// WBS 1-4（署名付きURL基盤）のうち、署名へ焼き込む値を決める判定の受入テスト。
//
// 根拠: v13 §5.11.5（contentType の制限・サイズ上限）・§5.11.7（対応形式・用途タグ必須）・
//       §7「★ メディアアセット」（ファイル種別 image / video / pdf）、
//       2026-09-22 オーナー決定 A（画像20MB／動画200MB）・同 C（正本 §7 の全面採用）。

import {
  buildMediaObjectName,
  decideUploadPolicy,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MEDIA_PURPOSE_PRESETS,
  normalizeCaptureMetadata,
} from "@/lib/media/upload-policy";

/** 判定を通すための最小の要求。個々のテストは必要な項目だけを上書きする。 */
function uploadRequest(overrides: Partial<Parameters<typeof decideUploadPolicy>[0]> = {}) {
  return decideUploadPolicy({
    contentType: "image/jpeg",
    purposeTags: ["クエスト報告"],
    ...overrides,
  });
}

describe("対応形式（v13 §5.11.7 ／ §7）", () => {
  test.each(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"])(
    "画像 %s を受け入れる",
    (contentType) => {
      expect(uploadRequest({ contentType }).accepted).toBe(true);
    },
  );

  test.each(["video/mp4", "video/quicktime"])("動画 %s を受け入れる", (contentType) => {
    expect(uploadRequest({ contentType }).accepted).toBe(true);
  });

  test("PDF を受け入れる（正本 §7 の全面採用／2026-09-22 決定 C）", () => {
    expect(uploadRequest({ contentType: "application/pdf" }).accepted).toBe(true);
  });

  test("★ 実行可能ファイルは受け入れない（v13 §5.11.5）", () => {
    expect(uploadRequest({ contentType: "application/x-msdownload" }).accepted).toBe(false);
  });

  test("★ 許可リストにない形式は受け入れない（既定は拒否）", () => {
    expect(uploadRequest({ contentType: "text/html" }).accepted).toBe(false);
  });

  test("形式が空でも受け入れない", () => {
    expect(uploadRequest({ contentType: "" }).accepted).toBe(false);
  });
});

describe("ファイル種別の判定（`media_assets.media_type` の3値）", () => {
  test("JPEG は image になる", () => {
    const decision = uploadRequest({ contentType: "image/jpeg" });
    expect(decision.accepted && decision.mediaType).toBe("image");
  });

  test("MOV は video になる", () => {
    const decision = uploadRequest({ contentType: "video/quicktime" });
    expect(decision.accepted && decision.mediaType).toBe("video");
  });

  test("PDF は pdf になる", () => {
    const decision = uploadRequest({ contentType: "application/pdf" });
    expect(decision.accepted && decision.mediaType).toBe("pdf");
  });
});

describe("ファイルサイズ上限（2026-09-22 オーナー決定 A）", () => {
  test("画像の上限は 20MB である", () => {
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });

  test("動画の上限は 200MB である", () => {
    expect(MAX_VIDEO_BYTES).toBe(200 * 1024 * 1024);
  });

  test("画像は上限ちょうどなら通る", () => {
    expect(uploadRequest({ declaredSizeBytes: MAX_IMAGE_BYTES }).accepted).toBe(true);
  });

  test("画像は上限を1バイト超えると通らない", () => {
    expect(uploadRequest({ declaredSizeBytes: MAX_IMAGE_BYTES + 1 }).accepted).toBe(false);
  });

  test("★ 動画には動画の上限が当たる（画像の上限で弾かれない）", () => {
    expect(
      uploadRequest({ contentType: "video/mp4", declaredSizeBytes: MAX_IMAGE_BYTES + 1 }).accepted,
    ).toBe(true);
  });

  test("動画も上限を超えれば通らない", () => {
    expect(
      uploadRequest({ contentType: "video/mp4", declaredSizeBytes: MAX_VIDEO_BYTES + 1 }).accepted,
    ).toBe(false);
  });

  test("0 バイトの申告は通らない", () => {
    expect(uploadRequest({ declaredSizeBytes: 0 }).accepted).toBe(false);
  });

  test("サイズの申告が無くても署名は発行できる（強制はストレージ側／v13 §5.11.5）", () => {
    expect(uploadRequest({ declaredSizeBytes: undefined }).accepted).toBe(true);
  });

  test("受け入れた要求は上限バイト数を返す（署名へ焼き込むため）", () => {
    const decision = uploadRequest({ contentType: "video/mp4" });
    expect(decision.accepted && decision.maxBytes).toBe(MAX_VIDEO_BYTES);
  });
});

describe("用途タグ（v13 §5.11.7 ②・§5.11.3）", () => {
  test("★ 用途タグが無いと受け入れない（任意にしない）", () => {
    expect(uploadRequest({ purposeTags: [] }).accepted).toBe(false);
  });

  test("空白だけのタグは無いものとして扱う", () => {
    expect(uploadRequest({ purposeTags: ["   "] }).accepted).toBe(false);
  });

  test("★ プリセットにない語も受け入れる（フォークソノミー／v13 §5.11.3）", () => {
    expect(uploadRequest({ purposeTags: ["秋の収穫祭2026"] }).accepted).toBe(true);
  });

  test("プリセットは v13 §5.11.7 ② の7種である", () => {
    expect(MEDIA_PURPOSE_PRESETS).toHaveLength(7);
  });

  test("前後の空白を落として保存する", () => {
    const decision = uploadRequest({ purposeTags: ["  施設紹介  "] });
    expect(decision.accepted && decision.normalizedPurposeTags).toEqual(["施設紹介"]);
  });

  test("重複したタグは1つにまとめる", () => {
    const decision = uploadRequest({ purposeTags: ["施設紹介", "施設紹介"] });
    expect(decision.accepted && decision.normalizedPurposeTags).toEqual(["施設紹介"]);
  });

  test("タグが多すぎる場合は受け入れない", () => {
    const tooManyTags = Array.from({ length: 11 }, (_, index) => `タグ${index}`);
    expect(uploadRequest({ purposeTags: tooManyTags }).accepted).toBe(false);
  });

  test("長すぎるタグは受け入れない", () => {
    expect(uploadRequest({ purposeTags: ["あ".repeat(41)] }).accepted).toBe(false);
  });
});

describe("ストレージ上のオブジェクト名", () => {
  const uploadedAt = new Date("2026-09-22T07:00:00.000Z");
  const mediaId = "11111111-2222-4333-8444-555555555555";

  test("年月で分けた配下に メディアID で置く", () => {
    expect(buildMediaObjectName({ mediaId, extension: "jpg", uploadedAt })).toBe(
      `media/2026/09/${mediaId}.jpg`,
    );
  });

  test("★ 会員IDをパスに含めない（URL が漏れても投稿者が漏れない）", () => {
    expect(buildMediaObjectName({ mediaId, extension: "jpg", uploadedAt })).not.toContain("member");
  });

  test("月は2桁で揃える（接頭辞でライフサイクルを当てるため）", () => {
    const january = new Date("2026-01-05T00:00:00.000Z");
    expect(buildMediaObjectName({ mediaId, extension: "mp4", uploadedAt: january })).toContain(
      "media/2026/01/",
    );
  });
});

// ── 2026-09-22 追加：撮影メタデータ（Exif 由来・クライアント申告）の受け入れ判定 ──────

describe("撮影メタデータの正規化（v13 §5.11.7 ③）", () => {
  test("読めない撮影日時はアップロードを止めず、値だけを捨てる", () => {
    expect(normalizeCaptureMetadata({ takenAt: "きのう" }).takenAt).toBeNull();
  });

  test("未来の撮影日時は受け付けない（端末の時計ずれ・改変）", () => {
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(normalizeCaptureMetadata({ takenAt: nextYear }).takenAt).toBeNull();
  });

  test("日本時間で申告された撮影日時を UTC へ揃えて保存する", () => {
    expect(normalizeCaptureMetadata({ takenAt: "2026-09-22T07:30:00+09:00" }).takenAt).toBe(
      "2026-09-21T22:30:00.000Z",
    );
  });

  test("緯度・経度の範囲外を受け付けない", () => {
    expect(normalizeCaptureMetadata({ geoLocation: "91.000000,139.767050" }).geoLocation).toBeNull();
  });

  test("座標の形でない文字列を受け付けない", () => {
    expect(normalizeCaptureMetadata({ geoLocation: "東京駅" }).geoLocation).toBeNull();
  });

  test("座標は小数6桁へ揃える（端末ごとの桁数の揺れを持ち込まない）", () => {
    expect(normalizeCaptureMetadata({ geoLocation: "35.6812,139.76705" }).geoLocation).toBe(
      "35.681200,139.767050",
    );
  });

  test("撮影メタデータが無い投稿でも両方 null で成立する", () => {
    expect(normalizeCaptureMetadata({})).toEqual({ takenAt: null, geoLocation: null });
  });
});
