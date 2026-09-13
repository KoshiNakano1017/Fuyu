// エージェント間の受け渡しに使う構造化出力の定義（設計 §12.1.8 #3）。
//
// 旧方式は Issue コメントの本文を grep していた。マーカーが空振りすると
// 判定を読み取れず、高リスクへ縮退する（＝毎回ゲートが増える）失敗モードがあった。
// ここでスキーマを固定し、**機械用（この JSON）と人間用（Issue コメント）を分ける**。
//
// 依存を増やさないため、検証は自前で行う。求めているのは
// 「型が合っているか」「列挙値の外に出ていないか」だけで、JSON Schema の全機能ではない。

export const RISK_LEVELS = ['low', 'mid', 'high'];

/** リスクの順序比較。繰り上げ専用の判定に使う（設計 §3.2.1）。 */
export function riskRank(r) {
  const i = RISK_LEVELS.indexOf(r);
  return i === -1 ? RISK_LEVELS.length : i;
}
export function maxRisk(a, b) {
  return riskRank(a) >= riskRank(b) ? a : b;
}

// ── リスク判定 subagent の出力 ────────────────────────────────
// PM の自己判定とは独立に出す。両者の **高いほう** を採用する（設計 §12.1.8 #4）。
// §11.6 が禁じた「Claude が実装し Claude が良否を判定する」構成を避けるため、
// この subagent には PM の理由文を渡さない。
export const RISK_SCHEMA = {
  type: 'object',
  required: ['risk', 'reason'],
  additionalProperties: false,
  properties: {
    risk: { type: 'string', enum: RISK_LEVELS },
    reason: { type: 'string', minLength: 1 },
    triggers: { type: 'array', items: { type: 'string' } },
  },
};

// ── 計画フェーズ全体の出力 ────────────────────────────────────
export const PLAN_SCHEMA = {
  type: 'object',
  required: ['blocked', 'risk', 'comment'],
  additionalProperties: false,
  properties: {
    blocked: { type: 'boolean' },
    blockedReason: { type: 'string' },
    risk: { type: 'string', enum: RISK_LEVELS },
    riskReason: { type: 'string' },
    specRefs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref'],
        additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          path: { type: 'string' },
          sha256: { type: 'string' },
          lines: { type: 'string' },
        },
      },
    },
    changedFiles: { type: 'array', items: { type: 'string' } },
    testPlan: { type: 'string' },
    // 人間が読む本文。Issue コメントへそのまま出す。
    comment: { type: 'string', minLength: 1 },
  },
};

// ── 実装フェーズの出力 ────────────────────────────────────────
export const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['blocked', 'comment'],
  additionalProperties: false,
  properties: {
    blocked: { type: 'boolean' },
    blockedReason: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    comment: { type: 'string', minLength: 1 },
  },
};

// ── レビュー（5a/5b/5c）の出力 ───────────────────────────────
export const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings', 'comment'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'summary'],
        additionalProperties: false,
        properties: {
          // [必須] 相当が required。設計 §4.1 の自動通過条件が数えるのはこれだけ。
          severity: { type: 'string', enum: ['required', 'suggestion'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string', minLength: 1 },
        },
      },
    },
    // 個人情報レビュー(5c)のみ。検出したら即停止する（設計 §3 #5c）。
    secretsFound: { type: 'boolean' },
    comment: { type: 'string', minLength: 1 },
  },
};

// ── 検証 ──────────────────────────────────────────────────────

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(value, schema, pathStr, errors) {
  const t = typeOf(value);
  const want = schema.type;

  if (want === 'integer' ? t !== 'integer' : want && t !== want && !(want === 'number' && t === 'integer')) {
    errors.push(`${pathStr}: ${want} を期待しましたが ${t} でした`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathStr}: ${JSON.stringify(value)} は許可された値ではありません (${schema.enum.join('|')})`);
    return;
  }
  if (want === 'string' && schema.minLength && value.length < schema.minLength) {
    errors.push(`${pathStr}: 空文字は許可されていません`);
    return;
  }
  if (want === 'array' && schema.items) {
    value.forEach((v, i) => check(v, schema.items, `${pathStr}[${i}]`, errors));
    return;
  }
  if (want === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${pathStr}.${key}: 必須ですが欠けています`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) {
          errors.push(`${pathStr}.${key}: 未知のキーです`);
        }
        continue;
      }
      check(v, sub, `${pathStr}.${key}`, errors);
    }
  }
}

/**
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(value, schema, label = 'output') {
  const errors = [];
  if (value === undefined || value === null) {
    return { ok: false, errors: [`${label}: 出力がありません`] };
  }
  check(value, schema, label, errors);
  return { ok: errors.length === 0, errors };
}

/**
 * エージェントの最終メッセージから JSON を取り出す。
 *
 * 構造化出力を強制していても、前後に説明文が付くことがある。
 * ```json フェンス → 素の JSON → 最後の {...} の順に試す。
 * どれも取れなければ null を返し、呼び出し側が安全側へ倒す。
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  for (const m of fenced.reverse()) {
    try {
      return JSON.parse(m[1]);
    } catch { /* 次の候補へ */ }
  }
  try {
    return JSON.parse(String(text).trim());
  } catch { /* 次の候補へ */ }

  const first = String(text).indexOf('{');
  const last = String(text).lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(String(text).slice(first, last + 1));
    } catch { /* あきらめる */ }
  }
  return null;
}

/** スキーマを日本語の指示文へ落とす。各エージェントのプロンプト末尾へ足す。 */
export function outputInstruction(schema, extra = '') {
  return [
    '',
    '---',
    '## 出力形式（機械が読む）',
    '',
    '**最後のメッセージは、次のスキーマに合う JSON だけを ```json フェンスで囲んで出力すること。**',
    '人間向けの説明は `comment` フィールドの中に入れる。フェンスの外には何も書かない。',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    extra,
  ].join('\n');
}
