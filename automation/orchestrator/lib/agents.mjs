// automation/agents/*.md を読み、オーケストレータが使える形へ変換する。
//
// 設計 §12.1.3: 権限は2層に分かれる。
//   ツール層 — 定義の frontmatter `tools:`（どのツールを持つか）
//   パス層   — automation/settings/*.json（持っているツールをどこまで使えるか）
// どちらか片方だけでは §7.2 の権限制限が成立しないため、両方を読んで返す。
//
// 依存を増やさないため、frontmatter は「1行1キー」の範囲だけを自前で解く。
// automation/agents/*.md はその範囲に収まっており、逸脱は check_agents.py が落とす。

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const AGENTS_DIR = 'automation/agents';

/** `tools: Read, Glob, Grep` → ['Read','Glob','Grep'] */
function parseToolList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `settings:` は 2 通りの書かれ方をする。
 *   automation/settings/pm.json            → パス
 *   なし（書き込み系ツールを持たないため） → パス無し
 * 後者を「ファイル名」として扱うと存在しないパスを開きに行くため、明示的に切り分ける。
 */
function parseSettingsRef(value) {
  if (!value) return null;
  const v = value.trim();
  if (!v || v.startsWith('なし')) return null;
  if (!v.endsWith('.json')) return null;
  return v;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) {
    throw new Error('frontmatter がありません');
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) throw new Error('frontmatter が閉じていません');

  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');

  const meta = {};
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    meta[key] = value;
  }
  return { meta, body };
}

/**
 * 1体分の定義を読む。
 * @param {string} name 例: 'pm-define'
 * @param {string} [root] リポジトリルート
 */
export async function loadAgent(name, root = process.cwd()) {
  const file = path.join(root, AGENTS_DIR, `${name}.md`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`エージェント定義が見つかりません: ${file}`);
  }

  const { meta, body } = parseFrontmatter(text);
  if (!meta.name) throw new Error(`${name}.md: frontmatter に name がありません`);
  if (meta.name !== name) {
    throw new Error(`${name}.md: frontmatter の name (${meta.name}) がファイル名と一致しません`);
  }

  const settingsPath = parseSettingsRef(meta.settings);
  let permissions = null;
  if (settingsPath) {
    const raw = await readFile(path.join(root, settingsPath), 'utf8');
    permissions = JSON.parse(raw).permissions ?? null;
  }

  return {
    name: meta.name,
    description: meta.description ?? '',
    tools: parseToolList(meta.tools),
    model: meta.model || 'claude-opus-5',
    // effort は frontmatter 由来。設計 §3 の effort 表がここで効く。
    effort: meta.effort || 'medium',
    settingsPath,
    permissions,
    // 本文がそのままシステムプロンプトになる。
    // 「automation/agents/X.md を読め」という間接指示をやめ、
    // 中身を直接渡す（ランナーが読めない環境でも成立させるため）。
    prompt: body.trim(),
  };
}

/** 全定義を読む。check_agents.py と同じ対象範囲。 */
export async function loadAllAgents(root = process.cwd()) {
  const dir = path.join(root, AGENTS_DIR);
  const files = await readdir(dir);
  const names = files
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.slice(0, -3));

  const out = {};
  for (const n of names) out[n] = await loadAgent(n, root);
  return out;
}
