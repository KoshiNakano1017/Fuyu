// 自律ループが「同じ基盤エラーで自分を再起動し続ける」ことを防ぐ仕掛けの単体テスト。
//
// 固定したいのは Issue #147 で実際に起きた失敗である:
//   review エージェントが session limit で落ちる
//   → 「修正を push する」ステップ（`if: always()`）が automation/state/ だけの差分を push
//   → pull_request(synchronize) で auto-03 が再起動
//   → また同じエラーで落ちる
// これを 2026-09-22 14:36Z〜09-23 00:48Z の間に 94 周し、セッション枠を3つ焼いた。
// `attempts.infra` は 249、`repeatedFingerprint.infra` は 122 まで積み上がっていたが、
// **どちらも停止条件として使われていなかった**（数えるだけだった）。
//
// したがって固定するのは次の3点である。
//   1. 同じ指紋の基盤エラーが続いたら「もう起動しない」と言えること（入口ゲート）
//   2. 反復は `credit`（自動再開）ではなく `infra-exhausted`（オーナー判断）へ落ちること
//   3. ワークフロー側が automation/state/ だけの差分を push しないこと（＝再起動の燃料を切る）

import { readFileSync } from 'node:fs';
import {
  recordAttempt,
  infraLoopExhausted,
  resetAttempts,
  classifyBlock,
  INFRA_REPEAT_LIMIT,
} from '../automation/orchestrator/lib/state.mjs';

/** 実際に 277 件のコメントを生んだエラー本文。 */
const SESSION_LIMIT =
  "Claude Code returned an error result: You've hit your session limit · resets 3:20am (UTC)";

/** `lib/state.mjs` が触る範囲だけを持つ最小の state（`loadState` の戻りと同じ形）。 */
type RetryState = {
  attempts: { infra: number; verify: number; review: number };
  lastFingerprint: { infra: string | null; verify: string | null; review: string | null };
  repeatedFingerprint: { infra: number; verify: number; review: number };
};

function freshState(): RetryState {
  return {
    attempts: { infra: 0, verify: 0, review: 0 },
    lastFingerprint: { infra: null, verify: null, review: null },
    repeatedFingerprint: { infra: 0, verify: 0, review: 0 },
  };
}

describe('入口ゲート（同じ基盤エラーでの再入を止める）', () => {
  it('1回目の基盤エラーでは止めない（一時的な障害は自動再開に任せる）', () => {
    const state = freshState();
    recordAttempt(state, 'infra', SESSION_LIMIT);
    expect(infraLoopExhausted(state)).toBe(false);
  });

  it(`同一の基盤エラーが ${INFRA_REPEAT_LIMIT + 1} 回続いたら止める`, () => {
    const state = freshState();
    for (let i = 0; i < INFRA_REPEAT_LIMIT + 1; i += 1) {
      recordAttempt(state, 'infra', SESSION_LIMIT);
    }
    expect(infraLoopExhausted(state)).toBe(true);
  });

  it('別のエラーに変わったら反復の数え直しになる（無関係な障害で止めない）', () => {
    const state = freshState();
    recordAttempt(state, 'infra', SESSION_LIMIT);
    recordAttempt(state, 'infra', SESSION_LIMIT);
    recordAttempt(state, 'infra', 'ECONNRESET while fetching api.anthropic.com');
    expect(infraLoopExhausted(state)).toBe(false);
  });

  it('行番号やタイムスタンプだけが違うエラーは「同じ失敗」として数える', () => {
    const state = freshState();
    recordAttempt(state, 'infra', `${SESSION_LIMIT} at foo.mjs:12:5 2026-09-22T14:36:42Z`);
    recordAttempt(state, 'infra', `${SESSION_LIMIT} at foo.mjs:99:1 2026-09-22T14:40:16Z`);
    recordAttempt(state, 'infra', `${SESSION_LIMIT} at foo.mjs:41:7 2026-09-22T14:44:09Z`);
    expect(infraLoopExhausted(state)).toBe(true);
  });

  it('フェーズが通ったら記録を消す（過去の障害で次回を止めない）', () => {
    const state = freshState();
    for (let i = 0; i < 5; i += 1) recordAttempt(state, 'infra', SESSION_LIMIT);
    expect(infraLoopExhausted(state)).toBe(true);
    resetAttempts(state, 'infra');
    expect(infraLoopExhausted(state)).toBe(false);
    expect(state.attempts.infra).toBe(0);
  });
});

describe('停止事由の分類', () => {
  it('反復した基盤エラーは infra-exhausted（オーナー判断）へ落ちる', () => {
    expect(classifyBlock('基盤エラーの反復', SESSION_LIMIT)).toBe('infra-exhausted');
  });

  it('★ session limit という語に引きずられて credit（自動再開）へ落ちない', () => {
    // ここが回帰の核。credit だとスイーパーが 60 分ごとに再開し続け、
    // 原因が解消するまで枠を焼き続ける（Issue #147 の実害そのもの）。
    expect(classifyBlock('基盤エラー', SESSION_LIMIT)).toBe('credit');
    expect(classifyBlock('基盤エラーの反復', SESSION_LIMIT)).not.toBe('credit');
  });

  it('1回目の基盤エラーは従来どおり自動再開の対象（infra / credit）', () => {
    expect(classifyBlock('基盤エラー', 'ECONNRESET')).toBe('infra');
  });

  it('仕様の未確定は従来どおり spec', () => {
    expect(classifyBlock('仕様の矛盾', '正本と派生文書が食い違う')).toBe('spec');
  });
});

describe('auto-03 が state だけの差分を push しない（再起動の燃料を切る）', () => {
  const yaml = readFileSync('.github/workflows/auto-03-review-merge.yml', 'utf8');

  it('push の前に automation/state/ を除外している', () => {
    // この1行が無いと、レビューが基盤エラーで落ちても state の差分だけが push され、
    // pull_request(synchronize) が自分自身を再起動する。
    expect(yaml).toMatch(/grep -v '\^automation\/state\/'/);
  });

  it('除外した結果が空なら push しない', () => {
    expect(yaml).toMatch(/push しません/);
  });

  it('infra-exhausted を auto:blocked 側へ振り分けている', () => {
    expect(yaml).toMatch(/spec\|infra-exhausted\)\s+NEW_LABEL="auto:blocked"/);
  });
});
