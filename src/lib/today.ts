/**
 * 「今日」を日本時間で返す（`YYYY-MM-DD`）。
 *
 * ## なぜタイムゾーンを固定するのか
 *
 * 朝会・入退館・宿泊の日付はすべて運営の所在地（日本）で回っている。
 * サーバの既定タイムゾーンに任せると、**Vercel（UTC）で実行した朝9時が前日として扱われ**、
 * 当日の滞在が板から消える・変更の適用日が1日ずれる、といった形で静かに壊れる。
 *
 * 同じ式が `src/app/staff/checkins/page.tsx` と `src/app/admin/morning-meetings/page.tsx` に
 * 別々に置かれていたため、2026-09-26（WBS 3-10）でここへ寄せた。
 */
export function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}
