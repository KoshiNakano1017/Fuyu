"""WBS の差分が許可セルだけかを検証する（設計 §8.2 ガード②）。

**テキスト差分の grep ではなく、表としてパースして構造比較する。**
理由は設計 §8.2 の [!important] に書いたとおりで、セル内に `|` や太字装飾を含む
WBS を正規表現で見ると簡単に破綻し、しかも**空振りが緑になる**（危険側に倒れる）。
ここでは「パースできなければ失敗」「判断がつかなければ失敗」と安全側に倒す。

許可するのは次だけ（設計 §0 の注記）:
  - 対象作業パッケージ**1行**の、実装 / 総合 / ステータスの**3列**

使い方（ワークフローから）:
    git show origin/main:docs/spec/WBS_Phase1.md > /tmp/base.md
    python wbs_guard.py --base /tmp/base.md --head docs/spec/WBS_Phase1.md --package 4-1
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import wbs_lib as W
from wbs_to_issue import normalize_id


def fingerprint(path: Path) -> dict[str, dict[str, str]]:
    """ID → {列名: セル} の写像を作る。パースできなければ例外。"""
    packages = W.load_packages(path)
    if not packages:
        raise ValueError(f"{path} から作業パッケージを1件も読めませんでした（表が壊れている可能性）")
    return {key: package.cells_by_column() for key, package in packages.items()}


def compare(base: dict, head: dict, allowed_key: str | None) -> list[str]:
    """差分を検査し、違反の説明を並べて返す。空なら合格。"""
    violations: list[str] = []

    added = set(head) - set(base)
    removed = set(base) - set(head)
    if added:
        violations.append(f"作業パッケージが追加されています: {', '.join(sorted(added))}")
    if removed:
        violations.append(f"作業パッケージが削除されています: {', '.join(sorted(removed))}")

    for key in sorted(set(base) & set(head)):
        base_cells, head_cells = base[key], head[key]

        if set(base_cells) != set(head_cells):
            violations.append(f"{key}: 列構成が変わっています")
            continue

        for column in sorted(base_cells):
            if base_cells[column] == head_cells[column]:
                continue

            if key != allowed_key:
                violations.append(
                    f"{key}: 対象外の行が変更されています（列『{column}』）"
                    f" — 許可されているのは {allowed_key or '(指定なし)'} だけです"
                )
            elif column not in W.WRITABLE_COLUMNS:
                violations.append(
                    f"{key}: 列『{column}』は書き換えできません"
                    f"（許可: {' / '.join(W.WRITABLE_COLUMNS)}）"
                )

    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description="WBS の差分が許可セルだけかを検証する")
    parser.add_argument("--base", type=Path, required=True, help="変更前の WBS")
    parser.add_argument("--head", type=Path, required=True, help="変更後の WBS")
    parser.add_argument("--package", help="変更を許可する作業パッケージ番号（例: 4-1）")
    args = parser.parse_args()

    for path in (args.base, args.head):
        if not path.exists():
            print(f"::error::ファイルがありません: {path}", file=sys.stderr)
            return 2

    try:
        base = fingerprint(args.base)
        head = fingerprint(args.head)
    except ValueError as exc:  # パース不能は「判断がつかない」＝失敗させる
        print(f"::error::WBS をパースできません: {exc}", file=sys.stderr)
        return 1

    allowed_key = normalize_id(args.package) if args.package else None
    if allowed_key and allowed_key not in head:
        print(
            f"::error::許可対象として指定された '{args.package}' が WBS にありません",
            file=sys.stderr,
        )
        return 1

    violations = compare(base, head, allowed_key)
    if violations:
        print("::error::WBS の変更が許可範囲を超えています（設計 §0・§8.2 ガード②）", file=sys.stderr)
        for violation in violations:
            print(f"  - {violation}", file=sys.stderr)
        return 1

    changed = [
        key
        for key in set(base) & set(head)
        if base[key] != head[key]
    ]
    if changed:
        print(f"WBS の変更は許可範囲内です（対象: {', '.join(changed)}）")
    else:
        print("WBS に差分はありません")
    return 0


if __name__ == "__main__":
    sys.exit(main())
