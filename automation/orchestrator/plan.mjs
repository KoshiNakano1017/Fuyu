#!/usr/bin/env node
// ① 計画オーケストレータ（設計 §12.1.2 ORC1 ／ §12.1.6 段3）
//
//   PM: タスク定義 → リスク判定 subagent → 調査 subagent → PM: 段取り
//        → 構造化出力（risk / blocked / specRefs / plan）
//
// ── このファイルが持つもの・持たないもの ──────────────────────
//   持つ   : 実行順序、リスクの合成、停止判定、構造化出力の検証、Issue へのコメント
//   持たない: ラベル遷移、ゲート制御、コミット・push
//
// 後者は auto-01-plan.yml に残す。設計 §12.1.3 の
// 「ゲートは if 文であるべきで、エージェントに制御フローを渡すと
//   『説得できる門番』ができてしまう」に従う。
//
// 使い方:
//   node automation/orchestrator/plan.mjs --issue 4
//
// 終了コード: 0 = 正常（blocked でも 0）。1 = 基盤エラー。

import { loadAgent } from './lib/agents.mjs';
import { runAgent } from './lib/runAgent.mjs';
import {
  loadState,
  saveState,
  addUsage,
  recordAttempt,
  classifyBlock,
  infraLoopExhausted,
  resetAttempts,
} from './lib/state.mjs';
import * as gh from './lib/gh.mjs';
import {
  PLAN_SCHEMA, RISK_SCHEMA, validate, outputInstruction, maxRisk,
} from './lib/schema.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const ISSUE = Number(args.get('issue') ?? process.env.ISSUE_NUMBER);
if (!Number.isInteger(ISSUE)) {
  gh.error('--issue <番号> が必要です');
  process.exit(1);
}

const state = await loadState(ISSUE);

// ── 仮決定の記録（2026-09-16）──────────────────────────────
// 低・中リスクの未確定論点は止めずに推奨案で進める（設計 §3.4）。
// ただし「黙って決めた」ことにならないよう、必ず3か所へ痕跡を残す:
//   1. Issue コメント（オーナーがその場で覆せる）
//   2. state（枯渇レポートが一覧にする）
//   3. QUESTIONS.md（PM エージェントが §3.4.1 の形式で追記する）
const provisional = [];

async function recordProvisional(json) {
  const p = json?.provisionalDecision;
  if (!p) return;
  provisional.push(p);
  await gh.comment(ISSUE, [
    `## ⚡ 仮決定で進行します：${p.question}`,
    '',
    '**採用した案**',
    p.chosen,
    '',
    '**理由**',
    p.rationale,
    ...(p.specRef ? ['', `**根拠**: ${p.specRef}`] : []),
    '',
    '**覆す場合の手当て**',
    p.reversibility,
    '',
    '> [!important] これは決定ではなく「覆せる形で進めた」記録です',
    '> オーナーの判断が要ると考える場合は `auto:needs-review` を付けてください。',
    '> 区分によらずマージ前の承認（ゲート3）を経由します。',
    '',
    '<!--provisional-->',
  ].join('\n'));
}

state.phase = 'plan';

/** 基盤エラーは即停止する（設計 §12.1.2）。リトライしない。 */
async function fatal(message, detail) {
  recordAttempt(state, 'infra', detail ?? message);
  await saveState(state);
  gh.error(message);
  await gh.comment(ISSUE, [
    '## ⛔ 基盤エラーで停止しました',
    '',
    'エージェントの判断ではなく、実行基盤側の問題です。リトライしません。',
    '',
    '```',
    String(detail ?? message).slice(0, 3000),
    '```',
    '',
    '<!--blocked-->',
  ].join('\n'));
  await gh.setOutput('blocked', 'true');
  await gh.setOutput('risk', 'high');
  // クレジット切れと基盤障害はオーナー判断を要しない。スイーパーが後で再開する。
  // 反復（入口ゲート）なら infra-exhausted へ落として自動再開の対象から外す。
  const kindLabel = infraLoopExhausted(state) ? '基盤エラーの反復' : '基盤エラー';
  await gh.setOutput('blocked_kind', classifyBlock(kindLabel, detail ?? message));
  process.exit(1);
}

// 入口ゲート: 同じ基盤エラーでの再入を止める（2026-09-26 新設・Issue #147）。
// スイーパーの自動再開（冷却60分）は回数を見ていないため、原因が解消するまで無限に枠を焼く。
if (infraLoopExhausted(state)) {
  await fatal(
    `同一の基盤エラーが ${state.repeatedFingerprint.infra + 1} 回続いたため、` + `エージェントを起動せずに停止しました（累計 ${state.attempts.infra} 回）。`,
    '基盤エラーの反復: 原因（セッション枠・クレジット・認証）の解消後に、' + '`auto:blocked` を外して `auto:planning` を付け直してください。',
  );
}

/** 1体を走らせ、構造化出力を取り出す。失敗は安全側（高リスク）へ倒す。 */
async function step(agentName, userPrompt, schema, { extraInstruction = '' } = {}) {
  const agent = await loadAgent(agentName);
  gh.notice(`エージェント起動: ${agent.name} (model=${agent.model}, effort=${agent.effort})`);

  const res = await runAgent({
    agent,
    userPrompt,
    schema,
    appendSystem: outputInstruction(schema, extraInstruction),
  });

  addUsage(state, res.usage);

  if (!res.ok) {
    await fatal(`${agent.name} の実行に失敗しました`, res.error);
  }
  const check = validate(res.json, schema, agent.name);
  if (!check.ok) {
    // 構造化出力を読み取れなかった。旧方式なら「高リスクへ縮退」していたところ。
    // 縮退はするが、**理由を残す**点が旧方式との違い。
    gh.warn(`${agent.name}: 構造化出力の検証に失敗しました — ${check.errors.join(' / ')}`);
    return { ok: false, json: null, text: res.text, errors: check.errors };
  }
  return { ok: true, json: res.json, text: res.text };
}

// ── 1. PM: タスク定義 ────────────────────────────────────────
const define = await step(
  'pm-define',
  [
    `対象 Issue 番号: ${ISSUE}`,
    '',
    'この Issue をタスク定義へ落とし、起票3条件（設計 §10.1.3）を満たすか判定すること。',
    '仕様が未確定・曖昧・矛盾している場合は blocked=true とし、',
    '設計 §3.2 の作法（選択肢は最大3つ・推奨1つ・1回に1問）に従って comment を書くこと。',
  ].join('\n'),
  PLAN_SCHEMA,
);

if (!define.ok) {
  // タスク定義すら読めない場合は、そもそも先へ進めない。
  await gh.comment(ISSUE, [
    '## ⚠️ タスク定義の構造化出力を読み取れませんでした',
    '',
    '安全側に倒して停止します（設計 §4.1「高リスクを低と誤判定するのが唯一の致命的な失敗モード」）。',
    '',
    '検証エラー:',
    ...(define.errors ?? []).map((e) => `- ${e}`),
    '',
    '<!--blocked-->',
  ].join('\n'));
  await gh.setOutput('blocked', 'true');
  await gh.setOutput('risk', 'high');
  await saveState(state);
  process.exit(0);
}

await gh.comment(ISSUE, define.json.comment);
await recordProvisional(define.json);

if (define.json.blocked) {
  gh.notice('タスク定義の段階で停止しました（仕様が未確定）');
  state.risk = 'high';
  await saveState(state);
  await gh.setOutput('blocked', 'true');
  await gh.setOutput('risk', 'high');
  await gh.setMultilineOutput('blocked_reason', define.json.blockedReason ?? '仕様が未確定');
  await gh.setOutput('blocked_kind', 'spec');
  process.exit(0);
}

// ── 2. リスク判定 subagent（PM の理由文は渡さない）────────────
//
// 設計 §11.6: Claude が実装し Claude が良否を判定する構成は実証済みの失敗モード。
// PM の判定と **独立に** 出させ、高いほうを採る（§12.1.8 #4）。
// そのため、ここへ渡すのは Issue 本文と変更予定ファイルだけに絞る。
const riskStep = await step(
  'risk-classify',
  [
    `対象 Issue 番号: ${ISSUE}`,
    '',
    '**PM の判定理由は渡していない。** Issue 本文と下記の変更予定ファイルだけを見て、',
    '設計 §4.1 のリスク3区分を独立に判定すること。',
    '',
    '変更予定ファイル:',
    ...(define.json.changedFiles ?? ['(宣言なし)']).map((f) => `- ${f}`),
  ].join('\n'),
  RISK_SCHEMA,
);

// 判定を読めなければ high。安全側へ倒す。
const independentRisk = riskStep.ok ? riskStep.json.risk : 'high';
if (!riskStep.ok) gh.warn('リスク判定 subagent の出力を読めませんでした。high として扱います');

let risk = maxRisk(define.json.risk, independentRisk);
if (risk !== define.json.risk) {
  gh.notice(`リスク区分を ${define.json.risk} → ${risk} へ繰り上げました（独立判定: ${independentRisk}）`);
}

// ── 3. 調査 subagent ─────────────────────────────────────────
const research = await step(
  'research',
  [
    `対象 Issue 番号: ${ISSUE}`,
    '',
    '一次情報だけを返すこと。「だからこうすべき」は言わない（設計 §3.1）。',
    '',
    '節番号は推測せず、必ず次で解決すること:',
    '  python3 automation/scripts/spec_ref.py "v13 §5.4.1"',
    '解決できない参照があれば blocked=true とすること。',
    '',
    '正本と派生文書の食い違いを見つけた場合は設計 §3.3 を適用する。',
    'リスクが高に達しないなら **止めずに** 正本を採用し、blocked=false のまま進めること。',
    '',
    'タスク定義:',
    define.json.comment.slice(0, 4000),
  ].join('\n'),
  PLAN_SCHEMA,
);

if (research.ok) {
  await gh.comment(ISSUE, research.json.comment);
await recordProvisional(research.json);
  risk = maxRisk(risk, research.json.risk);

  if (research.json.blocked) {
    gh.notice('調査の結果、仕様が未確定のため停止します（設計 §3.2）');
    state.risk = 'high';
    state.specRefs = research.json.specRefs ?? [];
    await saveState(state);
    await gh.setOutput('blocked', 'true');
    await gh.setOutput('risk', 'high');
    await gh.setMultilineOutput('blocked_reason', research.json.blockedReason ?? '仕様が未確定');
    await gh.setOutput('blocked_kind', 'spec');
    process.exit(0);
  }
} else {
  gh.warn('調査の構造化出力を読めませんでした。段取りへ進みますがリスクは high へ繰り上げます');
  risk = 'high';
}

// ── 4. PM: 段取り ────────────────────────────────────────────
const plan = await step(
  'pm-plan',
  [
    `対象 Issue 番号: ${ISSUE}`,
    '',
    '承認済みのタスク定義と調査結果から段取りを作ること。',
    'changedFiles（変更ファイル一覧）と testPlan（受入テスト方針）は必ず埋めること。',
    '',
    '`acceptance`（完了条件）も必ず埋めること。ゲート2 はこれを承認する場である。',
    'タスク定義に書かれていたものは origin="issue"、',
    'タスク定義に無い／検証可能でないため **調査結果から導出**したものは origin="derived" とし、',
    '`basis` に根拠の節番号を必ず書くこと。調査結果に無いことを完了条件にしてはならない。',
    '導出できる完了条件が1つも無ければ blocked=true で止めること。',
    '段取りの段階でリスクを **下げてはならない**（設計 §3.2.1）。',
    '',
    `現時点のリスク区分: ${risk}`,
    '',
    '調査結果:',
    (research.ok ? research.json.comment : research.text ?? '').slice(0, 6000),
  ].join('\n'),
  PLAN_SCHEMA,
);

if (!plan.ok) {
  await gh.comment(ISSUE, [
    '## ⚠️ 段取りの構造化出力を読み取れませんでした',
    '',
    '安全側に倒して停止します。',
    '',
    ...(plan.errors ?? []).map((e) => `- ${e}`),
    '',
    '<!--blocked-->',
  ].join('\n'));
  await gh.setOutput('blocked', 'true');
  await gh.setOutput('risk', 'high');
  await saveState(state);
  process.exit(0);
}

await gh.comment(ISSUE, plan.json.comment);
await recordProvisional(plan.json);

if (plan.json.blocked) {
  state.risk = 'high';
  await saveState(state);
  await gh.setOutput('blocked', 'true');
  await gh.setOutput('risk', 'high');
  await gh.setMultilineOutput('blocked_reason', plan.json.blockedReason ?? '仕様が未確定');
  await gh.setOutput('blocked_kind', 'spec');
  process.exit(0);
}

risk = maxRisk(risk, plan.json.risk);

// ── 5. 結果の確定 ────────────────────────────────────────────
// 完了条件をゲート2 の承認対象として残す。ここで承認されたものが受入テストの基準になり、
// 実装フェーズ（implement.mjs）はこれを test-design へ渡す。
state.acceptance = plan.json.acceptance ?? [];
state.acceptanceDerived = state.acceptance.some((a) => a.origin === 'derived');
if (state.acceptance.length === 0) {
  gh.warn('段取りに完了条件が含まれていません。ゲート2 で承認する完了の定義がない状態です');
} else if (state.acceptanceDerived) {
  const derived = state.acceptance.filter((a) => a.origin === 'derived');
  await gh.comment(ISSUE, [
    '## ⚠️ 完了条件のうち ' + derived.length + ' 件は調査結果からの導出です',
    '',
    'タスク定義に検証可能な完了条件が揃っていなかったため、段取りの作成時に導出しました。',
    '**ゲート2 の承認は、この完了条件の承認を兼ねます。**',
    '',
    '| # | 完了条件 | 出どころ | 根拠 |',
    '| --- | --- | --- | --- |',
    ...state.acceptance.map(
      (a, i) => `| ${i + 1} | ${a.criterion} | ${a.origin === 'derived' ? '**導出**' : 'タスク定義'} | ${a.basis ?? '—'} |`,
    ),
    '',
    '根拠の節番号が実際にその内容を書いているかは **設計 §10.3 の最頻の事故ポイント**です。',
    '節を開いて照合してから承認してください。違っていれば却下してください。',
  ].join('\n'));
}

state.risk = risk;
state.provisional = provisional;
state.specRefs = plan.json.specRefs ?? research.json?.specRefs ?? [];
// フェーズが最後まで通った。基盤エラーの記録を消す（残すと次回が入口ゲートで止まる）。
resetAttempts(state, 'infra');
await saveState(state);

// auto-03 の `risk` ジョブは今も Issue コメントから `<!--risk:X-->` を読む。
// 段7 で auto-03 を書き換えるまでの後方互換として、判定結果をマーカーで残す。
// 構造化出力（state.risk）が正であり、これはその写しにすぎない。
await gh.comment(ISSUE, [
  `計画フェーズのリスク区分: **${risk}**`,
  '',
  `<!--risk:${risk}-->`,
].join('\n'));

gh.notice(`計画フェーズ完了: risk=${risk} / 変更予定 ${(plan.json.changedFiles ?? []).length} ファイル`);

await gh.setOutput('blocked', 'false');
await gh.setOutput('risk', risk);
await gh.setMultilineOutput('changed_files', (plan.json.changedFiles ?? []).join('\n'));
await gh.setOutput('token_input', state.tokens.input);
await gh.setOutput('token_output', state.tokens.output);
