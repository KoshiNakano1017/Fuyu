/**
 * 顧客一覧の既定の並び順（WBS 8-5 ／ v13 §5.6.7・§9 #43）。
 *
 * 仕様の4段をそのまま写す。
 *   ① チェックイン中（滞在中）を最上部に固定
 *   ② 未処理差額あり（§5.6.6）
 *   ③ 未会計額の大きい順
 *   ④ 最終来訪日の新しい順
 *
 * 滞在中グループの内部順序だけは別で、**チェックイン日時の古い順**である
 * （＝退去が近い人が上。退去対応の取りこぼしを防ぐ）。
 *
 * ## なぜ DB の ORDER BY にしないのか
 *
 * 「未処理差額あり」「未会計額」は別テーブル（`settlement_adjustments` / `orders`）の
 * 集計であり、1本の SELECT に押し込むと読めないクエリになる。
 * それ以上に、**この並びは仕様そのもの**なので、試験できる形で置いておきたい。
 */

export type CustomerRow = {
  memberId: string;
  /** `v_member_public` 由来の表示名。実名は含まない */
  displayName: string;
  memberType: string;
  /** 滞在中か（`check_ins.status = 'staying'`） */
  isStaying: boolean;
  /** 滞在中のチェックイン日。滞在外は `null` */
  checkInDate: string | null;
  /** 未処理の差額を持つか（v13 §5.6.6 の再訪アラートと同じ判定） */
  hasPendingAdjustment: boolean;
  unsettledYen: number;
  unsettledUii: number;
  /** 最終来訪日。一度も来ていなければ `null` */
  lastVisitDate: string | null;
};

/**
 * 既定の並び順へ整える。**元の配列は変更しない。**
 *
 * 同順位のときの最後のよりどころは `memberId` である。
 * 決め手を置かないと、条件が全部同じ顧客の並びが読み出しのたびに入れ替わり、
 * 「さっき上にいた人がいない」と見える。
 */
export function sortCustomers(rows: readonly CustomerRow[]): CustomerRow[] {
  return [...rows].sort((left, right) => {
    // ① 滞在中を最上部へ
    if (left.isStaying !== right.isStaying) {
      return left.isStaying ? -1 : 1;
    }

    if (left.isStaying && right.isStaying) {
      // 滞在中グループはチェックイン日の古い順（退去が近い人が上）
      const byCheckIn = compareText(left.checkInDate, right.checkInDate, "asc");
      if (byCheckIn !== 0) {
        return byCheckIn;
      }
      return left.memberId.localeCompare(right.memberId);
    }

    // ② 未処理差額あり
    if (left.hasPendingAdjustment !== right.hasPendingAdjustment) {
      return left.hasPendingAdjustment ? -1 : 1;
    }
    // ③ 未会計額の大きい順
    if (left.unsettledYen !== right.unsettledYen) {
      return right.unsettledYen - left.unsettledYen;
    }
    // ④ 最終来訪日の新しい順
    const byVisit = compareText(left.lastVisitDate, right.lastVisitDate, "desc");
    if (byVisit !== 0) {
      return byVisit;
    }
    return left.memberId.localeCompare(right.memberId);
  });
}

/**
 * 滞在中と滞在外へ分ける（v13 §5.6.7「セクション見出しを付け、滞在外と明確に分ける」）。
 *
 * 見出しに件数を出すために、画面側で `filter` を2回書かせない。
 */
export function groupByStay(rows: readonly CustomerRow[]): {
  staying: CustomerRow[];
  away: CustomerRow[];
} {
  const sorted = sortCustomers(rows);
  return {
    staying: sorted.filter((row) => row.isStaying),
    away: sorted.filter((row) => !row.isStaying),
  };
}

/**
 * 氏名・ニックネームの部分一致検索（v13 §5.6.7「滞在状態に関わらず全件を対象」）。
 *
 * ⚠️ **電話番号は対象にしない。** 仕様は氏名・ニックネーム・電話番号を挙げるが、
 * 電話番号は `member_profiles_private`（PII-A）にあり、この一覧は
 * `v_member_public` の表示名しか持たない。検索のためだけに PII を一覧へ運ぶと、
 * 画面に出さない情報までサーバからクライアントへ渡ることになる。
 * 電話番号での検索は、PII を扱う画面（WBS 2-4 の系列）側で実装する。
 */
export function filterCustomers(rows: readonly CustomerRow[], query: string): CustomerRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...rows];
  }
  return rows.filter((row) => row.displayName.toLowerCase().includes(needle));
}

/** `null` を常に後ろへ送る比較。日付文字列は ISO 形式なので辞書順で時系列になる。 */
function compareText(left: string | null, right: string | null, direction: "asc" | "desc"): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return direction === "asc" ? left.localeCompare(right) : right.localeCompare(left);
}
