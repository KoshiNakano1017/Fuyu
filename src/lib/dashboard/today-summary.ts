// 「今日の浮遊街サマリー」の数え上げ（画面ID C1 ／ WBS 13-1）。
//
// ## 数えるだけで、判断はしない
//
// ここに置くのは**今日の実数を数える純関数だけ**である。「対応が必要か」の閾値判断は
// 各画面が持っている。ダッシュボードが独自の閾値で警告を出すと判断の出所が2つになり、
// 「一覧では要対応なのにサマリーは無言」という食い違いが起きる。
//
// 例: モック ⑫ の「⚠️ 14日超の滞留」はここに持ち込まない。滞留の判定は
// `src/lib/eumo/grants.ts` の `isStaleSentGrant()` が正本であり、Eumo給付一覧（B10）の役目である。
//
// ## なぜ DB へ集計を寄せないのか
//
// 件数は各一覧の取得結果を数えて出す。専用の集計ビューを足すと、一覧と件数が食い違ったときに
// どちらが正しいか分からなくなる（残枠だけは `v_room_availability` が正本なのでビューを読む）。
// その代わり**数え方は純関数にして試験できる形にする**（DB もセッションも要らない）。

/** 滞在1件のうち、数えるために要る列だけ。`StayEntry` の部分型として受ける。 */
export type CountableStay = {
  checkInDate: string;
  checkOutDate: string;
};

export type ArrivalsAndDepartures = {
  /** 今日チェックインする（した）件数。 */
  arrivals: number;
  /** 今日チェックアウトする（した）件数。 */
  departures: number;
};

/**
 * 今日の出入り（モック ⑫「チェックイン/アウト予定」）。
 *
 * ⚠️ **同じ滞在が両方に数えられることがある**（日帰り＝当日チェックイン・当日チェックアウト）。
 * これは重複ではなく、フロントの仕事が2回発生するという意味なので、合計へ丸めない。
 */
export function countArrivalsAndDepartures(
  stays: readonly CountableStay[],
  today: string,
): ArrivalsAndDepartures {
  return {
    arrivals: stays.filter((stay) => stay.checkInDate === today).length,
    departures: stays.filter((stay) => stay.checkOutDate === today).length,
  };
}

/**
 * 募集中のクエスト枠（モック ⑫「募集中クエスト枠」）。
 *
 * `closed`（募集終了）・`archived`（過去分）を数えない。ボードに出ているものと件数が
 * 合わないと「枠があると聞いて開いたのに無い」状態になる。
 */
export function countOpenQuests(quests: readonly { status: string }[]): number {
  return quests.filter((quest) => quest.status === "open").length;
}

/**
 * 未送付の Eumo 給付（v13 §5.3.1 ／ モック ⑫ の v1.15.0 #35 カード）。
 *
 * **送付失敗を未送付へ混ぜない。** 失敗は「送ったが届かなかった」であり、
 * 運営が次に取る操作（再送・連絡先の確認）が未送付とは違う（`grants.ts` の `GrantStatus`）。
 */
export function countPendingGrants(grants: readonly { status: string }[]): number {
  return grants.filter((grant) => grant.status === "未送付").length;
}

/**
 * 今日の朝会が記録済みか（モック ⑫「朝会議事録」＝生成済み／未実施）。
 *
 * `heldOn` は朝会を開いた日で、記録を作った日ではない。前日分を翌朝に入力しても
 * 「今日の朝会」にはならない（v13 §5.1）。
 */
export function isMorningMeetingRecorded(
  meetings: readonly { heldOn: string }[],
  today: string,
): boolean {
  return meetings.some((meeting) => meeting.heldOn === today);
}

/** 朝会カードの表示語。画面側で文字列を書かないための変換表。 */
export function morningMeetingLabel(isRecorded: boolean): string {
  return isRecorded ? "記録済み" : "未実施";
}

/**
 * AI が起案し、まだ公開されていない候補の件数（モック ⑫「AI起案 N件公開」の材料）。
 *
 * 公開済みではなく**未処理（`pending`）**を数える。公開済みの件数は「もう終わった仕事」であり、
 * ダッシュボードが拾う理由が無い（残っている仕事だけを出す）。
 */
export function countUnhandledQuestCandidates(
  meetings: readonly { candidates: readonly { status: string }[] }[],
): number {
  return meetings.reduce(
    (total, meeting) =>
      total + meeting.candidates.filter((candidate) => candidate.status === "pending").length,
    0,
  );
}

/**
 * Uii 流通量の**累計**（v13 §9 #69 ／ 決定ログ §25-2 ／ 2026-09-26 オーナー確定）。
 *
 * ## このカードだけ集計の窓が違う
 *
 * ダッシュボードの他の数字は「今日の実数」だが、**これは全期間の累計**である。
 * オーナー決定が累計だったため、軸が1枚だけ違う形になっている。
 * ⚠️ **画面側で「累計」と明示すること。** 明示しないと当日分と読まれる（§9 #69 の警告）。
 *
 * ## 残高合計ではない
 *
 * 会員が持っている未使用の Uii を足したものではない。それは「滞留量」であって流通量ではない
 * （§9 #69 で不採用にした案）。
 *
 * ## 保存済みの Uii を足す（円から計算し直さない）
 *
 * `sumUnsettled()` と同じ理由である。円の合計に 0.8 を掛け直すと、単品ごとの切り捨て
 * （v13 §5.5）と結果がずれ、伝票の合計と画面の合計が一致しなくなる。保存値は当時の事実である。
 *
 * ## 取消だけを除く
 *
 * `未会計` も数える。会計ステータスは**回収が済んだか**を表すもので、取引が起きたかどうかとは
 * 別である（v13 §5.4.1 の「2軸は独立」と同じ考え方）。取消は取引そのものが無かったことにする
 * 区分なので除く。
 */
export function sumCirculatedUii(
  orders: readonly { status: string; totalAmountUii: number }[],
): number {
  return orders
    .filter((order) => order.status !== "取消")
    .reduce((total, order) => total + order.totalAmountUii, 0);
}
