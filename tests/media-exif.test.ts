// 写真の Exif から撮影日時・位置を取り出す実装の単体テスト（WBS 14-2 ／ v13 §5.11.7 ③）。
//
// ⚠️ **実写真をフィクスチャに置かない**（CLAUDE.md §3.2・§7.1）。
//    実際に撮られた写真の Exif には撮影者の行動履歴（位置・日時）が入るため、
//    ここでは合成した最小の JPEG をテスト内で組み立てて使う。
//
// 位置情報は PII-B（`DB物理設計.md` §6-1 #22）。この試験が扱う座標は
// 東京駅付近を指す**架空の値**であり、実在の会員の記録ではない。

import { readJpegExif } from "@/lib/media/exif";

/** TIFF の型番号 */
const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/**
 * 最小の JPEG（SOI ＋ APP1 ＋ EOI）を組み立てる。
 *
 * レイアウトは Exif 規格そのままで、TIFF 先頭からの絶対オフセットを値に書く。
 * 途中に画像データは入れない（この実装は APP1 しか見ないため）。
 */
function buildJpegWithExif(options: { dateTimeOriginal?: string; gps?: boolean }): Uint8Array {
  const tiff = new Uint8Array(178);
  const view = new DataView(tiff.buffer);
  const LE = true;

  // TIFF ヘッダ（リトルエンディアン）
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  view.setUint16(2, 42, LE);
  view.setUint32(4, 8, LE);

  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    view.setUint16(at, tag, LE);
    view.setUint16(at + 2, type, LE);
    view.setUint32(at + 4, count, LE);
    view.setUint32(at + 8, value, LE);
  };
  const asciiInline = (at: number, text: string) => {
    view.setUint16(at, 0, LE); // タグは呼び出し側が上書きする
    for (let i = 0; i < text.length; i += 1) {
      tiff[at + 8 + i] = text.charCodeAt(i);
    }
  };

  // IFD0: Exif ポインタ（38）と GPS ポインタ（76）
  view.setUint16(8, 2, LE);
  entry(10, 0x8769, TYPE_LONG, 1, 38);
  entry(22, 0x8825, TYPE_LONG, 1, 76);
  view.setUint32(34, 0, LE);

  // Exif IFD: DateTimeOriginal（文字列本体は 56 から）
  view.setUint16(38, 1, LE);
  entry(40, 0x9003, TYPE_ASCII, 20, 56);
  view.setUint32(52, 0, LE);
  const stamp = options.dateTimeOriginal ?? "2026:09:22 07:30:00";
  for (let i = 0; i < stamp.length; i += 1) {
    tiff[56 + i] = stamp.charCodeAt(i);
  }

  // GPS IFD
  view.setUint16(76, options.gps === false ? 0 : 4, LE);
  entry(78, 0x0001, TYPE_ASCII, 2, 0);
  asciiInline(78, "N");
  view.setUint16(78, 0x0001, LE);
  entry(90, 0x0002, TYPE_RATIONAL, 3, 130);
  entry(102, 0x0003, TYPE_ASCII, 2, 0);
  asciiInline(102, "E");
  view.setUint16(102, 0x0003, LE);
  entry(114, 0x0004, TYPE_RATIONAL, 3, 154);
  view.setUint32(126, 0, LE);

  const rational = (at: number, numerator: number, denominator: number) => {
    view.setUint32(at, numerator, LE);
    view.setUint32(at + 4, denominator, LE);
  };
  // 北緯 35°40′52.32″ ／ 東経 139°46′1.38″（架空の座標）
  rational(130, 35, 1);
  rational(138, 40, 1);
  rational(146, 5232, 100);
  rational(154, 139, 1);
  rational(162, 46, 1);
  rational(170, 138, 100);

  const app1Length = 2 + 6 + tiff.length;
  const jpeg = new Uint8Array(2 + 2 + app1Length + 2);
  jpeg.set([0xff, 0xd8, 0xff, 0xe1], 0);
  jpeg[4] = (app1Length >> 8) & 0xff;
  jpeg[5] = app1Length & 0xff;
  jpeg.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6); // "Exif\0\0"
  jpeg.set(tiff, 12);
  jpeg.set([0xff, 0xd9], 12 + tiff.length);
  return jpeg;
}

describe("撮影日時（Exif DateTimeOriginal）", () => {
  test("Exif の日時を日本時間として読む", () => {
    expect(readJpegExif(buildJpegWithExif({})).takenAt).toBe("2026-09-22T07:30:00+09:00");
  });

  test("形式の違う日時は読み替えず捨てる", () => {
    const jpeg = buildJpegWithExif({ dateTimeOriginal: "2026/09/22 07:30" });
    expect(readJpegExif(jpeg).takenAt).toBeNull();
  });
});

describe("撮影位置（Exif GPS）", () => {
  test("度分秒と方位から十進度の座標を組み立てる", () => {
    expect(readJpegExif(buildJpegWithExif({})).geoLocation).toBe("35.681200,139.767050");
  });

  test("GPS が無い写真では位置を空のまま返す（0,0 で埋めない）", () => {
    expect(readJpegExif(buildJpegWithExif({ gps: false })).geoLocation).toBeNull();
  });
});

describe("JPEG でないバイト列", () => {
  test("SOI の無いファイルからは何も読まない", () => {
    expect(readJpegExif(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toEqual({
      takenAt: null,
      geoLocation: null,
    });
  });

  test("空のバイト列でも例外を投げない", () => {
    expect(() => readJpegExif(new Uint8Array())).not.toThrow();
  });
});
