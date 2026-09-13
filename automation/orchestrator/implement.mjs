#!/usr/bin/env node
// ② 実装オーケストレータ（設計 §12.1.2 ORC2 ／ §12.1.6 段7）
//
//   テスト設計 subagent（tests/ のみ書込可）
//     → テストのハッシュを state へ記録
//     → コーディング subagent（tests/ は書込不可）
//     → verify.sh（型/lint/単体）… 赤ならコーディングへ戻る
//     → 緑になったら終了（コミット・push・PR 作成は YAML が行う）
//
// ── PR 作成をここに入れない理由 ────────────────────────────────
// 設計 §12.1.2 の図は ORC2 の中に PR 作成を描いているが、**採らない**。
// 理由は §12.1.7「権限はエージェント単位で切る」と、auto-02 の責務の分界
// （エージェント＝ファイル編集、ワークフロー＝コミット・push・PR 作成）である。
// PR 作成を取り込むと AUTOMATION_PAT がオーケストレータのプロセスに入り、
// 同じプロセスで動くエージェントの手が届く範囲に認証情報が置かれる。
// 往復コストの削減（§12.1.8 #2）は verify.sh をプロセス内に持つことで達成済みで、
// PR 作成まで取り込んでも往復は減らない。
//
// 使い方:
//   node automation/orchestrator/implement.mjs --issue 4
//
// 終了コード: 0 = 実装完了 or 停止（blocked）。1 = 基盤エラー。

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadAgent } from './lib/agents.mjs';
import { runAgent } from './lib/runAgent.mjs';
import { loadState, saveState, addUsage, recordAttempt } from './lib/state.mjs';
import * as gh from './lib/gh.mjs';
import { IMPLEMENT_SCHEMA, validate, outputInstruction, extractJson } from './lib/schema.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const ISSUE = Number(args.get('issue') ?? process.env.ISSUE_NUMBER);
const MAX_FIX = Number(args.get('max-verify-retries') ?? 4);
// tests = テスト設計だけ / code = 実装と verify ループだけ / all = 両方（既定）
//
// 分けられるのは、受入テストを **実装より先に別コミットとして** 残すため。
// commit-first（設計 §11.6）は git の履歴に出て初めて検証可能になる。
// 状態は automation/state/issue-<n>.json に残るので、2回の起動をまたいで
// テストの sha256 を引き継げる。
const PHASE = args.get('phase') ?? 'all';
if (!['tests', 'code', 'all'].includes(PHASE)) {
  gh.error(`--phase は tests|code|all のいずれか（指定: ${PHASE}）`);
  process.exit(1);
}
if (!Number.isInteger(ISSUE)) {
  gh.error('--issue <番号> が必要です');
  process.exit(1);
}

const state = await loadState(ISSUE);
state.phase = 'implement';

async function stop(kind, message, detail) {
  await saveState(state);
  await gh.comment(ISSUE, [
    `## ⛔ 実装フェーズを停止しました（${kind}）`,
    '',
    message,
    detail ? '\n```\n' + String(detail).slice(0, 3000) + '\n```' : '',
    '',
    '<!--blocked-->',
  ].join('\n'));
  await gh.setOutput('blocked', 'true');
  await gh.setMultilineOutput('reason', message);
  process.exit(0);
}

async function fatal(message, detail) {
  recordAttempt(state, 'infra', detail ?? message);
  await saveState(state);
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

/** tests/ 配下のハッシュを取る。コーディングがテストを書き換えていないことの検査に使う。 */
async function hashTests() {
  const { run } = await import('./lib/gh.mjs');
  const r = await run('git', ['ls-files', 'tests', 'e2e']);
  if (r.code !== 0) return {};
  const files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = {};
  for (const f of files) {
    try {
      const buf = await readFile(f);
      out[f] = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    } catch { /* 削除された場合は載せない */ }
  }
  return out;
}

// ── 1. テスト設計（仕様だけを見る・commit-first）────────────────
if (PHASE === 'tests' || PHASE === 'all') {
const tests = await step(
  'test-design',
  [
    `対象 Issue 番号: ${ISSUE}`,
    '',
    '**実装を見ずに、仕様と Issue の完了条件だけを見て受入テストを書くこと**（設計 §11.6 の commit-first）。',
    'src/ や app/ のファイルは読まないこと。書き込めるのは tests/ 配下のみ。',
    '',
    'CLAUDE.md §4.4 が必ずテストを要求する領域（認可・金額計算・個人情報）が',
    'タスクに含まれる場合、その3点は必ずテストで固定すること。',
  ].join('\n'),
  IMPLEMENT_SCHEMA,
);

if (!tests.ok) await stop('テスト設計', 'テスト設計の構造化出力を読み取れませんでした。', (tests.errors ?? []).join('\n'));
await gh.comment(ISSUE, tests.json.comment);
if (tests.json.blocked) await stop('テスト設計', tests.json.blockedReason ?? '仕様が未確定です。');

// テストのハッシュを固定する。以降、これが変わっていたら止める。
state.testHashes = await hashTests();
await saveState(state);
gh.notice(`受入テストを固定しました（${Object.keys(state.testHashes).length} ファイル）`);
}

if (PHASE === 'tests') {
  await gh.setOutput('blocked', 'false');
  await gh.setOutput('test_files', String(Object.keys(state.testHashes ?? {}).length));
  gh.notice('テスト設計フェーズ完了。コミットはワークフローが行います');
  process.exit(0);
}

// ── 2. コーディング → verify.sh のループ ───────────────────────
let verifyReport = null;
let lastFailureText = '';

for (let attempt = 1; attempt <= MAX_FIX + 1; attempt++) {
  const isRetry = attempt > 1;
  const coding = await step(
    'coding',
    [
      `対象 Issue 番号: ${ISSUE}`,
      '',
      isRetry
        ? [
            '**前回の実装で verify.sh が赤だった。** 下記の失敗を直すこと。',
            'テスト（tests/ 配下）は書き換えられない。テストが要求する振る舞いを実装側で満たすこと。',
            '',
            '```',
            lastFailureText.slice(0, 6000),
            '```',
          ].join('\n')
        : '段取りに従って実装し、受入テストを通すこと。',
      '',
      'tests/ と docs/spec/ は書き換えられない（settings で機械的に拒否されている）。',
      '振る舞いを変える修正が必要だと判断した場合は、実装せず blocked=true で止めること（設計 §7.1）。',
    ].join('\n'),
    IMPLEMENT_SCHEMA,
  );

  if (!coding.ok) await stop('実装', '実装の構造化出力を読み取れませんでした。', (coding.errors ?? []).join('\n'));
  await gh.comment(ISSUE, coding.json.comment);
  if (coding.json.blocked) await stop('実装', coding.json.blockedReason ?? '実装を止めました。');

  // 受入テストが書き換えられていないことを確認する（設計 §12.1.5）。
  const now = await hashTests();
  const tampered = Object.entries(state.testHashes).filter(([f, h]) => now[f] !== h);
  const removed = Object.keys(state.testHashes).filter((f) => !(f in now));
  if (tampered.length || removed.length) {
    await stop(
      '受入テストの改変',
      [
        'コーディングが受入テストを書き換えました。commit-first（設計 §11.6）が成立しないため停止します。',
        '',
        ...tampered.map(([f]) => `- 改変: ${f}`),
        ...removed.map((f) => `- 削除: ${f}`),
      ].join('\n'),
    );
  }

  // verify.sh を回す。CI の代替ではなく、往復削減のための速い検証。
  const { run } = await import('./lib/gh.mjs');
  const reportPath = `/tmp/verify-${ISSUE}.json`;
  const v = await run('bash', ['automation/scripts/verify.sh', '--json', reportPath]);
  console.log(v.stdout);
  if (v.stderr) console.error(v.stderr);

  try {
    verifyReport = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    verifyReport = extractJson(v.stdout) ?? { ok: v.code === 0, steps: [] };
  }

  if (verifyReport.ok) {
    gh.notice(`verify.sh が緑になりました（${attempt} 回目）`);
    break;
  }

  lastFailureText = (verifyReport.steps ?? [])
    .filter((s) => !s.ok)
    .map((s) => `[${s.name}] exit=${s.code}\n${s.tail}`)
    .join('\n\n');

  const verdict = recordAttempt(state, 'verify', lastFailureText, { max: MAX_FIX });
  await saveState(state);
  if (!verdict.ok) {
    await stop(
      'verify.sh が緑にならない',
      [
        verdict.reason,
        '',
        '最後の失敗:',
        '```',
        lastFailureText.slice(0, 4000),
        '```',
      ].join('\n'),
    );
  }
  gh.warn(`verify.sh が赤です。修正を試みます（${verdict.attempts}/${MAX_FIX}）`);
}

// ── 3. 結果 ──────────────────────────────────────────────────
await saveState(state);
await gh.setOutput('blocked', 'false');
await gh.setOutput('verify_ok', String(Boolean(verifyReport?.ok)));
await gh.setOutput('token_input', state.tokens.input);
await gh.setOutput('token_output', state.tokens.output);
gh.notice('実装フェーズ完了。コミット・push・PR 作成はワークフローが行います');
