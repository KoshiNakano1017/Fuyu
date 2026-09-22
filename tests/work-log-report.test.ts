// 完了報告の入力判定（WBS 5-3 ／ v13 §5.3-4）の単体テスト。
//
// 写真の必須は **DDL ではなくアプリ層**が担保すると `0017` が決めている
// （縛るとメディア基盤の完成まで完了報告そのものが出せなくなるため）。
// つまりこの試験が、その担保の実体である。

import {
  decideWorkLogSubmission,
  MAX_WORK_HOURS,
  parseWorkHours,
} from "@/lib/quests/work-log-report";

const VALID = {
  applicationStatus: "指示済み",
  beforePhotoMediaId: "m-before",
  afterPhotoMediaId: "m-after",
  workHours: 2,
  issueFlag: false,
  issueNote: "",
};

describe("提出できる状態（v13 §5.3-3・§5.3-4）", () => {
  test("実行指示が出ていれば提出できる", () => {
    expect(decideWorkLogSubmission(VALID)).toEqual({ allowed: true });
  });

  test("申請中のまま報告できない（指示の前に作業が終わっている状態を作らない）", () => {
    expect(decideWorkLogSubmission({ ...VALID, applicationStatus: "申請中" })).toEqual({
      allowed: false,
      reason: "not_instructed",
    });
  });

  test("キャンセルした受注では報告できない", () => {
    expect(decideWorkLogSubmission({ ...VALID, applicationStatus: "キャンセル" })).toEqual({
      allowed: false,
      reason: "not_instructed",
    });
  });
});

describe("写真の必須（アプリ層で担保する ／ `0017` の申し送り）", () => {
  test("作業前の写真が無ければ提出できない", () => {
    expect(decideWorkLogSubmission({ ...VALID, beforePhotoMediaId: null })).toEqual({
      allowed: false,
      reason: "missing_before_photo",
    });
  });

  test("作業後の写真が無ければ提出できない", () => {
    expect(decideWorkLogSubmission({ ...VALID, afterPhotoMediaId: null })).toEqual({
      allowed: false,
      reason: "missing_after_photo",
    });
  });
});

describe("作業時間（自己申告）", () => {
  test("未入力でも提出できる（報酬は運営が決めた額であり、時間では決まらない）", () => {
    expect(decideWorkLogSubmission({ ...VALID, workHours: null })).toEqual({ allowed: true });
  });

  test("0時間は受け付けない", () => {
    expect(decideWorkLogSubmission({ ...VALID, workHours: 0 })).toEqual({
      allowed: false,
      reason: "invalid_work_hours",
    });
  });

  test("24時間を超える申告は受け付けない", () => {
    expect(decideWorkLogSubmission({ ...VALID, workHours: MAX_WORK_HOURS + 1 })).toEqual({
      allowed: false,
      reason: "invalid_work_hours",
    });
  });

  test("空欄は「未入力」として null になる", () => {
    expect(parseWorkHours("  ")).toBeNull();
  });

  test("数値でない入力は読み替えず弾く", () => {
    expect(parseWorkHours("にじかん")).toBe("invalid");
  });

  test("15分単位の申告を小数で受ける", () => {
    expect(parseWorkHours("1.25")).toBe(1.25);
  });
});

describe("気づいた問題（v13 §5.3-4）", () => {
  test("問題ありのチェックだけで中身が無ければ提出できない", () => {
    expect(
      decideWorkLogSubmission({ ...VALID, issueFlag: true, issueNote: "   " }),
    ).toEqual({ allowed: false, reason: "blank_issue_note" });
  });

  test("問題の内容が書かれていれば提出できる", () => {
    expect(
      decideWorkLogSubmission({ ...VALID, issueFlag: true, issueNote: "刈払機の刃が欠けていた" }),
    ).toEqual({ allowed: true });
  });
});
