#!/usr/bin/env python3
"""WBS_Phase1.md の作業パッケージを Issue 本文へ変換する（設計 §10.1.5 導線1）。

このスクリプトは **転記しかしない**。仕様判断・優先順位づけ・完了条件の考案は行わない
（設計 §0：仕様判断はオーナーの専権事項）。

自動で埋まるのは Issue テンプレート5項目のうち3つ（目的・根拠となる仕様・想定サイズ）だけで、
**完了条件とスコープ外は意図的に空欄のまま**にする。WBS には検証可能な完了条件が
書かれていないため、ここを機械が埋めると「起票の場で仕様を考える」ことになり、
翌朝のゲート1が機能しなくなる（設計 §10.1.3 の警告）。

使い方:
    python3 automation/scripts/wbs_to_issue.py 3-5b
    python3 automation/scripts/wbs_to_issue.py 3-5b --wbs docs/spec/WBS_Phase1.md

出力: 標準出力へ JSON（title / body / labels / blocked / retired / reason）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_WBS = "docs/spec/WBS_Phase1.md"

# ステータス欄が「実装に進めない」ことを示す記号・語。§16 のブロッカー逆引き表と対応する。
BLOCKED_MARKERS = ("🔴", "ブロック中", "⏸", "保留")
# 廃止・不要化・統合済みを示す記号。これらは起票させない。
RETIRED_MARKERS = ("➖", "不要化", "廃止", "統合済み", "移送")

# 「v13 §5.2.3」「§5.11.7」「§9 #46」のような正本への参照を拾う。
SECTION_RE = re.compile(r"§\s?\d+(?:\.\d+)*[a-z]?(?:\s?#\d+)?")
# 機能領域の見出し末尾の丸括弧。ここに正本の節番号が入る。
#   例: `## §3. 予約・チェックイン・宿泊管理（§5.2, §5.6.9, §5.8.5）`
# 見出し先頭の `§3.` は WBS 自身の節番号であって正本の節ではないため、
# 括弧の中だけを対象にする（先頭を拾うと誤った根拠を Issue に書いてしまう）。
PAREN_RE = re.compile(r"[（(]([^）)]*)[）)]")


def strip_markup(cell: str) -> str:
    """セル内の装飾（太字・取り消し線・★・バッククォート）を落として素の文字列にする。"""
    text = cell.strip()
    text = text.replace("~~", "").replace("**", "").replace("`", "")
    text = text.replace("★", "").replace("*", "")
    return text.strip()


def split_row(line: str) -> list[str]:
    """Markdown のテーブル行を列のリストへ分解する。"""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    """`| --- | ---: |` のような区切り行か。"""
    cells = split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


def parse_wbs(path: Path, package_id: str) -> dict | None:
    """WBS から指定 ID の作業パッケージ行を探し、列名→値の辞書で返す。

    表ごとに列構成が違う（§0 は4列、§17 は7列、実装領域は9列）ため、
    直前のヘッダ行から列名を取得して zip する。列位置の決め打ちはしない。
    """
    lines = path.read_text(encoding="utf-8").splitlines()

    section = ""          # 直近の `## ` 見出し（機能領域名）
    headers: list[str] = []
    prev_line = ""

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("## "):
            section = stripped.lstrip("# ").strip()
            headers = []

        elif stripped.startswith("|") and is_separator(stripped):
            # 区切り行の1つ前がヘッダ行
            if prev_line.strip().startswith("|"):
                headers = [strip_markup(c) for c in split_row(prev_line)]

        elif stripped.startswith("|") and headers:
            cells = split_row(stripped)
            if not cells:
                prev_line = line
                continue

            raw_id = cells[0]
            if strip_markup(raw_id).lower() == package_id.lower():
                row = dict(zip(headers, cells))
                row["_section"] = section
                row["_raw_id"] = raw_id
                return row

        prev_line = line

    return None


def pick(row: dict, *names: str, default: str = "") -> str:
    """列名の揺れ（`#` / `作業パッケージ` など）を吸収して値を取る。"""
    for name in names:
        if name in row and row[name].strip():
            return row[name].strip()
    return default


def extract_spec_refs(*texts: str) -> list[str]:
    """与えられた文字列群から正本への参照（§番号）を、出現順・重複なしで拾う。"""
    found: list[str] = []
    for text in texts:
        for match in SECTION_RE.findall(text):
            normalized = re.sub(r"\s+", " ", match).strip()
            if normalized not in found:
                found.append(normalized)
    return found


def section_spec_refs(section_title: str) -> list[str]:
    """機能領域の見出しから、正本の節番号だけを拾う。

    見出しは `## §3. 予約・チェックイン・宿泊管理（§5.2, §5.6.9, §5.8.5）` の形。
    先頭の `§3.` は WBS 自身の節番号なので拾わず、括弧内だけを対象にする。
    """
    return extract_spec_refs(*PAREN_RE.findall(section_title))


def build_issue(package_id: str, row: dict) -> dict:
    name = strip_markup(pick(row, "作業パッケージ"))
    summary = pick(row, "概要")
    depends = pick(row, "依存", default="—")
    size = strip_markup(pick(row, "規模", default="未設定"))
    status = pick(row, "ステータス", "完成度", default="")
    design_pct = pick(row, "設計", default="—")
    impl_pct = pick(row, "実装", default="—")
    section = row.get("_section", "")

    retired = any(m in row["_raw_id"] for m in ("~~",)) or any(
        m in status for m in RETIRED_MARKERS
    )
    blocked = any(m in status for m in BLOCKED_MARKERS)

    # 行に書かれた節番号を優先し、無ければ機能領域の見出しにある節番号へ落とす。
    # 見出し由来は「その領域が依拠する節」であって作業パッケージ固有ではないため、
    # 由来を Issue 上で区別できるように印を付ける。
    row_refs = extract_spec_refs(summary, status)
    if row_refs:
        spec_ref_text = " / ".join(f"v13 {r}" for r in row_refs)
    else:
        heading_refs = section_spec_refs(section)
        spec_ref_text = (
            " / ".join(f"v13 {r}" for r in heading_refs) + "（機能領域の見出し由来。要確認）"
            if heading_refs
            else ""
        )

    # 起票可能かの3条件（設計 §10.1.3）のうち、機械が判定できるのは1と2だけ。
    # 3（完了条件が検証可能）は WBS に情報が無いため、必ずオーナーが埋める。
    reasons: list[str] = []
    if retired:
        reasons.append("この作業パッケージは廃止・不要化・Phase 2 移送済みです")
    if blocked:
        reasons.append(f"WBS のステータスがブロック中です: {status}")
    if not spec_ref_text:
        reasons.append("概要・ステータスから正本 v13 の節番号を抽出できませんでした")

    body = f"""> [!note] この Issue は `WBS_Phase1.md` から自動生成されました
> 生成元: **{package_id}**（{section}）／ 生成ワークフロー: `wbs-to-issue.yml`
> 転記のみを行っており、仕様判断はしていません（設計 §0・§10.1.5 導線1）。

## 目的

{summary if summary else name}

（WBS 作業パッケージ **{package_id} {name}**）

## 根拠となる仕様

{spec_ref_text if spec_ref_text else "⚠️ **WBS から抽出できませんでした。正本 v13 の節番号を手で記入してください。**"}

## 完了条件

<!-- ⚠️ ここは自動で埋まりません。オーナーが記入してください。 -->
<!-- WBS には検証可能な完了条件が書かれていないため、機械が考案すると -->
<!-- 「起票の場で仕様を考える」ことになり、ゲート1が機能しなくなります（設計 §10.1.3）。 -->

- [ ] 〔「〜が〜できる」の形で、検証可能に書く〕

## スコープ外

<!-- ⚠️ ここも自動で埋まりません。書かないとエージェントが作業範囲を広げます。 -->

- 〔今回やらないことを明示する〕

## 想定サイズ

{size}

---

## WBS の記録（参考・{package_id}）

| 項目 | 値 |
| --- | --- |
| 機能領域 | {section} |
| 依存 | {depends} |
| 規模 | {size} |
| 設計進捗 | {design_pct} |
| 実装進捗 | {impl_pct} |
| ステータス | {status} |

## 起票前チェック（設計 §10.1.3）

`auto` ラベルは、次の3条件を**すべて**満たしてから手で付けてください。

- [{"x" if spec_ref_text else " "}] **節番号が引ける** — {"自動判定: OK" if spec_ref_text else "⚠️ 自動判定: 抽出できず"}
- [{" " if blocked else "x"}] **ブロッカーが解けている** — {"⚠️ 自動判定: ブロック中" if blocked else "自動判定: WBS 上はブロックなし"}
- [ ] **完了条件が検証可能** — ⚠️ **自動判定できません。上の「完了条件」を埋めてから判断してください**

> 3つ目が未チェックのまま `auto` を付けると、PM エージェントが完了条件を自分で解釈します。
> それはゲート1（オーナーの意図との照合）が空回りする状態です。
"""

    labels: list[str] = []
    if blocked or not spec_ref_text:
        labels.append("needs-spec")

    return {
        "title": f"[auto] WBS {package_id} {name}",
        "body": body,
        "labels": labels,
        "blocked": blocked,
        "retired": retired,
        "spec_ref": spec_ref_text,
        "reason": " / ".join(reasons),
    }


def main() -> int:
    # Windows の既定コンソールは cp932 で、絵文字・§ を含む出力が
    # UnicodeEncodeError になる。CI(Linux) では不要だが、
    # 手元で動作確認できないとワークフローの検証ができないため明示的に固定する。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", help="作業パッケージ番号（例: 1-2 / 3-5b / 0-1）")
    parser.add_argument("--wbs", default=DEFAULT_WBS, help=f"WBS のパス（既定: {DEFAULT_WBS}）")
    args = parser.parse_args()

    wbs_path = Path(args.wbs)
    if not wbs_path.is_file():
        print(f"WBS が見つかりません: {wbs_path}", file=sys.stderr)
        return 2

    row = parse_wbs(wbs_path, args.package)
    if row is None:
        print(
            f"作業パッケージ '{args.package}' が {wbs_path} に見つかりません。\n"
            f"ID は WBS の表の1列目と完全一致させてください（例: 1-2 / 3-5b / 0-1 / 14-6）。",
            file=sys.stderr,
        )
        return 3

    print(json.dumps(build_issue(args.package, row), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
