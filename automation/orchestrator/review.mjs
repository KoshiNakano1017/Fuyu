#!/usr/bin/env node
// ③ レビューオーケストレータ（設計 §12.1.2 ORC3 ／ §12.1.6 段7）
//
//   5a 品質 / 5b 仕様適合 / 5c 機密（並列・読み取り専用）
//     → 修正 subagent → verify.sh（赤なら修正へ戻る）
//     → テストハッシュ照合 ＋ spec_ref の sha 再検証
//     → 判定を出力（ゲート3・マージは YAML が持つ）
//
// 使い方:
//   node automation/orchestrator/review.mjs --issue 4 --pr 12 --base origin/main
//
// 終了コード: 0 = 正常（停止含む）。1 = 基盤エラー。

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadAgent } from './lib/agents.mjs';
import { runAgent } from './lib/runAgent.mjs';
import { loadState, saveState, addUsage, recordAttempt, classifyBlock } from './lib/state.mjs';
import * as gh from './lib/gh.mjs';
import {
  REVIEW_SCHEMA, IMPLEMENT_SCHEMA, validate, outputInstruction, extractJson,
} from './lib/schema.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const ISSUE = Number(args.get('issue') ?? process.env.ISSUE_NUMBER);
const PR = Number(args.get('pr') ?? process.env.PR_NUMBER);
const BASE = args.get('base') ?? 'origin/main';
const MAX_FIX = Number(args.get('max-fix-retries') ?? 4);
if (!Number.isInteger(ISSUE)) {
  gh.error('--issue <番号> が必要です');
  process.exit(1);
}

const state = await loadState(ISSUE);
state.phase = 'review';
state.pr = Number.isInteger(PR) ? PR : state.pr;

async function stop(kind, message, detail) {
  await saveState(state);
  const body = [
    `## ⛔ 検証フェーズを停止しました（${kind}）`,
    '',
    message,
    detail ? '\n```\n' + String(detail).slice(0, 3000) + '\n```' : '',
    '',
    '<!--blocked-->',
  ].join('\n');
  await gh.comment(ISSUE, body);
  await gh.setOutput('blocked', 'true');
  await gh.setMultilineOutput('reason', message);
  // spec = オーナー判断が要る / credit・infra = スイーパーが自動再開する
  await gh.setOutput('blocked_kind', classifyBlock(kind, `${message}
${detail ?? ''}`));
  process.exit(0);
}

async function fatal(message, detail) {
  recordAttempt(state, 'infra', detail ?? message);
  gh.error(message);
  await stop('基盤エラー', `${message}\n\nリトライしません（設計 §12.1.2）。`, detail);
}

async function step(agentName, userPrompt, schema) {
  const agent = await loadAgent(agentName);
  gh.notice(`エージェント起動: ${agent.name} (model=${agent.model}, effort=${agent.effort})`);
  const res = await runAgent({ agent, userPrompt, schema, appendSystem: outputInstruction(schema) });
  addUsage(state, res.usage);
  if (!res.ok) await fatal(`${agent.name} の実行に失敗しました`, res.error);
  const check = validate(res.json, schema, agent.name);
  if (!check.ok) {
    gh.warn(`${agent.name}: 構造化出力の検証に失敗 — ${check.errors.join(' / ')}`);
    return { ok: false, json: null, text: res.text, errors: check.errors };
  }
  return { ok: true, json: res.json, text: res.text };
}

const { run } = await import('./lib/gh.mjs');

async function diffText() {
  const r = await run('git', ['diff', `${BASE}...HEAD`]);
  return r.code === 0 ? r.stdout : '';
}
async function changedFiles() {
  const r = await run('git', ['diff', '--name-only', `${BASE}...HEAD`]);
  return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

const files = await changedFiles();
const diff = await diffText();
gh.notice(`レビュー対象: ${files.length} ファイル / ${diff.length} 文字の差分`);

// ── 1. レビュー3種を並列で回す ────────────────────────────────
//
// 観点を混ぜた1体より、観点を絞った3体のほうが見落としが減る（設計 §3.0）。
// 3体とも読み取り専用（readonly.json）なので、並列に走らせても互いのファイルを壊さない。
const reviewPrompts = {
  'review-quality': [
    'CLAUDE.md §4（リーダブルコード）・バグ・認可漏れの観点で差分をレビューすること。',
    '`member_type` を認可判定に使っていないか（認可は `role` のみ）を必ず確認すること。',
  ].join('\n'),

  // 5b は commit-first。差分を読む前に、仕様からあるべき要件を先に列挙させる（設計 §11.6）。
  'review-spec': [
    '**手順を守ること（設計 §11.6 の commit-first）。**',
    '',
    '1. まず差分を読まずに、タスク定義が引用した仕様の節番号を `spec_ref.py` で解決し、',
    '   その節が要求する実装要件を箇条書きで列挙する。',
    '2. **そのうえで** 差分を読み、①で挙げた要件との過不足を判定する。',
    '',
    '順序を入れ替えてはならない。差分を先に読むと「書かれている実装」に引きずられる。',
  ].join('\n'),

  'review-privacy': [
    'CLAUDE.md §3。gitleaks が検出できない **日本語の氏名・住所** を人間の目で見るように探すこと。',
    'ダミーデータでは止めないこと（2026-09-05 オーナー決定）。',
    '実データらしき個人情報を見つけた場合は secretsFound=true とすること。',
  ].join('\n'),
};

const reviewResults = await Promise.all(
  Object.entries(reviewPrompts).map(async ([name, instruction]) => {
    const r = await step(
      name,
      [
        `対象 Issue 番号: ${ISSUE}${Number.isInteger(PR) ? ` / PR #${PR}` : ''}`,
        '',
        instruction,
        '',
        `変更ファイル（${files.length}件）:`,
        ...files.map((f) => `- ${f}`),
        '',
        '差分:',
        '```diff',
        diff.slice(0, 120000),
        '```',
      ].join('\n'),
      REVIEW_SCHEMA,
    );
    return [name, r];
  }),
);

let requiredFindings = [];
let secretsFound = false;
let unreadable = false;

for (const [name, r] of reviewResults) {
  if (!r.ok) {
    // 読めなければ「指摘あり」として扱う。自動通過させないための安全側。
    gh.warn(`${name}: 出力を読めませんでした。[必須]指摘ありとして扱います`);
    unreadable = true;
    continue;
  }
  if (Number.isInteger(PR)) await gh.prComment(PR, r.json.comment);
  else await gh.comment(ISSUE, r.json.comment);

  const req = (r.json.findings ?? []).filter((f) => f.severity === 'required');
  requiredFindings.push(...req.map((f) => ({ ...f, from: name })));
  if (r.json.secretsFound) secretsFound = true;
}

// 5c が実データらしき個人情報を検出したら、修正ループへ入れずに即停止する。
// public リポジトリで一度 push したら取り消せないため（設計 §3 #5c）。
if (secretsFound) {
  // auto-03 の後続ジョブ（risk / merge）が読む。修正ループへ渡さず人間へ上げる。
  await gh.setOutput('privacy_reject', 'true');
  await gh.setOutput('findings', 'true');
  await stop(
    '個人情報・機密の検出',
    'レビュー 5c が実データらしき個人情報・機密を検出しました。自動修正はせず、人間の判断を待ちます。',
  );
}

gh.notice(`[必須] 指摘: ${requiredFindings.length} 件${unreadable ? '（＋読めなかったレビューあり）' : ''}`);

// ── 2. 修正 → verify.sh のループ ──────────────────────────────
let verifyReport = null;

if (requiredFindings.length > 0 || unreadable) {
  let lastFailure = requiredFindings
    .map((f) => `[${f.from}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} — ${f.summary}`)
    .join('\n');

  for (let attempt = 1; attempt <= MAX_FIX + 1; attempt++) {
    const fix = await step(
      'fix',
      [
        `対象 Issue 番号: ${ISSUE}${Number.isInteger(PR) ? ` / PR #${PR}` : ''}`,
        '',
        'レビューの [必須] 指摘を修正すること。',
        '**振る舞いが変わる修正が必要なら、直さずに blocked=true で止めること**（設計 §7.1）。',
        'tests/ と docs/spec/ は書き換えられない。',
        '',
        '指摘:',
        '```',
        lastFailure.slice(0, 8000),
        '```',
      ].join('\n'),
      IMPLEMENT_SCHEMA,
    );

    if (!fix.ok) await stop('修正', '修正の構造化出力を読み取れませんでした。', (fix.errors ?? []).join('\n'));
    if (Number.isInteger(PR)) await gh.prComment(PR, fix.json.comment);
    if (fix.json.blocked) await stop('修正', fix.json.blockedReason ?? '修正を止めました（振る舞いが変わるため）。');

    const reportPath = `/tmp/verify-review-${ISSUE}.json`;
    const v = await run('bash', ['automation/scripts/verify.sh', '--json', reportPath]);
    console.log(v.stdout);
    try {
      verifyReport = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch {
      verifyReport = extractJson(v.stdout) ?? { ok: v.code === 0, steps: [] };
    }

    if (verifyReport.ok) {
      gh.notice(`修正後の verify.sh が緑になりました（${attempt} 回目）`);
      break;
    }

    lastFailure = (verifyReport.steps ?? [])
      .filter((s) => !s.ok)
      .map((s) => `[${s.name}] exit=${s.code}\n${s.tail}`)
      .join('\n\n');

    const verdict = recordAttempt(state, 'review', lastFailure, { max: MAX_FIX });
    await saveState(state);
    if (!verdict.ok) {
      await stop('修正が収束しない', `${verdict.reason}\n\n最後の失敗:\n\`\`\`\n${lastFailure.slice(0, 4000)}\n\`\`\``);
    }
    gh.warn(`verify.sh が赤です。再修正します（${verdict.attempts}/${MAX_FIX}）`);
  }
}

// ── 3. 受入テストと仕様参照の再検証 ───────────────────────────
//
// 修正エージェントもテストを書き換えられない設定だが、settings が効いていない
// 場合に素通りするのは割に合わない。ここで機械的に照合する。
const nowHashes = {};
{
  const r = await run('git', ['ls-files', 'tests', 'e2e']);
  for (const f of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    try {
      nowHashes[f] = createHash('sha256').update(await readFile(f)).digest('hex').slice(0, 16);
    } catch { /* 削除 */ }
  }
}
const tampered = Object.entries(state.testHashes ?? {}).filter(([f, h]) => nowHashes[f] !== h);
if (tampered.length) {
  await stop(
    '受入テストの改変',
    ['検証フェーズで受入テストが書き換えられていました。', '', ...tampered.map(([f]) => `- ${f}`)].join('\n'),
  );
}

// 承認後に正本が改訂されていないかを見る（設計 §12.1.8 #8）。
const specDrift = [];
for (const ref of state.specRefs ?? []) {
  if (!ref.ref || !ref.sha256) continue;
  const r = await run('python3', ['automation/scripts/spec_ref.py', ref.ref, '--json']);
  if (r.code !== 0) {
    specDrift.push(`${ref.ref}: 解決できませんでした`);
    continue;
  }
  const resolved = extractJson(r.stdout);
  if (resolved?.sha256 && resolved.sha256 !== ref.sha256) {
    specDrift.push(`${ref.ref}: 承認時から正本が改訂されています（${ref.sha256.slice(0, 8)} → ${String(resolved.sha256).slice(0, 8)}）`);
  }
}
if (specDrift.length) {
  await stop(
    '正本の改訂を検出',
    ['承認後に、参照していた正本が改訂されています。判断の前提が変わったため停止します。', '', ...specDrift.map((s) => `- ${s}`)].join('\n'),
  );
}

// ── 4. 判定の出力（ゲート3・マージは YAML が持つ）───────────────
await saveState(state);
const noRequired = requiredFindings.length === 0 && !unreadable;
await gh.setOutput('blocked', 'false');
await gh.setOutput('required_findings', String(requiredFindings.length));
await gh.setOutput('no_required_findings', String(noRequired));
// 旧 verdict ジョブと同じ名前で出す。auto-03 の risk / merge は
// `needs.verdict.outputs.findings` / `privacy_reject` を見続けるため。
await gh.setOutput('findings', String(!noRequired));
await gh.setOutput('privacy_reject', 'false');
await gh.setOutput('verify_ok', String(verifyReport ? Boolean(verifyReport.ok) : true));
await gh.setOutput('token_input', state.tokens.input);
await gh.setOutput('token_output', state.tokens.output);
gh.notice(`検証フェーズ完了: [必須]指摘 ${requiredFindings.length} 件 / 自動通過条件（エージェント側）= ${noRequired}`);
