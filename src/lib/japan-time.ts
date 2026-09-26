/**
 * 日本時間（JST）で日付・日時を組み立てる小道具。
 *
 * ## なぜ専用の関数を通すのか
 *
 * `new Date().toISOString().slice(0, 10)` や引数なしの `toLocaleString("ja-JP")` は
 * **実行環境のタイムゾーンに従う**（Vercel / Node の既定は UTC で、リポジトリに `TZ` の設定は無い）。
 * 一方、DB 側の滞在日（`check_ins.check_in_date` / `check_out_date`）は**日本時間の `date`** であり、
 * 画面に出す日時も現場の運営・会員が見る日本時間である。
 * 揃えずに UTC で切ると **JST 00:00〜09:00 が前日になり**、日付の境界がまるごと1日ずれる
 * （既定表示月が毎月1日の朝だけ前月になる、滞在初日の朝の作業が窓から外れる、等）。
 *
 * サーバコンポーネントで描画する値は特に、ブラウザのタイムゾーンでは補正されない。
 * **タイムゾーンを明示した本モジュールを必ず経由する。**
 *
 * ## 2026-09-26：`src/lib/today.ts` を本モジュールへ統合した
 *
 * 同じ `todayInJapan()` が `today.ts`（WBS 3-10 の作業で2画面の重複を寄せたもの）と
 * 本モジュール（WBS 3-8 の作業で新設したもの）に**並行して生まれていた**。
 * 日時の組み立てが2箇所にあると、片方だけ直したときに画面ごとに境界がずれるため、
 * 日付書式まで面倒を見る本モジュールへ寄せ、`today.ts` は削除した。
 */

const JAPAN_TIME_ZONE = "Asia/Tokyo";

/**
 * 今日の日付（日本時間の `YYYY-MM-DD`）。
 *
 * `en-CA` ロケールは `YYYY-MM-DD` を返すため、書式の組み立てを自前でやらずに済む。
 */
export function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: JAPAN_TIME_ZONE }).format(new Date());
}

/** `timestamptz` を日本時間の日付（`YYYY-MM-DD`）にする。 */
export function toJapanDate(timestamptz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: JAPAN_TIME_ZONE }).format(
    new Date(timestamptz),
  );
}

/**
 * `timestamptz` を日本時間の日時（`2026/9/25 18:30:00` 形式）にする。
 *
 * キャンセル日時・注文日時のように「本人と運営が相互確認する」値に使う（v13 §5.2.2）。
 * 9時間ずれた日時を見せると、どの操作を指しているのか突き合わせられない。
 */
export function formatJapanDateTime(timestamptz: string): string {
  return new Date(timestamptz).toLocaleString("ja-JP", { timeZone: JAPAN_TIME_ZONE });
}
