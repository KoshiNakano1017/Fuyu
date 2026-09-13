// GitHub 操作の薄いラッパ。
//
// ラベル遷移とゲート制御は **ワークフローが持ち続ける**（設計 §12.1.1 ③・§12.1.3）。
// オーケストレータがここで触るのは「コメントの投稿」と「読み取り」だけに限る。
// エージェントに制御フローを渡すと「説得できる門番」ができてしまうため、
// ラベルを動かす権限はオーケストレータにも与えない。

import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY ?? '';

export function run(cmd, args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function bodyFile(text) {
  const dir = await mkdtemp(path.join(tmpdir(), 'orc-'));
  const file = path.join(dir, 'body.md');
  await writeFile(file, text, 'utf8');
  return file;
}

/**
 * Issue へコメントする。
 * 失敗してもフェーズは落とさない（転記の失敗で判定まで失うのは割に合わない）。
 * 呼び出し側は戻り値の ok を見て、必要なら警告を出す。
 */
export async function comment(issue, text) {
  if (!text || !text.trim()) return { ok: true, skipped: true };
  // GitHub のコメント上限は 65536 文字。末尾にマーカーが来る運用なので中間を落とす。
  let body = text;
  if (body.length > 60000) {
    body = `${body.slice(0, 40000)}\n\n---\n*（長さの上限のため中間を省略しました。全文は Actions のログを参照）*\n---\n\n${body.slice(-15000)}`;
  }
  const file = await bodyFile(body);
  const r = await run('gh', ['issue', 'comment', String(issue), '--repo', REPO, '--body-file', file]);
  if (r.code !== 0) console.error(`::warning::Issue #${issue} へのコメントに失敗しました: ${r.stderr}`);
  return { ok: r.code === 0 };
}

export async function prComment(pr, text) {
  if (!text || !text.trim()) return { ok: true, skipped: true };
  const file = await bodyFile(text);
  const r = await run('gh', ['pr', 'comment', String(pr), '--repo', REPO, '--body-file', file]);
  if (r.code !== 0) console.error(`::warning::PR #${pr} へのコメントに失敗しました: ${r.stderr}`);
  return { ok: r.code === 0 };
}

export async function issueJson(issue, fields) {
  const r = await run('gh', ['issue', 'view', String(issue), '--repo', REPO, '--json', fields]);
  if (r.code !== 0) throw new Error(`gh issue view に失敗しました: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** GitHub Actions の出力変数へ書く（ワークフローがラベル遷移に使う）。 */
export async function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  const line = `${key}=${String(value).replace(/\n/g, ' ')}\n`;
  if (!file) {
    console.log(`[output] ${line.trim()}`);
    return;
  }
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, line, 'utf8');
}

/** 複数行の値を出力する（ヒアドキュメント形式）。 */
export async function setMultilineOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  const delim = `EOF_${key}_${Math.abs(hashCode(String(value)))}`;
  const block = `${key}<<${delim}\n${value}\n${delim}\n`;
  if (!file) {
    console.log(`[output] ${key} = (${String(value).length} chars)`);
    return;
  }
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, block, 'utf8');
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function notice(msg) {
  console.log(`::notice::${msg}`);
}
export function warn(msg) {
  console.log(`::warning::${msg}`);
}
export function error(msg) {
  console.log(`::error::${msg}`);
}
