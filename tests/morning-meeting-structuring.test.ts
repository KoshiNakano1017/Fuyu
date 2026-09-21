// 議事録の構造化（WBS 4-2）とクエスト候補の起案（WBS 4-3）の単体テスト。
//
// AI は `TextAiClient` のスタブに差し替える（`tests/ai-client.test.ts` が示した作法）。
// 実際のモデルを叩かないため、CI で API キーを要求しない。

import {
  buildStructuringRequest,
  formatMinutesText,
  structureMorningMeeting,
  type MorningMeetingStructuring,
} from "@/lib/morning-meetings/structure";
import {
  applyCorrection,
  markCandidate,
  pendingCandidates,
  toQuestInsertRow,
  toStoredCandidates,
} from "@/lib/morning-meetings/quest-candidates";
import type { TextAiClient } from "@/lib/ai/types";

const SAMPLE_OUTPUT: MorningMeetingStructuring = {
  minutes: {
    decisions: ["畑の水やり当番を週替わりにする"],
    shares: ["今週末はイベントのため来訪者が多い"],
    cautions: ["チェーンソーは資格保有者のみが扱う"],
  },
  questCandidates: [
    {
      title: "東の畑の草刈り",
      headcount: 2,
      estimatedMinutes: 120,
      assigneeCandidates: ["テスト街人"],
      sourceQuote: "東側の畑、草が伸びてるから午前中に2人くらいで刈っておきたいね",
    },
  ],
  knowledgeCandidates: [{ title: "水やり当番の回し方", body: "週替わりで2名ずつ担当する" }],
};

function stubAiClient(output: MorningMeetingStructuring): TextAiClient {
  return {
    generateStructured: async <T,>() => output as unknown as T,
  };
}

describe("構造化の依頼（v13 §5.1 ②③ ／ §5.7.4 ②）", () => {
  test("1回の依頼で議事録・クエスト候補・ナレッジ候補をすべて要求する", () => {
    const request = buildStructuringRequest("本文");
    const required = (request.jsonSchema as { required: string[] }).required;
    expect(required).toEqual(["minutes", "questCandidates", "knowledgeCandidates"]);
  });

  test("議事録は決定事項・共有事項・注意点の3区分を要求する", () => {
    const request = buildStructuringRequest("本文");
    const schema = request.jsonSchema as {
      properties: { minutes: { required: string[] } };
    };
    expect(schema.properties.minutes.required).toEqual(["decisions", "shares", "cautions"]);
  });

  test("投入された本文を加工せずそのまま依頼へ含める", () => {
    const body = "ゆうき: 東側の畑、草が伸びてるね";
    expect(buildStructuringRequest(body).prompt).toContain(body);
  });

  test("話者ラベルの有無どちらでも処理するよう指示する（投入経路の論点③が未確定のため）", () => {
    expect(buildStructuringRequest("本文").prompt).toContain("含まれない場合は本文だけで処理する");
  });
});

describe("構造化の実行", () => {
  test("スタブのAIクライアントから構造化結果を受け取れる", async () => {
    const result = await structureMorningMeeting({
      aiClient: stubAiClient(SAMPLE_OUTPUT),
      minutesBody: "本文",
    });
    expect(result.minutes.decisions).toEqual(["畑の水やり当番を週替わりにする"]);
  });

  test("本文が空ならAIを呼ばずに落とす", async () => {
    await expect(
      structureMorningMeeting({ aiClient: stubAiClient(SAMPLE_OUTPUT), minutesBody: "   " }),
    ).rejects.toThrow(RangeError);
  });
});

describe("議事録のテキスト整形", () => {
  test("決定事項・共有事項・注意点の見出しを付けて箇条書きにする", () => {
    const text = formatMinutesText({ heldOn: "2026-09-20", minutes: SAMPLE_OUTPUT.minutes });
    expect(text).toBe(
      [
        "【2026-09-20 朝会議事録】",
        "■決定事項",
        "・畑の水やり当番を週替わりにする",
        "■共有事項",
        "・今週末はイベントのため来訪者が多い",
        "■注意点",
        "・チェーンソーは資格保有者のみが扱う",
      ].join("\n"),
    );
  });

  test("項目が無い区分は「（なし）」と書く（見出しだけが残って空白に見えるのを防ぐ）", () => {
    const text = formatMinutesText({
      heldOn: "2026-09-20",
      minutes: { decisions: [], shares: [], cautions: [] },
    });
    expect(text).toContain("・（なし）");
  });
});

describe("クエスト候補の保持と補正（WBS 4-3）", () => {
  test("抽出直後の候補はすべて未処理である", () => {
    const stored = toStoredCandidates(SAMPLE_OUTPUT.questCandidates);
    expect(stored[0].status).toBe("pending");
  });

  test("候補には議事録内で一意な識別子が振られる", () => {
    const stored = toStoredCandidates([
      SAMPLE_OUTPUT.questCandidates[0],
      SAMPLE_OUTPUT.questCandidates[0],
    ]);
    expect(stored.map((candidate) => candidate.candidateId)).toEqual(["c1", "c2"]);
  });

  test("補正は指定した項目だけを差し替える", () => {
    const [candidate] = toStoredCandidates(SAMPLE_OUTPUT.questCandidates);
    const corrected = applyCorrection(candidate, { headcount: 3 });
    expect(corrected.headcount).toBe(3);
    expect(corrected.title).toBe("東の畑の草刈り");
  });

  test("公開済み・却下済みの候補は未処理の件数に数えない", () => {
    const stored = toStoredCandidates([
      SAMPLE_OUTPUT.questCandidates[0],
      SAMPLE_OUTPUT.questCandidates[0],
    ]);
    const afterPublish = markCandidate(stored, { candidateId: "c1", status: "published" });
    expect(pendingCandidates(afterPublish)).toHaveLength(1);
  });

  test("公開した候補には作られたクエストの識別子が残る", () => {
    const stored = toStoredCandidates(SAMPLE_OUTPUT.questCandidates);
    const afterPublish = markCandidate(stored, {
      candidateId: "c1",
      status: "published",
      publishedQuestId: "11111111-1111-1111-1111-111111111111",
    });
    expect(afterPublish[0].publishedQuestId).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("候補からクエスト行への写し（WBS 4-3）", () => {
  const [candidate] = toStoredCandidates(SAMPLE_OUTPUT.questCandidates);
  const createdByMemberId = "00000000-0000-0000-0000-0000000000a1";

  test("起案元区分は朝会自動抽出になる", () => {
    const row = toQuestInsertRow({ candidate, createdByMemberId });
    expect(row.origin_type).toBe("morning_meeting_auto");
  });

  test("ゲスト開放は候補の内容から導出せず必ず false にする（v13 §5.10.6）", () => {
    const row = toQuestInsertRow({ candidate, createdByMemberId });
    expect(row.guest_allowed).toBe(false);
  });

  test("報酬額は運営が補正で入力するまで未設定のままにする", () => {
    const row = toQuestInsertRow({ candidate, createdByMemberId });
    expect(row.reward_uii).toBeNull();
  });

  test("運営が補正で入力した報酬額は採用する", () => {
    const row = toQuestInsertRow({ candidate, correction: { rewardUii: 200 }, createdByMemberId });
    expect(row.reward_uii).toBe(200);
  });

  test("想定人数は募集人数へ写す", () => {
    const row = toQuestInsertRow({ candidate, createdByMemberId });
    expect(row.recruit_count).toBe(2);
  });

  test("想定時間は分から時間へ換算する", () => {
    const row = toQuestInsertRow({ candidate, createdByMemberId });
    expect(row.base_hours).toBe(2);
  });

  test("割り切れない想定時間は小数第2位で丸める", () => {
    const row = toQuestInsertRow({
      candidate: { ...candidate, estimatedMinutes: 100 },
      createdByMemberId,
    });
    expect(row.base_hours).toBe(1.67);
  });

  test("募集人数は最低1名になる（0名のクエストは受注できないため）", () => {
    const row = toQuestInsertRow({ candidate: { ...candidate, headcount: 0 }, createdByMemberId });
    expect(row.recruit_count).toBe(1);
  });

  test("指示内容に発言根拠を残す（朝会に出ていない受注者が背景を追えるようにするため）", () => {
    const row = toQuestInsertRow({ candidate, createdByMemberId });
    expect(row.description).toContain("東側の畑、草が伸びてるから午前中に2人くらいで刈っておきたいね");
  });
});
