// 「今日の浮遊街サマリー」の数え上げ（WBS 13-1 ／ 画面ID C1）の単体テスト。
//
// 固定する完了条件:
//  1 今日の到着・出発をそれぞれ数える（日帰りは両方に数える）
//  2 募集中（`open`）以外のクエストを枠に数えない
//  3 未送付の Eumo 給付に「送付失敗」を混ぜない
//  4 今日の朝会が記録されているかを `heldOn` で見る（作成日で見ない）
//  5 AI 起案候補は**未処理**だけを数える
//
// ⚠️ ここは「数えるだけで判断はしない」境界を守るテストである。閾値判断（滞留14日超など）を
//    この層へ持ち込むと、一覧と同じ判断が2箇所にでき、片方だけ直したときに食い違う。

import {
  countArrivalsAndDepartures,
  countOpenQuests,
  countPendingGrants,
  countUnhandledQuestCandidates,
  isMorningMeetingRecorded,
  morningMeetingLabel,
  sumCirculatedUii,
} from "@/lib/dashboard/today-summary";

const TODAY = "2026-09-26";

describe("今日の出入りを数える（モック ⑫「チェックイン/アウト予定」）", () => {
  test("到着と出発を別々に数える", () => {
    const stays = [
      { checkInDate: TODAY, checkOutDate: "2026-09-28" },
      { checkInDate: "2026-09-24", checkOutDate: TODAY },
      { checkInDate: "2026-09-24", checkOutDate: "2026-09-30" },
    ];
    expect(countArrivalsAndDepartures(stays, TODAY)).toEqual({ arrivals: 1, departures: 1 });
  });

  test("★ 日帰りは到着にも出発にも数える（合計へ丸めない）", () => {
    // 同じ滞在でもフロントの仕事は2回発生する。片方に寄せると受け入れ準備が抜ける。
    const stays = [{ checkInDate: TODAY, checkOutDate: TODAY }];
    expect(countArrivalsAndDepartures(stays, TODAY)).toEqual({ arrivals: 1, departures: 1 });
  });

  test("今日にかからない滞在は数えない", () => {
    const stays = [{ checkInDate: "2026-09-20", checkOutDate: "2026-09-30" }];
    expect(countArrivalsAndDepartures(stays, TODAY)).toEqual({ arrivals: 0, departures: 0 });
  });

  test("1件も無ければ0件", () => {
    expect(countArrivalsAndDepartures([], TODAY)).toEqual({ arrivals: 0, departures: 0 });
  });
});

describe("募集中クエスト枠（ボードに出ているものと件数を合わせる）", () => {
  test("`open` だけを数える", () => {
    expect(
      countOpenQuests([{ status: "open" }, { status: "closed" }, { status: "archived" }]),
    ).toBe(1);
  });

  test("★ 募集終了・過去分を枠に数えない", () => {
    // 数えてしまうと「枠があると聞いて開いたのに無い」状態になる。
    expect(countOpenQuests([{ status: "closed" }, { status: "archived" }])).toBe(0);
  });
});

describe("未送付の Eumo 給付（v13 §5.3.1）", () => {
  test("`未送付` を数える", () => {
    expect(countPendingGrants([{ status: "未送付" }, { status: "未送付" }])).toBe(2);
  });

  test("★ 送付失敗を未送付へ混ぜない（次に取る操作が違う）", () => {
    expect(
      countPendingGrants([{ status: "送付失敗" }, { status: "送付済" }, { status: "受領確認済" }]),
    ).toBe(0);
  });
});

describe("今日の朝会（v13 §5.1）", () => {
  test("今日の `heldOn` があれば記録済み", () => {
    expect(isMorningMeetingRecorded([{ heldOn: TODAY }], TODAY)).toBe(true);
  });

  test("★ 前日分だけなら今日は未実施（作成日で判断しない）", () => {
    expect(isMorningMeetingRecorded([{ heldOn: "2026-09-25" }], TODAY)).toBe(false);
  });

  test("表示語は変換表から取る（画面側で文字列を書かない）", () => {
    expect(morningMeetingLabel(true)).toBe("記録済み");
    expect(morningMeetingLabel(false)).toBe("未実施");
  });
});

describe("AI 起案候補は未処理だけを数える", () => {
  test("複数の議事録をまたいで合計する", () => {
    expect(
      countUnhandledQuestCandidates([
        { candidates: [{ status: "pending" }, { status: "published" }] },
        { candidates: [{ status: "pending" }] },
      ]),
    ).toBe(2);
  });

  test("★ 公開済み・却下済みは数えない（もう終わった仕事）", () => {
    expect(
      countUnhandledQuestCandidates([
        { candidates: [{ status: "published" }, { status: "dismissed" }] },
      ]),
    ).toBe(0);
  });

  test("候補が空の議事録があっても落ちない", () => {
    expect(countUnhandledQuestCandidates([{ candidates: [] }])).toBe(0);
  });
});

describe("Uii流通量は累計（v13 §9 #69 ／ 2026-09-26 オーナー確定）", () => {
  test("保存済みの Uii を足す（円から計算し直さない）", () => {
    expect(
      sumCirculatedUii([
        { status: "精算済み", totalAmountUii: 2400 },
        { status: "未会計", totalAmountUii: 800 },
      ]),
    ).toBe(3200);
  });

  test("★ 未会計も数える（会計ステータスは回収の話であって取引の有無ではない）", () => {
    expect(sumCirculatedUii([{ status: "未会計", totalAmountUii: 800 }])).toBe(800);
  });

  test("★ 取消だけを除く（取引そのものが無かったことにする区分）", () => {
    expect(
      sumCirculatedUii([
        { status: "取消", totalAmountUii: 5000 },
        { status: "精算済み", totalAmountUii: 100 },
      ]),
    ).toBe(100);
  });

  test("1件も無ければ0", () => {
    expect(sumCirculatedUii([])).toBe(0);
  });
});
