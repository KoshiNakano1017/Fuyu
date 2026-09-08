#!/usr/bin/env python3
"""エージェント定義（`automation/agents/*.md`）の整合性を機械的に検査する（設計 §12.1.6 段2）。

設計 §7.2 は「権限をプロンプトの文章ではなく設定で絞る」と定めている。エージェント方式では
権限が **2層** に分かれるため、両者の食い違いを人手のレビューに委ねると穴が残る。

| 層 | どこに書くか | 何を決めるか |
| --- | --- | --- |
| ツール層 | 定義の frontmatter `tools:` | **どのツールを持つか**（`Write` を持たなければ物理的に書けない） |
| パス層 | `automation/settings/*.json` | **持っているツールをどこまで使えるか**（`Edit` は持つが `tests/` は拒否） |

frontmatter の `tools:` は**ツール名の並びであってパスを表現できない**ため、
書き込み系ツールを持つエージェントは settings 側のパス制限が必須になる。
本スクリプトはその対応関係と、設計上ゆずれない不変条件を検査する。

検査する不変条件:
  1. frontmatter が壊れていない・必須キーが揃っている・`name` がファイル名と一致する
  2. 未知のツール名を書いていない
  3. 書き込み系ツールを持つなら、実在する settings ファイルを指している
  4. **どのエージェントも `docs/spec/` を書き換えられない**（設計 §0 ／ §8.2 の二重防御①）
  5. **コーディング・修正エージェントは `tests/` を書き換えられない**
     （受入テストを自分で通るように改変できると、設計 §11.6 の commit-first が壊れる）

使い方:
    python3 automation/scripts/check_agents.py
    python3 automation/scripts/check_agents.py --json

終了コード: 0=違反なし ／ 2=ディレクトリが無い ／ 3=違反あり
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

AGENTS_DIR = Path("automation/agents")
# README.md は定義ではなく解説。検査対象から外す。
NOT_AGENTS = {"README"}
SETTINGS_DIR = Path("automation/settings")

REQUIRED_KEYS = ("name", "description", "tools", "settings", "model", "effort")

# Claude Code が備えるツール名。ここに無い名前は綴り間違いとして落とす。
KNOWN_TOOLS = {
    "Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit",
    "Bash", "WebFetch", "WebSearch", "Task", "TodoWrite",
}
# 持っているだけでリポジトリを書き換えうるツール。パス制限（settings）が必須になる。
WRITE_TOOLS = {"Write", "Edit", "NotebookEdit", "Bash"}

# 設計 §3 の10体 ＋ §12.1.2 で追加した独立リスク判定。
# 実装ループ側の6体は足場（§12 #2）が出来るまで着手しないため、未定義でも違反にしない。
EXPECTED_AGENTS = {
    "pm-define": "計画",
    "risk-classify": "計画",
    "research": "計画",
    "pm-plan": "計画",
    "test-design": "実装",
    "coding": "実装",
    "review-quality": "レビュー",
    "review-spec": "レビュー",
    "review-privacy": "レビュー",
    "fix": "レビュー",
    "pm-report": "レビュー",
}
# `tests/` の改変を禁じる必要があるエージェント（実装コードを書ける側）。
TEST_GUARDED = {"coding", "fix"}


def agent_files() -> list[Path]:
    """定義ファイルだけを拾う（README.md を除く）。"""
    return sorted(p for p in AGENTS_DIR.glob("*.md") if p.stem not in NOT_AGENTS)


def parse_frontmatter(path: Path) -> tuple[dict[str, str], str | None]:
    """`---` で挟まれた frontmatter を素朴に読む。

    値に `:` を含む説明文があるため、最初の `:` だけで分割する。
    PyYAML には依存しない（既存スクリプトと同じく標準ライブラリだけで動かす）。
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, "先頭が `---` で始まっていない（frontmatter が無い）"

    fields: dict[str, str] = {}
    for index in range(1, len(lines)):
        line = lines[index]
        if line.strip() == "---":
            return fields, None
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            return fields, f"{index + 1}行目が `キー: 値` の形になっていない: {line!r}"
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()
    return fields, "frontmatter の終端 `---` が見つからない"


def load_settings(name: str) -> tuple[dict | None, str | None]:
    """settings の JSON を読む。`なし` で始まる値は「パス制限を要さない」の意。"""
    if name.startswith("なし"):
        return None, None
    path = Path(name)
    if not path.is_file():
        return None, f"settings が実在しない: {name}"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as error:
        return None, f"settings の JSON が壊れている: {name}（{error}）"


def blocks_writes_to(settings: dict, glob: str) -> bool:
    """`glob` 配下への書き込みが settings で塞がれているかを判定する。

    ツールごと全面拒否（`"Write"`）でも、パス指定の拒否（`"Write(tests/**)"`）でもよい。
    片方だけ（Edit は塞いだが Write は空いている等）は塞がったとみなさない。
    """
    deny = set(settings.get("permissions", {}).get("deny", []))
    for tool in ("Write", "Edit"):
        if tool not in deny and f"{tool}({glob})" not in deny:
            return False
    return True


def check_agent(path: Path) -> list[str]:
    """定義1本を検査し、違反の説明を並べて返す（空なら合格）。"""
    problems: list[str] = []
    fields, error = parse_frontmatter(path)
    if error is not None:
        return [error]

    for key in REQUIRED_KEYS:
        if key not in fields:
            problems.append(f"必須キー `{key}` が無い")
    if problems:
        return problems

    if fields["name"] != path.stem:
        problems.append(f"`name: {fields['name']}` がファイル名 `{path.stem}` と一致しない")

    tools = {tool.strip() for tool in fields["tools"].split(",") if tool.strip()}
    unknown = sorted(tools - KNOWN_TOOLS)
    if unknown:
        problems.append(f"未知のツール名: {', '.join(unknown)}")

    settings, error = load_settings(fields["settings"])
    if error is not None:
        problems.append(error)
        return problems

    writes = tools & WRITE_TOOLS
    if writes and settings is None:
        problems.append(
            f"書き込み系ツール（{', '.join(sorted(writes))}）を持つのに settings が `なし` になっている。"
            "frontmatter はパスを表現できないため、パス制限は settings 側が必須（設計 §7.2）"
        )
    if not writes and settings is not None:
        problems.append("書き込み系ツールを持たないのに settings を指している（不要な二重管理）")

    if settings is not None:
        if not blocks_writes_to(settings, "docs/spec/**"):
            problems.append(
                "`docs/spec/` への書き込みが塞がれていない（設計 §0 ／ §8.2 の二重防御①）"
            )
        if path.stem in TEST_GUARDED and not blocks_writes_to(settings, "tests/**"):
            problems.append(
                "`tests/` への書き込みが塞がれていない。"
                "受入テストを自分で通るように改変できると設計 §11.6 の commit-first が壊れる"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(
        description="エージェント定義の整合性を検査する（設計 §12.1.6 段2）"
    )
    parser.add_argument("--json", action="store_true", dest="as_json", help="結果を JSON で出す")
    args = parser.parse_args()

    if not AGENTS_DIR.is_dir():
        print(f"エージェント定義のディレクトリが無い: {AGENTS_DIR}", file=sys.stderr)
        return 2

    found = sorted(path.stem for path in agent_files())
    violations: dict[str, list[str]] = {}
    for path in agent_files():
        problems = check_agent(path)
        if problems:
            violations[path.stem] = problems

    unexpected = sorted(set(found) - set(EXPECTED_AGENTS))
    for name in unexpected:
        violations.setdefault(name, []).append(
            "設計 §3 に対応するエージェントが無い。設計へ追記するか、定義名を見直すこと"
        )
    pending = sorted(set(EXPECTED_AGENTS) - set(found))

    if args.as_json:
        print(
            json.dumps(
                {
                    "ok": not violations,
                    "defined": found,
                    "pending": pending,
                    "violations": violations,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if not violations else 3

    print(f"定義済み: {len(found)} 体 / 想定 {len(EXPECTED_AGENTS)} 体")
    for name in found:
        mark = "NG" if name in violations else "ok"
        print(f"  [{mark}] {name}（{EXPECTED_AGENTS.get(name, '?')}）")
    if pending:
        print(f"\n未定義（足場の完成待ち・違反ではない）: {', '.join(pending)}")

    if violations:
        print("\n違反:")
        for name, problems in violations.items():
            for problem in problems:
                print(f"  - {name}: {problem}")
        return 3

    print("\n違反なし。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
