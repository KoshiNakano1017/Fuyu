"""機能領域（§N）を親 Issue にし、子 Issue を1件ずつ払い出す（設計 §10.1.5 導線4）。

**このスクリプトは判断をしない。** WBS に書かれている依存とステータスから、
「次に出せる作業パッケージはどれか」を決定的に求めて JSON で返すだけである。
Issue を作るのはワークフロー、`auto` を付けるのはオーナー（設計 §10.1.5 導線4）。

なぜ一括で払い出さないか（設計 §10.1.5 導線4 の表）:
  - §10.6（実装フェーズは直列）・§10.10.3（1日に承認する上限は3 Issue）に反する
  - WBS の依存列を無視して並走し、先行が固まる前に後続を実装して手戻りになる

使い方:
    python wbs_epic.py --area 4                 # エピックの本文と次の1件を JSON で出す
    python wbs_epic.py --area 4 --next          # 次に払い出す1件だけを JSON で出す
    python wbs_epic.py --list-areas             # 機能領域ごとの着手可否を一覧する
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import wbs_lib as W
from wbs_to_issue import normalize_id, strip_markup

DEFAULT_WBS = Path("docs/spec/WBS_Phase1.md")

# 払い出し状態。`ready` 以外は子 Issue を作らない。
READY = "ready"
DONE = "done"
DROPPED = "dropped"
BLOCKED_STATUS = "blocked:status"
BLOCKED_DEPS = "blocked:deps"


def resolve_area(path: Path, query: str) -> tuple[str | None, list[str]]:
    """`4` / `§4` / `朝会録音` / 見出し全文 から機能領域の見出しを特定する。

    確定できなければ `(None, 候補一覧)` を返す。**機械が黙って近いものへ寄せない**
    （設計 §10.1.5 導線1補遺の `wbs-resolve` と同じ姿勢）。
    """
    sections = W.load_sections(path)
    titles = list(sections.keys())
    wanted = normalize_id(query)

    # ① 節番号での一致（`4` / `§4` / `0-1`）
    numeric = [t for t in titles if W.section_number(t) and normalize_id(W.section_number(t)) == wanted]
    if len(numeric) == 1:
        return numeric[0], titles

    # ② 見出し全文の一致
    exact = [t for t in titles if normalize_id(t) == wanted]
    if len(exact) == 1:
        return exact[0], titles

    # ③ 部分一致（見出しの一部を貼り付けた場合）
    if len(wanted) >= 2:
        partial = [t for t in titles if wanted in normalize_id(t)]
        if len(partial) == 1:
            return partial[0], titles

    return None, titles


def classify(package: W.Package, packages: dict[str, W.Package]) -> tuple[str, str]:
    """作業パッケージの払い出し可否を判定する。`(状態, 理由)`。"""
    if package.is_done:
        return DONE, "実装 100%"
    if package.is_dropped:
        return DROPPED, "廃止・不要化・Phase 2 送り"
    if package.is_blocked:
        return BLOCKED_STATUS, strip_markup(package.status)[:80]

    pending = []
    for dep_key in package.deps:
        dep = packages.get(dep_key)
        if dep is None:
            # WBS に無い依存は、勝手に「解決済み」とみなさない（安全側）。
            pending.append(f"{dep_key}（WBS に該当行なし）")
        elif not dep.is_done:
            pending.append(dep.id)
    if pending:
        return BLOCKED_DEPS, "未完の依存: " + " / ".join(pending)

    return READY, "依存はすべて完了・ブロック宣言なし"


def area_report(path: Path, section: str) -> list[dict]:
    packages = W.load_packages(path)
    rows = [p for p in sorted(packages.values(), key=lambda p: p.line) if p.section == section]
    report = []
    for package in rows:
        state, reason = classify(package, packages)
        report.append(
            {
                "id": package.id,
                "key": package.key,
                "name": package.name,
                "deps": package.deps,
                "design": package.design_pct,
                "impl": package.impl_pct,
                "state": state,
                "reason": reason,
                "line": package.line,
            }
        )
    return report


def pick_next(report: list[dict]) -> dict | None:
    """依存順（＝WBS の記載順）で最初の `ready` を1件だけ返す。

    **`ready` が見つかる前に `blocked` があっても飛び越さない**……のではなく、
    飛び越す。WBS の並び順は依存順とおおむね一致するが厳密ではないため、
    「先頭が詰まったら領域ごと止まる」とブロック解除待ちで何も進まなくなる。
    ただし**飛び越したことは呼び出し側へ渡す**（`skipped`）。黙って飛ばさない。
    """
    for entry in report:
        if entry["state"] == READY:
            return entry
    return None


def build_epic_body(section: str, report: list[dict], wbs_path: Path) -> str:
    number = W.section_number(section) or "?"
    lines = [
        f"<!--wbs-epic:{number}-->",
        "",
        f"**機能領域**: {strip_markup(section)}",
        f"**生成元**: `{wbs_path.as_posix()}` ／ 生成ワークフロー: `wbs-to-issue.yml`（設計 §10.1.5 導線4）",
        "",
        "## 配下の作業パッケージ（WBS の記載順）",
        "",
        "子 Issue は**1件ずつ**払い出されます（同時在庫1件）。",
        "先行が `auto:done` になると次が自動で起票されます（設計 §10.1.5 導線4）。",
        "",
        "| | # | 作業パッケージ | 依存 | 状態 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for entry in report:
        mark = {
            DONE: "[x]",
            READY: "[ ]",
            DROPPED: "~~-~~",
            BLOCKED_STATUS: "[ ]",
            BLOCKED_DEPS: "[ ]",
        }.get(entry["state"], "[ ]")
        state_label = {
            READY: "🟢 払い出し可",
            DONE: "✅ 完了",
            DROPPED: "⛔ 対象外",
            BLOCKED_STATUS: "🔴 ブロック中",
            BLOCKED_DEPS: "⏳ 依存待ち",
        }.get(entry["state"], entry["state"])
        deps = ", ".join(entry["deps"]) if entry["deps"] else "なし"
        reason = entry["reason"].replace("|", "\\|")
        lines.append(
            f"| {mark} | `{entry['id']}` | {entry['name'].replace('|', chr(92) + '|')} "
            f"| {deps} | {state_label}<br><sub>{reason}</sub> |"
        )

    lines += [
        "",
        "## オーナーの操作",
        "",
        "1. 払い出された子 Issue の起草（完了条件・スコープ外）を読む",
        "2. `⚠️ 要オーナー確認` があれば **A/B/C を1文字コメント**",
        "3. **`auto` ラベルを付ける** ← これが承認",
        "",
        "> [!note] この親 Issue には `auto` を付けないでください",
        "> エピックは実装対象ではありません。`auto:epic` のまま置いておきます。",
        "",
        "> [!warning] 払い出しが止まる条件（設計 §10.1.5 導線4）",
        "> - 子が `auto:blocked` / `auto:rejected` になった",
        "> - 次の作業パッケージの依存が未完（別領域の依存を勝手に起票しません）",
        "> - この親 Issue を閉じた",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="機能領域 → エピック／次の子 Issue を決める")
    parser.add_argument("--area", help="機能領域（例: 4 / §4 / 朝会録音）")
    parser.add_argument("--wbs", type=Path, default=DEFAULT_WBS)
    parser.add_argument("--next", action="store_true", help="次に払い出す1件だけを出す")
    parser.add_argument("--list-areas", action="store_true", help="機能領域ごとの着手可否を一覧する")
    args = parser.parse_args()

    if not args.wbs.exists():
        print(f"WBS が見つかりません: {args.wbs}", file=sys.stderr)
        return 2

    if args.list_areas:
        summary = []
        for section in W.load_sections(args.wbs):
            report = area_report(args.wbs, section)
            if not report:
                continue
            counts: dict[str, int] = {}
            for entry in report:
                counts[entry["state"]] = counts.get(entry["state"], 0) + 1
            nxt = pick_next(report)
            summary.append(
                {
                    "section": strip_markup(section),
                    "number": W.section_number(section),
                    "packages": len(report),
                    "counts": counts,
                    "next": nxt["id"] if nxt else None,
                }
            )
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    if not args.area:
        parser.error("--area か --list-areas のどちらかが要ります")

    section, candidates = resolve_area(args.wbs, args.area)
    if section is None:
        print(
            json.dumps(
                {
                    "error": "機能領域を特定できません",
                    "input": args.area,
                    "candidates": [strip_markup(t) for t in candidates],
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 3

    report = area_report(args.wbs, section)
    nxt = pick_next(report)
    skipped = [e["id"] for e in report if nxt and e["line"] < nxt["line"] and e["state"] in (BLOCKED_STATUS, BLOCKED_DEPS)]

    result = {
        "section": strip_markup(section),
        "section_number": W.section_number(section),
        "packages": report,
        "next": nxt,
        "skipped": skipped,
        "epic_title": f"[epic] §{W.section_number(section)} {strip_markup(section).split('.', 1)[-1].strip()}",
        "epic_body": build_epic_body(section, report, args.wbs),
    }
    if args.next:
        result = {"next": nxt, "skipped": skipped, "section": result["section"]}

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
