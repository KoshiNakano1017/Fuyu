"""WBS の進捗セルを決定的に書き換える（設計 §10.1.5 導線5）。

**エージェントは使わない。** 書き換えるのは実装 / 総合 / ステータスの3セルだけで、
対象は Issue が指す作業パッケージ1行のみ（設計 §0 の注記・§8.2 ガード②の許可集合）。

なぜスクリプトなのか（設計 §10.1.5 導線5）:
  エージェントに `Edit(docs/spec/WBS_Phase1.md)` を許可すると、
  ①WBS 全体を書き換える余地が生まれ、②§7.2.1 が記録する「パス規則は Edit / Read しか
  評価されない」挙動に依存することになる。ワークフローの run: ステップから
  本スクリプトを呼べば、**エージェントの権限を1つも広げずに**進捗を反映できる。

使い方:
    python wbs_update.py --package 4-1 --issue 42 --done
    python wbs_update.py --package 4-1 --issue 42 --done --dry-run
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

import wbs_lib as W
from wbs_to_issue import normalize_id, status_head

DEFAULT_WBS = Path("docs/spec/WBS_Phase1.md")


def build_status(current: str, issue: int | None, today: str) -> str:
    """ステータス欄の**宣言部分だけ**を「✅ 完了」に差し替え、散文は残す。

    ステータス欄には `🟢 着手可能。**2026-09-05 オーナー決定でスコープ変更**：…` のように、
    宣言のあとにオーナーの決定や申し送りが書かれている。**ここを捨ててはならない。**
    宣言を丸ごと置き換えると、後から「なぜこの作りになったか」を辿れなくなる
    （`CLAUDE.md` §2「来歴のない決定は決定として扱わない」）。
    """
    ref = f"（#{issue} ／ {today}）" if issue else f"（{today}）"
    head = status_head(current)
    rest = current[len(head):]  # 先頭の「。」を含む残り。無ければ空文字
    return f"✅ 完了{ref}{rest}"


def update(
    wbs: Path,
    package_id: str,
    issue: int | None,
    impl_pct: int,
    today: str,
) -> tuple[str, str]:
    """該当行の3セルを書き換え、`(旧行, 新行)` を返す。"""
    packages = W.load_packages(wbs)
    key = normalize_id(package_id)
    package = packages.get(key)
    if package is None:
        raise SystemExit(f"作業パッケージ '{package_id}' が {wbs} に見つかりません")

    design = package.design_pct
    if design is None:
        raise SystemExit(
            f"'{package.id}' の設計% を読めません（'{package.get(W.COL_DESIGN)}'）。"
            "総合% を算出できないため中止します"
        )

    for column in W.WRITABLE_COLUMNS:
        if column not in package.headers:
            raise SystemExit(f"'{package.id}' の表に列 '{column}' がありません。中止します")

    cells = package.cells_by_column()
    cells[W.COL_IMPL] = W.format_pct(impl_pct)
    cells[W.COL_TOTAL] = W.format_pct(W.calc_total(design, impl_pct))
    if impl_pct >= 100:
        cells[W.COL_STATUS] = build_status(package.status, issue, today)

    lines = W.read_lines(wbs)
    index = package.line - 1
    old_line = lines[index]
    new_line = W.render_row(package.headers, cells)
    lines[index] = new_line
    W.write_lines(wbs, lines)
    return old_line, new_line


def main() -> int:
    parser = argparse.ArgumentParser(description="WBS の進捗セルを更新する（設計 §10.1.5 導線5）")
    parser.add_argument("--package", required=True, help="作業パッケージ番号（例: 4-1）")
    parser.add_argument("--issue", type=int, help="対応する Issue 番号（ステータス欄に残す）")
    parser.add_argument("--wbs", type=Path, default=DEFAULT_WBS)
    parser.add_argument("--impl", type=int, default=100, help="実装%%（既定 100）")
    parser.add_argument("--date", default=None, help="記録する日付（既定は今日）")
    parser.add_argument("--dry-run", action="store_true", help="書き込まずに差分だけ出す")
    args = parser.parse_args()

    if not 0 <= args.impl <= 100:
        parser.error("--impl は 0〜100")
    if not args.wbs.exists():
        print(f"WBS が見つかりません: {args.wbs}", file=sys.stderr)
        return 2

    today = args.date or date.today().isoformat()

    if args.dry_run:
        original = args.wbs.read_text(encoding="utf-8")
        try:
            old, new = update(args.wbs, args.package, args.issue, args.impl, today)
        finally:
            args.wbs.write_text(original, encoding="utf-8", newline="")
    else:
        old, new = update(args.wbs, args.package, args.issue, args.impl, today)

    print("- " + old)
    print("+ " + new)
    return 0


if __name__ == "__main__":
    sys.exit(main())
