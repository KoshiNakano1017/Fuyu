"""WBS_Phase1.md を読み書きするための共有ユーティリティ（設計 §10.1.5 導線4・導線5）。

`wbs_to_issue.py` が既に持っている表パーサ（`iter_rows` / `normalize_id` /
`strip_markup` / `table_score`）を**再利用する**。同じパーサを2つ持つと、
片方だけを直したときに「Issue は作れるのに進捗は更新されない」という形で食い違う。

ここに足すのは、読み取りだけでは要らなかった次の3つである。

1. **依存列の解釈** — `strip_markup` では正しく読めない（下記 `parse_deps` の注記）
2. **進捗セルの算術** — 総合 ＝ 設計 × 0.4 ＋ 実装 × 0.6（WBS_Phase1.md L95 に定義）
3. **書き込み対象の限定** — 設計 §0 が許可するのは実装 / 総合 / ステータスの3列だけ
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from wbs_to_issue import (  # 表パーサと判定マーカーは wbs_to_issue の実装をそのまま使う
    BLOCKED_MARKERS,
    PACKAGE_ID_RE,
    RETIRED_MARKERS,
    iter_rows,
    normalize_id,
    split_row,
    status_head,
    strip_markup,
    table_score,
)

# ── 列名（WBS_Phase1.md の実装領域テーブルのヘッダ） ────────────────────
COL_ID = "#"
COL_NAME = "作業パッケージ"
COL_SUMMARY = "概要"
COL_DEPS = "依存"
COL_SIZE = "規模"
COL_DESIGN = "設計"
COL_IMPL = "実装"
COL_TOTAL = "総合"
COL_STATUS = "ステータス"

#: ループが書き換えてよい列（設計 §0 の注記・§8.2 ガード②の許可集合）。
#: **設計 / 概要 / 依存 / 規模 を足してはならない。** 足すならまず設計 §0 を改訂すること。
WRITABLE_COLUMNS = (COL_IMPL, COL_TOTAL, COL_STATUS)

#: 総合の重み（WBS_Phase1.md L95「総合 ＝ 設計 × 0.4 ＋ 実装 × 0.6」）
DESIGN_WEIGHT = 0.4
IMPL_WEIGHT = 0.6

#: 「依存なし」を表す綴り。正規化後に比較する。
NO_DEPENDENCY = {"なし", "無し", "-", "—", "–", "", "n/a", "none"}

_SUPERSEDED_RE = re.compile(r"~~.*?~~", re.DOTALL)
_PCT_RE = re.compile(r"(\d{1,3})\s*%")


def _drop_leading_arrow(text: str) -> str:
    """`~~旧~~ → **新**` から旧を落としたあとに残る、先頭の改訂矢印を取る。"""
    return re.sub(r"^[\s→⇒⟶:：]+", "", text).strip()


def strip_superseded(cell: str) -> str:
    """取り消し線で消された「旧い値」を落とす。

    WBS は改訂の経緯を `~~旧~~ → **新**` の形でセル内に残している。
    `wbs_to_issue.strip_markup` は `~~` という**記号だけ**を消すため、
    `~~1-4~~ **なし**` は `1-4 なし` になり、**取り消したはずの依存が生き返る**。
    ID の突き合わせ用途では無害だったが、依存解決では順序を狂わせる。
    """
    return _SUPERSEDED_RE.sub(" ", cell)


def parse_deps(cell: str) -> list[str]:
    """依存列を作業パッケージ ID のリストにする。

    `~~1-4, 1-5, 4-1~~ **1-5, 4-1**` → `["1-5", "4-1"]`（取り消し分は捨てる）
    `~~1-4~~ **なし**`               → `[]`
    `4-2, 5-1`                        → `["4-2", "5-1"]`
    """
    text = strip_markup(strip_superseded(cell))
    if normalize_id(text) in {normalize_id(w) for w in NO_DEPENDENCY}:
        return []

    deps: list[str] = []
    for token in re.split(r"[,、／/]+", text):
        key = normalize_id(token)
        if key and PACKAGE_ID_RE.match(key) and key not in deps:
            deps.append(key)
    return deps


def parse_pct(cell: str) -> int | None:
    """`85%` / `**0%**` / `０%` → 整数。読めなければ None。"""
    text = unicodedata.normalize("NFKC", strip_markup(strip_superseded(cell)))
    match = _PCT_RE.search(text)
    return int(match.group(1)) if match else None


def format_pct(value: int) -> str:
    return f"{value}%"


def calc_total(design_pct: int, impl_pct: int) -> int:
    """総合 ＝ 設計 × 0.4 ＋ 実装 × 0.6（四捨五入）。

    既存値との突き合わせで検算できるよう、WBS の既存行と同じ丸め方にする
    （例: 設計85 / 実装0 → 34、設計60 / 実装0 → 24）。
    """
    return round(design_pct * DESIGN_WEIGHT + impl_pct * IMPL_WEIGHT)


class Package:
    """作業パッケージ1行分。`_line` は 1 始まりの行番号。"""

    def __init__(self, line: int, section: str, headers: list[str], cells: list[str]):
        self.line = line
        self.section = section
        self.headers = headers
        self.cells = cells
        self.score = table_score(headers)
        self.raw_id = cells[0]
        self.key = normalize_id(cells[0])

    def get(self, column: str, default: str = "") -> str:
        if column not in self.headers:
            return default
        index = self.headers.index(column)
        return self.cells[index] if index < len(self.cells) else default

    @property
    def id(self) -> str:
        # 取り消し線だけの ID（`~~13-2~~`）は現行値が無く空になる。表示が消えると
        # 「どの行の話か」が読めなくなるため、その場合は装飾だけ落とした値へ戻す。
        return _drop_leading_arrow(strip_markup(strip_superseded(self.raw_id))) or strip_markup(self.raw_id)

    @property
    def name(self) -> str:
        # `~~朝会録音UI~~ → **朝会テキスト投入UI**` は現行値だけを残すと
        # 先頭に矢印が取り残される。改訂の矢印は表示に要らない。
        return _drop_leading_arrow(strip_markup(strip_superseded(self.get(COL_NAME)))) or strip_markup(
            self.get(COL_NAME)
        )

    @property
    def deps(self) -> list[str]:
        return parse_deps(self.get(COL_DEPS))

    @property
    def design_pct(self) -> int | None:
        return parse_pct(self.get(COL_DESIGN))

    @property
    def impl_pct(self) -> int | None:
        return parse_pct(self.get(COL_IMPL))

    @property
    def status(self) -> str:
        return self.get(COL_STATUS)

    @property
    def is_done(self) -> bool:
        return (self.impl_pct or 0) >= 100

    @property
    def is_blocked(self) -> bool:
        """ステータス欄が明示的にブロックを宣言しているか。

        依存が未完なだけの行はここでは False（それは `deps` 側で判定する）。
        判定は**宣言部分だけ**に対して行う（`wbs_to_issue.status_head` の docstring）。
        """
        return any(m in status_head(self.status) for m in BLOCKED_MARKERS)

    @property
    def is_dropped(self) -> bool:
        """廃止・不要化・統合済みの行か（掘り起こしを防ぐ）。

        `wbs_to_issue.build_issue` の `retired` と**同じ規則**で判定する。
        ここで独自の語彙（「Phase 2」「スコープ外」など）を足すと、
        導線1 では起票できるのに導線4 では飛ばされる、という食い違いが生まれる。
        """
        return "~~" in self.raw_id or any(m in status_head(self.status) for m in RETIRED_MARKERS)

    def cells_by_column(self) -> dict[str, str]:
        return {h: (self.cells[i] if i < len(self.cells) else "") for i, h in enumerate(self.headers)}


def load_packages(path: Path) -> dict[str, Package]:
    """作業パッケージを ID → Package で返す。

    同じ ID が複数の表に現れるため、`table_score` が高い表（＝作業パッケージ列を
    持つ正規の表）の行を代表にする。`wbs_to_issue.parse_wbs` と同じ選び方である。
    """
    packages: dict[str, Package] = {}
    for number, section, headers, cells in iter_rows(path):
        if not cells:
            continue
        key = normalize_id(cells[0])
        if not PACKAGE_ID_RE.match(key):
            continue
        candidate = Package(number, section, headers, cells)
        current = packages.get(key)
        if current is None or candidate.score > current.score:
            packages[key] = candidate
    return packages


def load_sections(path: Path) -> dict[str, list[Package]]:
    """機能領域（`## §N. 見出し`）ごとに作業パッケージをまとめる（導線4 用）。"""
    sections: dict[str, list[Package]] = {}
    for package in sorted(load_packages(path).values(), key=lambda p: p.line):
        sections.setdefault(package.section, []).append(package)
    return sections


def section_number(section_title: str) -> str:
    """`## §4. 朝会録音…` → `4`。取れなければ空文字。"""
    match = re.match(r"\s*§\s*([0-9]+(?:-[0-9]+)?)", strip_markup(section_title))
    return match.group(1) if match else ""


def render_row(headers: list[str], cells_by_column: dict[str, str]) -> str:
    """列の辞書から Markdown のテーブル行を組み立てる。

    既存行と同じ `| a | b |` の体裁にする（WBS は桁揃えのパディングをしていない）。
    """
    return "| " + " | ".join(cells_by_column.get(h, "") for h in headers) + " |"


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").split("\n")


def write_lines(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines), encoding="utf-8", newline="")
