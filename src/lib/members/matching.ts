/**
 * 名寄せの判定（WBS 10-2 ／ v13 §5.8.3 STEP 2）。
 *
 * ## 名寄せが成立すると何が起きるか
 *
 * **他人の宿泊券・Uii残高・XP・街人ステータスが引き継がれる。** だからこそ正本は
 * 「照合一致のみで自動連携させてはならない」と書いている（§5.8.3 の [!warning]）。
 * ここは**成立させない判断**を持つ場所であり、緩めると事故が取り返しのつかない形で起きる。
 *
 * ## 判定の3段
 *
 * | 状況 | 結果 |
 * | --- | --- |
 * | 候補 0件 | **何もしない**（招待台帳の経路＝`bindAuthUserToMember()` に任せる） |
 * | 候補 1件 ＋ 本人確認済みの連絡先 | **自動で成立**（§5.8.3「このデータで連携して開始する」） |
 * | 候補 2件以上 | **運営承認キューへ**（同姓同名・家族間の連絡先共有を想定） |
 * | 本人確認が無い | **運営承認キューへ**（②の要件。OTP を通っていないキーで成立させない） |
 * | 候補が既に結合済み／`active` | **何もしない**（名寄せを奪取の経路にしない） |
 *
 * ## 照合キーの優先順位
 *
 * `contact_info`（メール／電話）が第1優先、次に氏名＋誕生年月（§5.8.3）。
 * ★ **Phase 1 で氏名＋誕生年月は使えない。** 移行370名は `birth_ym` を持たない
 * （`DB物理設計.md` §3-14 の [!danger]）ため、氏名だけで寄せると同姓同名を機械的に解決できない。
 * したがって氏名一致は**自動成立の根拠にせず、キューへ回す材料としてのみ**扱う。
 */

/** 照合に使えるキーの種別（`member_identifiers.kind` と同じ語彙）。 */
export type MatchKind = "email" | "phone" | "line" | "discord";

/** 照合でヒットした候補1件。 */
export type MatchCandidate = {
  memberId: string;
  /** すでに Auth ユーザーへ結合済みか（結合済みは名寄せの対象外） */
  isBound: boolean;
  accountStatus: string;
  /** その連絡先が本人確認を通っているか（`member_identifiers.is_verified`） */
  isIdentifierVerified: boolean;
};

export type MatchDecision =
  | { kind: "auto"; memberId: string; matchBasis: string }
  | { kind: "queue"; reason: string; candidateCount: number }
  | { kind: "none" };

export type MatchRequest = {
  matchKind: MatchKind;
  /** 照合に使った値（正規化前でよい。記録用） */
  matchValue: string;
  candidates: readonly MatchCandidate[];
  /**
   * ログインで本人確認が済んでいるか。
   *
   * ★ アプリでは `supabase.auth.verifyOtp()` を通ったメールだけを `true` で渡す
   * （§5.8.3 ②「メール／SMS のワンタイム認証による本人確認を必須とする」）。
   */
  isActorVerified: boolean;
};

/** 照合値の正規化。`member_identifiers.value_normalized`（生成列）と同じ規則に揃える。 */
export function normalizeMatchValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 名寄せしてよいかを決める。
 *
 * 判定の順番に意味がある。**「結合済みを外す」→「本人確認」→「件数」**の順で見る。
 * 件数を先に見ると、結合済みの行が候補に混ざったまま「2件だから承認キュー」へ回り、
 * 運営が**選べない候補**を含むキューを見ることになる。
 */
export function decideMatching(request: MatchRequest): MatchDecision {
  // ① 名寄せの対象になり得る候補だけを残す。
  //    結合済み・`active` は対象外（他人のアカウントを奪う経路にしない）。
  const linkable = request.candidates.filter(
    (candidate) => !candidate.isBound && candidate.accountStatus === "pre_registered",
  );

  if (linkable.length === 0) {
    return { kind: "none" };
  }

  // ② 本人確認。OTP を通っていないキーでは成立させない（§5.8.3 ②）。
  if (!request.isActorVerified) {
    return {
      kind: "queue",
      reason: "本人確認（ワンタイム認証）を通っていない照合のため、運営の確認へ回した",
      candidateCount: linkable.length,
    };
  }

  // ③ 件数。2件以上は同姓同名・家族間の連絡先共有を疑う（§5.8.3 ①）。
  if (linkable.length > 1) {
    return {
      kind: "queue",
      reason: `照合キー（${matchKindLabel(request.matchKind)}）に${linkable.length}件が一致したため、運営の確認へ回した`,
      candidateCount: linkable.length,
    };
  }

  return {
    kind: "auto",
    memberId: linkable[0].memberId,
    matchBasis: `本人確認済みの${matchKindLabel(request.matchKind)}が1件だけ一致（${normalizeMatchValue(
      request.matchValue,
    )}）`,
  };
}

/** 照合キーの表示名。内部識別子をそのまま画面・監査ログへ出さない。 */
export function matchKindLabel(kind: MatchKind): string {
  switch (kind) {
    case "email":
      return "メールアドレス";
    case "phone":
      return "電話番号";
    case "line":
      return "LINE";
    case "discord":
      return "Discord";
  }
}

/**
 * 運営が承認キューの候補を選んだときの根拠文（v13 §5.8.3 ③）。
 *
 * 「誰が・いつ」は監査ログの列が持つので、ここでは**なぜその候補にしたか**を残す。
 */
export function approvalMatchBasis(params: {
  matchKind: MatchKind;
  candidateCount: number;
}): string {
  return `運営承認（${matchKindLabel(params.matchKind)}の一致 ${params.candidateCount}件から選択）`;
}
