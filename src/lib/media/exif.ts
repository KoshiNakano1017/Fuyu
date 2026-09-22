/**
 * 写真の Exif から撮影日時・撮影位置だけを取り出す（v13 §5.11.7 ③）。
 *
 * ## なぜ自前で読むのか
 *
 * 必要なのは **2項目だけ**（`DateTimeOriginal` と GPS 座標）で、向き補正も
 * サムネイル抽出もしない。exif ライブラリは数十〜百KB を**クライアントバンドルへ**載せる。
 * アップロード画面は現場のスマートフォンから開かれる（v13 §5.11.7 ①）ため、
 * 通信量をこの2項目のために増やす理由が無い。
 *
 * ## 読めないものは読めないまま返す
 *
 * 対応するのは **JPEG の APP1（Exif）だけ**である。HEIC・MOV のメタデータは
 * まったく別の容器（ISO BMFF）に入っており、同じ手では読めない。
 * それらは `null` を返す＝**撮影日時・位置が空のまま登録される**。
 * ここで推測値（ファイルの更新日時など）を埋めないのは、
 * 「撮影日時」として保存された値が実は別物、という状態を作らないためである。
 *
 * ## 位置情報は PII-B である
 *
 * 戻り値の `geoLocation` は `media_assets.geo_location`（`DB物理設計.md` §6-1 #22）に入る。
 * **ログへ出さない**（CLAUDE.md §3.2）。この関数自身も一切ログを出さない。
 */

export type ExifCaptureMetadata = {
  /** ISO 8601（日本時間）。Exif に無ければ `null` */
  takenAt: string | null;
  /** `"35.681236,139.767125"`。Exif に無ければ `null` */
  geoLocation: string | null;
};

const EMPTY: ExifCaptureMetadata = { takenAt: null, geoLocation: null };

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_LONGITUDE = 0x0004;

/**
 * JPEG のバイト列から撮影日時・撮影位置を取り出す。
 *
 * ファイル全体を渡す必要はない。Exif は先頭付近の APP1 セグメントにあるため、
 * 呼び出し側は先頭数百KB だけを読んで渡してよい（`readCaptureMetadataFromFile()` がそうする）。
 */
export function readJpegExif(bytes: Uint8Array): ExifCaptureMetadata {
  const app1 = findExifApp1(bytes);
  if (app1 === null) {
    return EMPTY;
  }

  const tiff = new DataView(bytes.buffer, bytes.byteOffset + app1, bytes.byteLength - app1);
  const byteOrder = readByteOrder(tiff);
  if (byteOrder === null) {
    return EMPTY;
  }
  const littleEndian = byteOrder === "II";

  // TIFF ヘッダ: [0..1] バイトオーダー / [2..3] 42 / [4..7] IFD0 へのオフセット
  const ifd0Offset = safeUint32(tiff, 4, littleEndian);
  if (ifd0Offset === null) {
    return EMPTY;
  }

  const ifd0 = readIfd(tiff, ifd0Offset, littleEndian);
  const exifIfdOffset = readPointer(tiff, ifd0, TAG_EXIF_IFD_POINTER, littleEndian);
  const gpsIfdOffset = readPointer(tiff, ifd0, TAG_GPS_IFD_POINTER, littleEndian);

  const exifIfd = exifIfdOffset === null ? [] : readIfd(tiff, exifIfdOffset, littleEndian);
  const gpsIfd = gpsIfdOffset === null ? [] : readIfd(tiff, gpsIfdOffset, littleEndian);

  return {
    takenAt: readDateTimeOriginal(tiff, exifIfd, littleEndian),
    geoLocation: readGeoLocation(tiff, gpsIfd, littleEndian),
  };
}

/** APP1（Exif）の TIFF ヘッダ先頭位置。見つからなければ `null`。 */
function findExifApp1(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null; // SOI が無い ＝ JPEG ではない
  }

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null; // マーカー境界を見失った。壊れた JPEG を推測で読み進めない
    }
    const marker = bytes[offset + 1];
    // SOS（画像データの開始）まで来たらメタデータ領域は終わり
    if (marker === 0xda) {
      return null;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2) {
      return null;
    }
    if (marker === 0xe1 && hasExifHeader(bytes, offset + 4)) {
      return offset + 4 + 6; // "Exif\0\0" の次から TIFF ヘッダ
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function hasExifHeader(bytes: Uint8Array, at: number): boolean {
  const EXIF = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  return EXIF.every((byte, index) => bytes[at + index] === byte);
}

function readByteOrder(tiff: DataView): "II" | "MM" | null {
  if (tiff.byteLength < 8) {
    return null;
  }
  const first = tiff.getUint8(0);
  const second = tiff.getUint8(1);
  if (first === 0x49 && second === 0x49) {
    return "II";
  }
  if (first === 0x4d && second === 0x4d) {
    return "MM";
  }
  return null;
}

type IfdEntry = { tag: number; type: number; count: number; valueOffset: number };

/** IFD のエントリを読む。壊れていれば読めたところまでを返す（例外にしない）。 */
function readIfd(tiff: DataView, offset: number, littleEndian: boolean): IfdEntry[] {
  if (offset + 2 > tiff.byteLength) {
    return [];
  }
  const count = tiff.getUint16(offset, littleEndian);
  const entries: IfdEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    const at = offset + 2 + index * 12;
    if (at + 12 > tiff.byteLength) {
      break;
    }
    entries.push({
      tag: tiff.getUint16(at, littleEndian),
      type: tiff.getUint16(at + 2, littleEndian),
      count: tiff.getUint32(at + 4, littleEndian),
      valueOffset: at + 8,
    });
  }
  return entries;
}

/** 値の格納場所を解決する。4バイトに収まる値は entry の中に直接入っている（TIFF の規約）。 */
function resolveValueOffset(tiff: DataView, entry: IfdEntry, littleEndian: boolean): number | null {
  const typeSize = TYPE_SIZES[entry.type];
  if (typeSize === undefined) {
    return null;
  }
  const totalBytes = typeSize * entry.count;
  if (totalBytes <= 4) {
    return entry.valueOffset;
  }
  const offset = safeUint32(tiff, entry.valueOffset, littleEndian);
  return offset === null || offset >= tiff.byteLength ? null : offset;
}

/** TIFF の型番号 → 1要素あたりのバイト数（使う型だけ）。 */
const TYPE_SIZES: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
};

/** IFD ポインタ（Exif / GPS）の指す先。 */
function readPointer(tiff: DataView, entries: readonly IfdEntry[], tag: number, littleEndian: boolean): number | null {
  const entry = entries.find((candidate) => candidate.tag === tag);
  if (entry === undefined) {
    return null;
  }
  const value = safeUint32(tiff, entry.valueOffset, littleEndian);
  return value === null || value >= tiff.byteLength ? null : value;
}

function safeUint32(tiff: DataView, at: number, littleEndian: boolean): number | null {
  return at + 4 <= tiff.byteLength ? tiff.getUint32(at, littleEndian) : null;
}

function readAscii(tiff: DataView, entry: IfdEntry, littleEndian: boolean): string | null {
  const offset = resolveValueOffset(tiff, entry, littleEndian);
  if (offset === null || entry.count === 0) {
    return null;
  }

  let text = "";
  for (let index = 0; index < entry.count - 1; index += 1) {
    const at = offset + index;
    if (at >= tiff.byteLength) {
      return null;
    }
    const code = tiff.getUint8(at);
    if (code === 0) {
      break;
    }
    text += String.fromCharCode(code);
  }
  return text === "" ? null : text;
}

/** RATIONAL（分子/分母）の配列。GPS の度・分・秒がこの形で入っている。 */
function readRationals(tiff: DataView, entry: IfdEntry, littleEndian: boolean): number[] | null {
  const offset = resolveValueOffset(tiff, entry, littleEndian);
  if (offset === null || entry.type !== 5) {
    return null;
  }

  const values: number[] = [];
  for (let index = 0; index < entry.count; index += 1) {
    const at = offset + index * 8;
    if (at + 8 > tiff.byteLength) {
      return null;
    }
    const denominator = tiff.getUint32(at + 4, littleEndian);
    if (denominator === 0) {
      return null; // 0 除算を「0 度」として通さない
    }
    values.push(tiff.getUint32(at, littleEndian) / denominator);
  }
  return values;
}

/**
 * 撮影日時。Exif の `DateTimeOriginal` は `"2026:09:22 07:30:00"` の形で、
 * **タイムゾーンを持たない**（`OffsetTimeOriginal` を書く端末もあるが必須ではない）。
 *
 * 浮遊街の現場は日本にあり、撮る端末も現地の時刻に合っている。
 * ここで UTC として解釈すると**9時間ずれた撮影日時**が保存されるため、
 * 日本時間として読む。判断の根拠を値に残す意味でも、オフセット付きの文字列で返す。
 */
function readDateTimeOriginal(
  tiff: DataView,
  entries: readonly IfdEntry[],
  littleEndian: boolean,
): string | null {
  const entry = entries.find((candidate) => candidate.tag === TAG_DATE_TIME_ORIGINAL);
  if (entry === undefined) {
    return null;
  }
  const raw = readAscii(tiff, entry, littleEndian);
  if (raw === null) {
    return null;
  }

  const matched = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (matched === null) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = matched;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
}

/** 度分秒 ＋ 方位（N/S/E/W）から十進度へ。南緯・西経は負になる。 */
function toDecimalDegrees(dms: readonly number[], ref: string): number | null {
  if (dms.length < 3) {
    return null;
  }
  const decimal = dms[0] + dms[1] / 60 + dms[2] / 3600;
  const upper = ref.trim().toUpperCase();
  if (upper === "S" || upper === "W") {
    return -decimal;
  }
  if (upper === "N" || upper === "E") {
    return decimal;
  }
  return null; // 方位が読めない座標は、符号を推測せず捨てる
}

/**
 * 撮影位置。**緯度・経度・方位のすべてが揃ったときだけ**値を返す。
 *
 * ⚠️ PII-B（`DB物理設計.md` §6-1 #22）。片方だけ揃った座標を 0 で埋めて返すと、
 * アフリカ沖（0,0）に大量の写真が並ぶだけでなく、**実際には位置が無いものを
 * 「位置がある」として扱う**ことになる。
 */
function readGeoLocation(
  tiff: DataView,
  entries: readonly IfdEntry[],
  littleEndian: boolean,
): string | null {
  const find = (tag: number) => entries.find((candidate) => candidate.tag === tag);

  const latitudeEntry = find(TAG_GPS_LATITUDE);
  const longitudeEntry = find(TAG_GPS_LONGITUDE);
  const latitudeRefEntry = find(TAG_GPS_LATITUDE_REF);
  const longitudeRefEntry = find(TAG_GPS_LONGITUDE_REF);
  if (
    latitudeEntry === undefined ||
    longitudeEntry === undefined ||
    latitudeRefEntry === undefined ||
    longitudeRefEntry === undefined
  ) {
    return null;
  }

  const latitude = readRationals(tiff, latitudeEntry, littleEndian);
  const longitude = readRationals(tiff, longitudeEntry, littleEndian);
  const latitudeRef = readAscii(tiff, latitudeRefEntry, littleEndian);
  const longitudeRef = readAscii(tiff, longitudeRefEntry, littleEndian);
  if (latitude === null || longitude === null || latitudeRef === null || longitudeRef === null) {
    return null;
  }

  const latitudeDegrees = toDecimalDegrees(latitude, latitudeRef);
  const longitudeDegrees = toDecimalDegrees(longitude, longitudeRef);
  if (latitudeDegrees === null || longitudeDegrees === null) {
    return null;
  }

  // 小数6桁 ≒ 0.1m。これ以上の桁は撮影端末の精度を超える
  return `${latitudeDegrees.toFixed(6)},${longitudeDegrees.toFixed(6)}`;
}

/**
 * ファイルの先頭だけを読んで撮影メタデータを取り出す（画面から呼ぶ入口）。
 *
 * 全体を読まないのは、200MB の動画をブラウザのメモリへ載せないためである。
 * Exif は APP1（先頭付近）にあるので、先頭 512KB で足りる。
 */
const EXIF_SCAN_BYTES = 512 * 1024;

export async function readCaptureMetadataFromFile(file: Blob): Promise<ExifCaptureMetadata> {
  // JPEG 以外は読まない（この実装が対応するのは APP1 だけ）。
  if (file.type !== "image/jpeg") {
    return EMPTY;
  }
  try {
    const head = await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer();
    return readJpegExif(new Uint8Array(head));
  } catch {
    // 読めないファイルでアップロード全体を止めない。撮影日時・位置が空になるだけである。
    return EMPTY;
  }
}
