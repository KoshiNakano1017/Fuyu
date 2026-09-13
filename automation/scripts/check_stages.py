#!/usr/bin/env python3
"""エージェント化の段取り（設計 §12.1.6）が、宣言どおり実在するかを検査する。

## なぜこのスクリプトが要るのか

2026-09-13 に、**段3（計画オーケストレータ）と段4（auto-01 の縮小）が
5日間「完了扱い」のまま未着手だった**ことが判明した。原因は文書の構造にある。

- 設計 §12.1 の冒頭に「**『移行』という作業は存在しない／やることはタスクを流すことだけ**」
  （2026-09-08 オーナー確定）という断定が置かれていた
- 一方その下の §12.1.6 の段取り表は「段3で `orchestrator/plan.mjs` を書き、
  段4で `auto-01-plan.yml` を削る」と明記していた
- **前者が後者を打ち消した。** 冒頭の要約だけを読んだ人は「やることは無い」と理解する
- `automation/README.md` も `auto-01`〜`03` を 🟢 完成 と書いていた。
  ワークフロー駆動版としては正しいが、段4 は同じファイルの**書き直し**を要求していた。
  同じ成果物が、読む文書によって「完成」とも「未着手」とも言える状態だった

段1・段2 には成果物を機械が触る経路があった（`spec_ref.py` が動く、
`check_agents.py` が動く）ため、未着手なら気づけた。
**段3以降には無かった。だから誰も気づかなかった。**

## このスクリプトが強制する不変条件

「段Nを完了と宣言するなら、その成果物が実在し、構文が通ること」。
文書の記述ではなくファイルシステムを見る。

使い方:
    python3 automation/scripts/check_stages.py
    python3 automation/scripts/check_stages.py --json

終了コード: 0=宣言と実態が一致 ／ 3=食い違いあり

<!-- 由来: 2026-09-13 段3〜5の実装で発覚した「完了扱いの未着手」
     防ぐ失敗: 段取り表に書いた工程が、要約の断定に打ち消されて放置されること
     再発回数: 1 -->
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

# 段 → (説明, 成果物, 完了と宣言しているか)
#
# `declared` は「設計・README が完了と書いているか」を人が保守する欄。
# ここを true にしたのに成果物が無ければ落ちる。**宣言を先に書けなくする**のが狙い。
STAGES: list[dict] = [
    {
        "stage": 0,
        "title": "ゲート境界の確定",
        "artifacts": ["docs/自律開発ループ設計.md"],
        "declared": True,
    },
    {
        "stage": 1,
        "title": "節番号 → ファイル位置の解決",
        "artifacts": ["automation/scripts/spec_ref.py"],
        "declared": True,
    },
    {
        "stage": 2,
        "title": "prompts + settings → エージェント定義",
        "artifacts": ["automation/agents", "automation/settings",
                      "automation/scripts/check_agents.py"],
        "declared": True,
    },
    {
        "stage": 3,
        "title": "計画オーケストレータ",
        "artifacts": ["automation/orchestrator/plan.mjs",
                      "automation/orchestrator/lib/runAgent.mjs",
                      "automation/orchestrator/lib/schema.mjs",
                      "automation/orchestrator/lib/state.mjs"],
        "declared": True,
    },
    {
        "stage": 4,
        "title": "auto-01-plan.yml を削る（判定を YAML から外す）",
        "artifacts": [".github/workflows/auto-01-plan.yml"],
        "declared": True,
        # 判定ロジックが YAML に残っていないことを見る。
        "forbidden_in": {
            ".github/workflows/auto-01-plan.yml": [
                "grep -oE '<!--risk:",   # 旧 classify / reclassify の痕跡
                "steps.classify.outputs",
                "steps.reclassify.outputs",
            ]
        },
    },
    {
        "stage": 5,
        "title": "試運転で回帰確認",
        "artifacts": ["automation/scripts/check_stages.py"],
        "declared": True,
    },
    {
        "stage": 6,
        "title": "足場（人手）",
        "artifacts": ["package.json", "src", "tests"],
        "declared": True,
    },
    {
        "stage": 7,
        "title": "verify.sh ＋ 実装・レビューオーケストレータ",
        "artifacts": ["automation/scripts/verify.sh",
                      "automation/orchestrator/implement.mjs",
                      "automation/orchestrator/review.mjs",
                      ".github/workflows/auto-02-implement.yml",
                      ".github/workflows/auto-03-review-merge.yml"],
        "declared": True,
        # 配線されたことを見る。YAML が orchestrator を呼んでいなければ落とす。
        "required_in": {
            ".github/workflows/auto-02-implement.yml": [
                "automation/orchestrator/implement.mjs",
            ],
            ".github/workflows/auto-03-review-merge.yml": [
                "automation/orchestrator/review.mjs",
            ],
        },
        # 旧方式のジョブが残っていないこと。
        "forbidden_in": {
            ".github/workflows/auto-03-review-merge.yml": [
                "\n  review-quality:",
                "\n  review-privacy:",
                "\n  fix:",
            ],
        },
    },
]


def syntax_ok(path: Path) -> tuple[bool, str]:
    """構文が通るかを軽く見る。存在するだけの空ファイルを完了と数えないため。"""
    if path.is_dir():
        return (any(path.iterdir()), "空ディレクトリ")
    if path.suffix == ".mjs":
        r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
        return (r.returncode == 0, r.stderr.strip()[:200])
    if path.suffix == ".sh":
        r = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
        return (r.returncode == 0, r.stderr.strip()[:200])
    if path.suffix == ".py":
        r = subprocess.run([sys.executable, "-m", "py_compile", str(path)],
                           capture_output=True, text=True)
        return (r.returncode == 0, r.stderr.strip()[:200])
    return (path.stat().st_size > 0, "空ファイル")


def check() -> tuple[list[str], list[str]]:
    problems: list[str] = []
    notes: list[str] = []

    for s in STAGES:
        missing = [a for a in s["artifacts"] if not Path(a).exists()]
        if s["declared"] and missing:
            problems.append(
                f"段{s['stage']}（{s['title']}）を完了と宣言しているが成果物が無い: "
                + ", ".join(missing)
            )
            continue

        if not s["declared"]:
            present = [a for a in s["artifacts"] if Path(a).exists()]
            notes.append(
                f"段{s['stage']}（{s['title']}）は未完。"
                + (s.get("note") or "")
                + (f" 実在: {len(present)}/{len(s['artifacts'])}" if present else "")
            )
            continue

        for a in s["artifacts"]:
            ok, why = syntax_ok(Path(a))
            if not ok:
                problems.append(f"段{s['stage']}: {a} の検査に失敗（{why}）")

        for path, patterns in (s.get("required_in") or {}).items():
            try:
                text = Path(path).read_text(encoding="utf-8")
            except OSError:
                problems.append(f"段{s['stage']}: {path} が読めない")
                continue
            for pat in patterns:
                if pat not in text:
                    problems.append(
                        f"段{s['stage']}: {path} が {pat!r} を呼んでいない（配線が未了）"
                    )

        for path, patterns in (s.get("forbidden_in") or {}).items():
            try:
                text = Path(path).read_text(encoding="utf-8")
            except OSError:
                continue
            for pat in patterns:
                if pat in text:
                    problems.append(
                        f"段{s['stage']}: {path} に旧方式の痕跡が残っている（{pat!r}）。"
                        "判定はオーケストレータの構造化出力へ移したはず（設計 §12.1.8 #1）"
                    )
    return problems, notes


def main() -> int:
    parser = argparse.ArgumentParser(description="段取りの宣言と実態の一致を検査する")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    problems, notes = check()

    if args.as_json:
        print(json.dumps({"ok": not problems, "problems": problems, "notes": notes},
                         ensure_ascii=False, indent=2))
        return 0 if not problems else 3

    for s in STAGES:
        mark = "[ok]" if s["declared"] else "[--]"
        print(f"  {mark} 段{s['stage']}: {s['title']}")
    if notes:
        print()
        for n in notes:
            print(f"  [note] {n}")
    if problems:
        print()
        for p in problems:
            print(f"  [NG] {p}")
        print(f"\n{len(problems)} 件の食い違い。宣言を下げるか、成果物を作ること。")
        return 3
    print("\n宣言と実態は一致している。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
