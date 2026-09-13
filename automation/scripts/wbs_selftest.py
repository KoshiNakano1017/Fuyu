"""導線4・導線5（設計 §10.1.5）の再発検査。実物の WBS に対して実行する。

`wbs_to_issue.py --selftest` と同じ思想で、**WBS 側の編集で静かに壊れる**ものを拾う。
ここで守っているのは次の4点である。

1. **総合% の算術** — 総合 ＝ 設計 × 0.4 ＋ 実装 × 0.6（WBS L95）。
   既存行と計算が一致しなくなったら、重みが変わったか列がずれている。
2. **依存列の取り消し線** — `~~1-4~~ **なし**` を `1-4` と読むと依存順が狂う。
3. **廃止・ブロック判定の範囲** — 散文に出てくる「不要化」で誤判定しない
   （2026-09-13 に `4-1` が起票不能だった不具合の再発検査）。
4. **ガードの拒否条件** — 対象外の行・対象外の列・行の増減を確実に弾く。
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import wbs_guard
import wbs_lib as W
from wbs_to_issue import normalize_id

WBS = Path("docs/spec/WBS_Phase1.md")

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    if not WBS.exists():
        print(f"WBS が見つかりません: {WBS}", file=sys.stderr)
        return 2

    packages = W.load_packages(WBS)
    check(len(packages) >= 60, f"作業パッケージが少なすぎます（{len(packages)} 件）。表の取りこぼしの疑い")

    # ── 1. 総合% の算術 ───────────────────────────────────────────────
    checked = 0
    for package in packages.values():
        design, impl = package.design_pct, package.impl_pct
        total = W.parse_pct(package.get(W.COL_TOTAL))
        if None in (design, impl, total):
            continue
        checked += 1
        check(
            W.calc_total(design, impl) == total,
            f"{package.id}: 総合% が式と合いません（設計{design} 実装{impl} → "
            f"計算{W.calc_total(design, impl)} ／ 記載{total}）",
        )
    check(checked >= 40, f"総合% を検算できた行が少なすぎます（{checked} 行）")

    # ── 2. 依存列の取り消し線 ─────────────────────────────────────────
    check(W.parse_deps("~~1-4~~ **なし**") == [], "取り消された依存が復活しています")
    check(W.parse_deps("~~1-4, 1-5, 4-1~~ **1-5, 4-1**") == ["1-5", "4-1"], "依存の差し替えを読めていません")
    check(W.parse_deps("4-2, 5-1") == ["4-2", "5-1"], "通常の依存を読めていません")
    check(W.parse_deps("なし") == [], "「なし」を依存として読んでいます")

    # ── 3. 廃止・ブロック判定の範囲（2026-09-13 の不具合の再発検査） ──────
    #   4-1 は「🟢 着手可能」だが散文に「すべて不要化した」を含む。ここを廃止と読むと
    #   **着手可能な作業パッケージが起票できなくなる**。
    for package_id, want_dropped, want_blocked, note in [
        ("4-1", False, False, "散文の「不要化」を廃止と誤読している"),
        ("4-2", False, True, "ブロック中が廃止に倒れている"),
        ("13-2", True, False, "取り消し線つき ID の廃止を見落としている"),
    ]:
        package = packages.get(normalize_id(package_id))
        if package is None:
            failures.append(f"{package_id} が WBS に見つかりません（検査を更新してください）")
            continue
        check(package.is_dropped is want_dropped, f"{package_id}: is_dropped={package.is_dropped} — {note}")
        check(package.is_blocked is want_blocked, f"{package_id}: is_blocked={package.is_blocked} — {note}")

    # ── 4. ガードの拒否条件 ───────────────────────────────────────────
    base_text = WBS.read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp) / "base.md"
        head = Path(tmp) / "head.md"
        base.write_text(base_text, encoding="utf-8", newline="")

        target = packages[normalize_id("4-1")]
        allowed = normalize_id("4-1")

        def guard(text: str) -> list[str]:
            head.write_text(text, encoding="utf-8", newline="")
            return wbs_guard.compare(
                wbs_guard.fingerprint(base), wbs_guard.fingerprint(head), allowed
            )

        # 4a. 許可セルだけの変更は通る
        lines = base_text.split("\n")
        cells = target.cells_by_column()
        cells[W.COL_IMPL] = "100%"
        cells[W.COL_TOTAL] = W.format_pct(W.calc_total(target.design_pct, 100))
        cells[W.COL_STATUS] = "✅ 完了（#1）"
        lines[target.line - 1] = W.render_row(target.headers, cells)
        check(guard("\n".join(lines)) == [], "許可セルだけの変更が拒否されました")

        # 4b. 対象外の列（設計%）は拒否される
        lines = base_text.split("\n")
        cells = target.cells_by_column()
        cells[W.COL_DESIGN] = "99%"
        lines[target.line - 1] = W.render_row(target.headers, cells)
        check(guard("\n".join(lines)) != [], "設計% の書き換えが素通りしました")

        # 4c. 対象外の行は拒否される
        other = packages[normalize_id("4-3")]
        lines = base_text.split("\n")
        cells = other.cells_by_column()
        cells[W.COL_IMPL] = "100%"
        lines[other.line - 1] = W.render_row(other.headers, cells)
        check(guard("\n".join(lines)) != [], "対象外の行の書き換えが素通りしました")

        # 4d. 行の削除は拒否される
        lines = [l for i, l in enumerate(base_text.split("\n")) if i != other.line - 1]
        check(guard("\n".join(lines)) != [], "行の削除が素通りしました")

    # ── 5. 機能領域の入力が作業パッケージへ誤着弾しないこと ────────────
    #   `4` は §16（ブロッカー逆引き表）にも1列目 `4` の行があるため、
    #   作業パッケージ表**以外**へ着弾すると「[auto] WBS 4」という空の Issue が作れてしまう。
    #   設計 §10.1.5 導線4 の振り分けは「作業パッケージとして引けるか」で決めるため、
    #   ここが壊れると機能領域を入れてもエピックにならない（2026-09-13 の不具合）。
    import wbs_to_issue

    for area_input in ("4", "13", "§4"):
        row, _ = wbs_to_issue.parse_wbs(WBS, area_input)
        check(
            row is None,
            f"機能領域の入力 '{area_input}' が作業パッケージに解決しています"
            f"（{row.get('_section') if row else ''}）— エピックへ振り分けられません",
        )
    for package_input in ("4-1", "0-1", "3-5b", "14-6"):
        row, _ = wbs_to_issue.parse_wbs(WBS, package_input)
        check(row is not None, f"作業パッケージ '{package_input}' を引けません")

    if failures:
        print("セルフテスト失敗:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"セルフテスト通過（導線4・導線5 ／ 作業パッケージ {len(packages)} 件・総合% 検算 {checked} 行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
