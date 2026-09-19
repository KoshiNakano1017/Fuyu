#!/usr/bin/env python3
"""マイグレーションの連番衝突を検出する（2026-09-19 新設）。

## なぜ要るのか

2026-09-16 に自律ループの実装フェーズを **Issue 単位の並列**へ変えた
（`auto-02-implement.yml` の concurrency を全体直列からやめた）。これは
「1件詰まると全部止まる」問題を解くために必要な変更だったが、**同時に走る
2つの実装が同じ連番を取り合う**という副作用を持つ。

実際に起きた: Issue #53（`quests`）と Issue #58（`lodging_register_entries`）が
並列に実装され、どちらも `0007_` を付けた。両方とも単独では CI が緑で、
**マージされて初めて** `schema_migrations_pkey` の一意制約に衝突し、
main の DB テストが全て落ちた。

PR 単体の CI では捕まらない。**マージ後に初めて壊れる**のが厄介な点である。
そこで「そのブランチの migrations を main と合わせたときに衝突しないか」を
PR の時点で検査する。

## 検査すること

1. 同じリポジトリ内で連番が重複していないか
2. ファイル名が `NNNN_name.sql` の形式に従っているか

`--base` を渡すと、そのリビジョンとの**合流後**の衝突も見る（CI ではこれを使う）。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

MIGRATIONS = Path("supabase/migrations")
NEWLINE = chr(10)
PATTERN = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


def versions_in_tree() -> dict[str, list[str]]:
    by_version: dict[str, list[str]] = defaultdict(list)
    for f in sorted(MIGRATIONS.glob("*.sql")):
        m = PATTERN.match(f.name)
        if not m:
            by_version["(形式違反)"].append(f.name)
            continue
        by_version[m.group(1)].append(f.name)
    return by_version


def versions_in_rev(rev: str) -> dict[str, list[str]]:
    """指定リビジョンの migrations/ を読む（合流後の衝突を見るため）。"""
    p = subprocess.run(
        ["git", "ls-tree", "--name-only", f"{rev}:{MIGRATIONS}"],
        capture_output=True, text=True, encoding="utf-8",
    )
    by_version: dict[str, list[str]] = defaultdict(list)
    if p.returncode != 0:
        return by_version
    for name in p.stdout.split("\n"):
        name = name.strip()
        if not name.endswith(".sql"):
            continue
        m = PATTERN.match(name)
        if m:
            by_version[m.group(1)].append(name)
    return by_version


def main() -> int:
    ap = argparse.ArgumentParser(description="マイグレーションの連番衝突を検出する")
    ap.add_argument("--base", help="合流先のリビジョン（例: origin/main）")
    args = ap.parse_args()

    if not MIGRATIONS.is_dir():
        print(f"{MIGRATIONS} が無いため検査をスキップします")
        return 0

    problems: list[str] = []
    here = versions_in_tree()

    if "(形式違反)" in here:
        for name in here.pop("(形式違反)"):
            problems.append(f"ファイル名が `NNNN_name.sql` の形式ではありません: {name}")

    for version, names in sorted(here.items()):
        if len(names) > 1:
            problems.append(
                f"連番 {version} が重複しています: {' / '.join(names)}\n"
                f"    → 依存を持たない側の番号を、最大値の次へ付け替えてください"
            )

    if args.base:
        # ⚠️ 合流後の姿を正しく組み立てる必要がある。
        #
        # 素朴に「ブランチの一覧」と「base の一覧」を突き合わせると、
        # **リネームを新規追加と誤認する**（旧名が base にまだ在るため衝突に見える）。
        # 実際にこの検査の初版がそれで自分の PR を落とした
        # （0007_lodging → 0010_lodging の改名を、0007 の衝突と報告した）。
        #
        # 正しくは「分岐点（merge-base）以降に base へ増えたファイル」だけが
        # マージで降ってくる分である。それをブランチの一覧へ足したものが合流後の姿。
        merged: dict[str, list[str]] = {v: list(n) for v, n in here.items()}
        mb = subprocess.run(
            ["git", "merge-base", "HEAD", args.base],
            capture_output=True, text=True, encoding="utf-8",
        )
        if mb.returncode == 0:
            at_fork = versions_in_rev(mb.stdout.strip())
            fork_names = {n for names in at_fork.values() for n in names}
            for version, names in versions_in_rev(args.base).items():
                for name in names:
                    # 分岐点から在るファイルは、このブランチが改名・削除した可能性がある。
                    # ブランチ側の一覧が正なので足さない。
                    if name in fork_names:
                        continue
                    if name not in merged.setdefault(version, []):
                        merged[version].append(name)

        for version, names in sorted(merged.items()):
            if len(names) > 1:
                problems.append(
                    f"連番 {version} が {args.base} との合流後に衝突します: "
                    f"{' / '.join(sorted(names))}"
                    + NEWLINE
                    + "    → **マージすると schema_migrations_pkey の一意制約に違反し、"
                    + "main の DB テストが全て落ちます。**"
                    + NEWLINE
                    + "    → 並列実装の副作用です（設計 §8.3 改訂）。番号を付け替えてください"
                )
    if problems:
        print("::error::マイグレーションの連番に問題があります")
        for p in problems:
            print(f"  - {p}")
        return 1

    total = sum(len(v) for v in here.values())
    tail = f"／ {args.base} との合流後も衝突なし" if args.base else ""
    print(f"マイグレーション {total} 件、連番の重複なし{tail}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
