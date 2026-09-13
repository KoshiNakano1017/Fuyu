// automation/state/issue-<n>.json — エージェントの記憶の外に置く状態（設計 §12.1.7）
//
// 「状態をエージェントの記憶の外に出す」。再開は PR ＋ Issue ＋ state から復元できること。
//
// ここが Issue コメントの `<!--retry-->` を数える旧方式を置き換える（設計 §12.1.8 #5）。
// 旧方式は「基盤エラーで5回空回りする」失敗を踏んだ。リトライを1種類で数えていたためで、
// 本ファイルは **3分類 ＋ エラー指紋** で数える。
//
//   attempts.infra   基盤エラー（ネットワーク・認証・SDK 例外）… リトライしない。即停止
//   attempts.verify  verify.sh が赤   … 上限まで回してよい
//   attempts.review  レビュー指摘の修正 … 上限まで回してよい
//
// 同一指紋が2回続いたら「同じ失敗を繰り返している」と見なして止める。
// 回数だけを見ていると、同じエラーで上限まで焼き切る。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const STATE_DIR = 'automation/state';

const EMPTY = {
  version: 1,
  issue: null,
  pr: null,
  branch: null,
  phase: null,
  risk: null,
  attempts: { infra: 0, verify: 0, review: 0 },
  lastFingerprint: { infra: null, verify: null, review: null },
  repeatedFingerprint: { infra: 0, verify: 0, review: 0 },
  tokens: { input: 0, output: 0, costUsd: 0 },
  testHashes: {},
  specRefs: [],
  // テスト設計が受入テストの基準にした完了条件と、その出どころ（設計 §10.1.3 条件3 の補遺）。
  // acceptanceDerived=true は「ゲート1・2 を経ていない基準でテストが固定された」という印で、
  // ゲート3（マージ前）でオーナーが見直す材料になる。
  acceptance: [],
  acceptanceDerived: false,
  updatedAt: null,
};

function statePath(issue, root = process.cwd()) {
  return path.join(root, STATE_DIR, `issue-${issue}.json`);
}

export async function loadState(issue, root = process.cwd()) {
  try {
    const raw = await readFile(statePath(issue, root), 'utf8');
    const parsed = JSON.parse(raw);
    // 形が古い場合に落ちないよう、既定値へマージする。
    return {
      ...structuredClone(EMPTY),
      ...parsed,
      attempts: { ...EMPTY.attempts, ...(parsed.attempts ?? {}) },
      lastFingerprint: { ...EMPTY.lastFingerprint, ...(parsed.lastFingerprint ?? {}) },
      repeatedFingerprint: { ...EMPTY.repeatedFingerprint, ...(parsed.repeatedFingerprint ?? {}) },
      tokens: { ...EMPTY.tokens, ...(parsed.tokens ?? {}) },
      issue,
    };
  } catch {
    return { ...structuredClone(EMPTY), issue };
  }
}

export async function saveState(state, root = process.cwd()) {
  await mkdir(path.join(root, STATE_DIR), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(statePath(state.issue, root), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * エラーの指紋。メッセージそのものではなく正規化して取る。
 * 行番号・一時パス・16進アドレスは実行ごとに変わるため、
 * 生の文字列で比較すると「同じ失敗」を別物と数えてしまう。
 */
export function fingerprint(text) {
  const normalized = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/0x[0-9a-f]+/gi, '0xADDR')
    .replace(/:\d+:\d+/g, ':L:C')
    .replace(/\/tmp\/[^\s"']+/g, '/tmp/T')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, 'TS')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 試行を1回記録し、続行してよいかを返す。
 *
 * @returns {{ ok: boolean, reason: string|null, attempts: number }}
 */
export function recordAttempt(state, kind, errorText, { max = 5 } = {}) {
  if (!(kind in state.attempts)) throw new Error(`未知のリトライ種別: ${kind}`);

  state.attempts[kind] += 1;
  const fp = fingerprint(errorText);

  if (state.lastFingerprint[kind] === fp) {
    state.repeatedFingerprint[kind] += 1;
  } else {
    state.repeatedFingerprint[kind] = 0;
    state.lastFingerprint[kind] = fp;
  }

  // 基盤エラーはリトライしない（設計 §12.1.2「基盤エラー → 即停止・通知」）。
  if (kind === 'infra') {
    return { ok: false, reason: '基盤エラーのためリトライしません', attempts: state.attempts[kind] };
  }
  if (state.repeatedFingerprint[kind] >= 1) {
    return {
      ok: false,
      reason: `同一のエラー指紋（${fp}）が2回続きました。自動では解けない可能性が高いため停止します`,
      attempts: state.attempts[kind],
    };
  }
  if (state.attempts[kind] >= max) {
    return {
      ok: false,
      reason: `${kind} のリトライが上限（${max}回）に達しました`,
      attempts: state.attempts[kind],
    };
  }
  return { ok: true, reason: null, attempts: state.attempts[kind] };
}

/** トークン消費を積む（設計 §10.9 #6 の素材）。 */
export function addUsage(state, usage) {
  if (!usage) return state;
  state.tokens.input += usage.input_tokens ?? usage.inputTokens ?? 0;
  state.tokens.output += usage.output_tokens ?? usage.outputTokens ?? 0;
  state.tokens.costUsd += usage.total_cost_usd ?? usage.costUsd ?? 0;
  return state;
}
