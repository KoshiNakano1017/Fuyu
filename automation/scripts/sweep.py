#!/usr/bin/env python3
"""自律ループのスイーパー（2026-09-16 新設）。

## なぜ要るのか

旧構成のループは **すべてラベルの `labeled` イベント駆動**だった。
つまり「誰か（人間かワークフロー）がラベルを付けた瞬間」だけが前進の契機であり、
その run が死ぬと **Issue は永久に静止する**。復帰の手段はオーナーの手動操作しかない。

実測された被害（2026-09-16 時点）:

| 事象 | 実例 |
| --- | --- |
| concurrency の pending 追い出しで run が消える | Issue #9 が `auto:approved` のまま **13日間**放置 |
| 基盤エラー（session limit）で停止 | Issue #31 が仕様の質問と同じ `auto:blocked` で滞留 |
| ブロック中の子が epic を止める | `auto-04` は `auto:done` でしか起動しないため領域ごと停止 |
| 依存が解けた作業パッケージが払い出されない | **14件が ready のまま未起票** |

いずれも「オーナーの判断待ち」ではなく **仕事が黙って落ちている** 状態である。
このスクリプトは定時に起動し、落ちた仕事を拾い直し、依存が解けたものを払い出す。

## やること

1. **回収** — 遷移の途中で止まった Issue にラベルを付け直して再起動する
2. **再試行** — `auto:retry`（クレジット切れ・基盤障害）を冷却期間後に自動再開する
3. **払い出し** — 実装中の本数が上限未満なら、WBS の依存順で次の作業パッケージを起票する
4. **枯渇判定** — 着手可能な仕事が尽きたら、保留中のオーナー判断をまとめて報告する

## やらないこと

- **仕様の判断をしない。** `auto:blocked`（＝ spec 起因）には触れない。
  これはオーナーの専権事項であり（設計 §0）、スイーパーは報告するだけである。
- **ラベルの意味を変えない。** 遷移の定義は設計 §5 のままで、落ちたものを戻すだけ。
"""

from __future__ import annotations

import argparse
import json
import re
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wbs_epic as E  # noqa: E402

REPO = os.environ.get("GITHUB_REPOSITORY", "")

# ── ラベルの語彙（設計 §5）────────────────────────────────────
L_AUTO = "auto"
L_PLANNING = "auto:planning"
L_APPROVED = "auto:approved"
L_IMPLEMENTING = "auto:implementing"
L_REVIEW = "auto:review"
L_BLOCKED = "auto:blocked"  # spec 起因。オーナー判断が要る。触らない
L_RETRY = "auto:retry"  # 基盤・クレジット起因。自動再開の対象
L_WAITING_DEP = "auto:waiting-dep"  # 上流の作業パッケージ待ち
L_DONE = "auto:done"
L_REJECTED = "auto:rejected"
L_EPIC = "auto:epic"

#: 「作業中」とみなすラベル。払い出しの上限はこの本数で数える。
INFLIGHT = {L_PLANNING, L_APPROVED, L_IMPLEMENTING, L_REVIEW}

#: 停滞とみなすまでの分数。**各ジョブの timeout-minutes より必ず長くする**
#: （auto-01=60 / auto-02=90 / auto-03=90）。短いと実行中の run を二重起動する。
STALE_MINUTES = {
    L_PLANNING: 90,
    L_APPROVED: 30,  # 実装はまだ始まっていない。PR も無いので早めに拾ってよい
    L_IMPLEMENTING: 150,
    L_REVIEW: 150,
}

#: 回収時に戻す先。`auto:approved` は「付け直す」ことが引き金になる。
RECOVER_TO = {
    L_PLANNING: L_AUTO,
    L_APPROVED: L_APPROVED,
    L_IMPLEMENTING: L_APPROVED,
    L_REVIEW: L_REVIEW,
}

#: 各ラベルの再起動に対応するワークフロー。実行中なら回収を見送る（二重起動の防止）。
GUARD_WORKFLOW = {
    L_PLANNING: "auto-01-plan.yml",
    L_APPROVED: "auto-02-implement.yml",
    L_IMPLEMENTING: "auto-02-implement.yml",
    L_REVIEW: "auto-03-review-merge.yml",
}

RETRY_COOLDOWN_MIN = 60
REPORT_TITLE = "[report] 自律ループ 枯渇レポート"

#: **ループが原理的に完了できない**作業パッケージの印。
#:
#: `wbs_epic.classify()` は依存と進捗しか見ないため、「ブラウザでダッシュボードを
#: 操作する」類の作業も `ready` と判定する。実例: `1-1b`（E2E・prod の Supabase
#: プロジェクト作成）は WBS 自身が「いずれもブラウザ操作のため自律ループでは
#: 完了できない」と書いているのに ready に出る。
#:
#: これを払い出すと、エージェントは手も足も出ないまま停止し、
#: **オーナー判断待ちでない停止**が積み上がる（＝このスイーパーが潰そうとしている
#: 状態そのもの）。起票せず、枯渇レポートに「オーナーの手作業」として載せる。
OWNER_ONLY_MARKERS = (
    "自律ループでは完了できない",
    "自律ループでは実施できない",
    "オーナー作業",
    "ブラウザ操作",
)


def is_owner_only(package) -> bool:
    """行全体（概要・ステータス）に手作業の宣言があるか。"""
    row = " ".join(package.cells)
    return any(m in row for m in OWNER_ONLY_MARKERS)


def sh(args: list[str], check: bool = True) -> str:
    """`gh` などを叩いて stdout を返す。失敗は空文字（呼び出し側で判断する）。"""
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        if check:
            print(f"::warning::コマンド失敗: {' '.join(args[:4])} … {p.stderr[:200]}")
        return ""
    return p.stdout


def gh_json(args: list[str], default):
    out = sh(["gh", *args])
    if not out.strip():
        return default
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return default


def now() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def age_minutes(ts: str) -> float:
    return (now() - parse_ts(ts)).total_seconds() / 60.0


# ── 収集 ──────────────────────────────────────────────────────


def fetch_issues() -> list[dict]:
    data = gh_json(
        [
            "issue", "list", "--repo", REPO, "--state", "open", "--limit", "200",
            "--json", "number,title,labels,updatedAt,body",
        ],
        [],
    )
    for it in data:
        it["labelNames"] = {lb["name"] for lb in it.get("labels", [])}
    return data


def workflow_busy(workflow: str) -> bool:
    """対象ワークフローに実行中・待機中の run があるか。

    あるなら回収を見送る。**保守的に倒す**のは、二重起動が
    ブランチと PR を壊す（設計 §10.6 の 1 Issue = 1 ブランチ = 1 PR）ためで、
    見送っても次の定時実行で拾えるので損失は遅延だけである。
    """
    for status in ("in_progress", "queued", "waiting"):
        runs = gh_json(
            ["run", "list", "--repo", REPO, "--workflow", workflow,
             "--status", status, "--limit", "5", "--json", "databaseId"],
            [],
        )
        if runs:
            return True
    return False


def open_pr_for(issue: int) -> int | None:
    prs = gh_json(
        ["pr", "list", "--repo", REPO, "--head", f"feature/issue-{issue}",
         "--state", "open", "--json", "number"],
        [],
    )
    return prs[0]["number"] if prs else None


def retry_origin(issue: int) -> str:
    """`<!--retry:from=X-->` マーカーから、戻すべきフェーズラベルを読む。"""
    data = gh_json(["issue", "view", str(issue), "--repo", REPO, "--json", "comments"], {})
    for c in reversed(data.get("comments", [])):
        body = c.get("body", "")
        if "<!--retry:from=" in body:
            return body.split("<!--retry:from=", 1)[1].split("-->", 1)[0].strip()
    return L_AUTO


# ── 操作 ──────────────────────────────────────────────────────


def relabel(issue: int, remove: list[str], add: str, dry: bool) -> None:
    """ラベルを付け替える。

    ⚠️ **同じラベルを付け直しても `labeled` イベントは発生しない**（設計 §8.5）。
    再起動が目的のときは必ず「外してから付ける」を2回の API 呼び出しで行う。
    """
    if dry:
        print(f"    [dry-run] #{issue}: -{remove} +{add}")
        return
    for lb in remove:
        sh(["gh", "issue", "edit", str(issue), "--repo", REPO, "--remove-label", lb], check=False)
    sh(["gh", "issue", "edit", str(issue), "--repo", REPO, "--remove-label", add], check=False)
    sh(["gh", "issue", "edit", str(issue), "--repo", REPO, "--add-label", add])


def comment(issue: int, body: str, dry: bool) -> None:
    if dry:
        print(f"    [dry-run] comment on #{issue}: {body.splitlines()[0][:60]}")
        return
    p = subprocess.run(
        ["gh", "issue", "comment", str(issue), "--repo", REPO, "--body-file", "-"],
        input=body, text=True, encoding="utf-8", capture_output=True,
    )
    if p.returncode != 0:
        print(f"::warning::#{issue} へのコメントに失敗: {p.stderr[:200]}")


# ── 1. 回収 ───────────────────────────────────────────────────


def recover(issues: list[dict], dry: bool) -> list[str]:
    acted: list[str] = []
    busy_cache: dict[str, bool] = {}

    for it in issues:
        names = it["labelNames"]
        phase = next((lb for lb in (L_PLANNING, L_APPROVED, L_IMPLEMENTING, L_REVIEW) if lb in names), None)
        if phase is None:
            continue

        age = age_minutes(it["updatedAt"])
        if age < STALE_MINUTES[phase]:
            continue

        wf = GUARD_WORKFLOW[phase]
        if wf not in busy_cache:
            busy_cache[wf] = workflow_busy(wf)
        if busy_cache[wf]:
            print(f"  … #{it['number']} は {phase} で停滞中だが {wf} が実行中。見送る")
            continue

        # auto:approved は「PR がまだ無い」ことが再起動の前提。
        # PR があるなら実装は済んでおり、レビュー側へ回すべき状態である。
        if phase == L_APPROVED and open_pr_for(it["number"]):
            continue
        # auto:implementing は PR ができていれば review へ、無ければ approved へ戻す。
        target = RECOVER_TO[phase]
        if phase == L_IMPLEMENTING and open_pr_for(it["number"]):
            target = L_REVIEW

        print(f"  ↻ #{it['number']} を回収: {phase}（{age:.0f}分停滞） → {target}")
        relabel(it["number"], [phase], target, dry)
        comment(
            it["number"],
            f"## ↻ スイーパーが再開しました\n\n"
            f"`{phase}` のまま **{age:.0f}分**更新がありませんでした。実行中の "
            f"`{wf}` も無いため、run が失われたと判断して `{target}` を付け直します。\n\n"
            f"> オーナーの操作は不要です。仕様の判断が要る場合は `auto:blocked` が付きます。\n",
            dry,
        )
        acted.append(f"#{it['number']} {phase} → {target}")
    return acted


# ── 2. 再試行 ─────────────────────────────────────────────────


def retry(issues: list[dict], dry: bool) -> list[str]:
    acted: list[str] = []
    for it in issues:
        if L_RETRY not in it["labelNames"]:
            continue
        age = age_minutes(it["updatedAt"])
        if age < RETRY_COOLDOWN_MIN:
            print(f"  … #{it['number']} は冷却中（{age:.0f}/{RETRY_COOLDOWN_MIN}分）")
            continue
        target = retry_origin(it["number"])
        print(f"  ↻ #{it['number']} を再試行: {L_RETRY} → {target}")
        relabel(it["number"], [L_RETRY], target, dry)
        comment(
            it["number"],
            f"## ↻ 冷却期間が明けたため再試行します\n\n"
            f"停止から **{age:.0f}分**経過しました。`{target}` を付け直します。\n\n"
            f"> クレジット切れ・基盤障害による停止であり、仕様の判断は要りません。\n",
            dry,
        )
        acted.append(f"#{it['number']} retry → {target}")
    return acted


# ── 3. 払い出し ───────────────────────────────────────────────


def dispense(issues: list[dict], cap: int, wbs: Path, dry: bool) -> tuple[list[str], list[dict], list[dict]]:
    """WBS の依存順で、着手可能な作業パッケージを起票する。

    `wbs_epic.classify()` が依存を解決済み（`ready`）と判定したものだけを出す。
    **ブロック中のパッケージは飛び越す**が、飛ばしたことは記録される
    （`wbs_epic.pick_next` の docstring と同じ規律）。
    """
    # 払い出しの担い手は2つある。
    #   ・auto-04-epic-next.yml … 子が auto:done になった瞬間に次を出す（低遅延）
    #   ・このスイーパー          … 取りこぼしを定時に拾う（バックストップ）
    # 両方が同時に走ると **同じ作業パッケージで Issue が2本**できる。
    # `taken`（既存 Issue の <!--wbs:X--> マーカー）で重複は弾けるが、
    # auto-04 が Issue を作り終える前にこちらが読むと弾けない。
    # 起票済み一覧を読んだ後に相手が動くのが危ないので、動いている間は出さない。
    for wf in ("auto-04-epic-next.yml", "wbs-to-issue.yml"):
        if workflow_busy(wf):
            print(f"  … {wf} が実行中のため、今回は払い出さない（次の定時で拾う）")
            return [], [], []

    inflight = [it for it in issues if it["labelNames"] & INFLIGHT]
    slots = cap - len(inflight)
    print(f"  作業中 {len(inflight)}件 / 上限 {cap}件 → 空き {max(slots, 0)}")

    # 既に起票済みの作業パッケージ ID を集める。
    #
    # ⚠️ 2026-09-19: マーカーだけを見ていたため **1-4 を二重起票した**（#18 と #49）。
    # `<!--wbs:X-->` は wbs-to-issue 経由で作られた Issue にしか入っておらず、
    # それ以前に手で立てた Issue（#18）には無い。マーカーが唯一の手掛かりだと
    # 「起票済みだが印が無い」パッケージを毎回すり抜ける。
    # タイトル `[auto] WBS <id> <名前>` からも拾って二重化を塞ぐ。
    taken: set[str] = set()
    for it in issues:
        b = it.get("body") or ""
        if "<!--wbs:" in b:
            taken.add(b.split("<!--wbs:", 1)[1].split("-->", 1)[0].strip())
        m = re.match(r"\s*\[auto\]\s*WBS\s+([0-9]+-[0-9A-Za-z]+)", it.get("title") or "")
        if m:
            taken.add(m.group(1))

    # 依存は領域をまたぐ（例: §0-1 の `0-1` は §1 の `1-2` に依存する）。
    # そのため classify() へ渡す索引は **WBS 全体**でなければならない。
    # 領域ごとの索引だと、他領域の依存が「WBS に該当行なし」と誤判定され、
    # wbs_epic.classify の安全側の規律により全件が blocked:deps に落ちる。
    index = E.W.load_packages(wbs)
    sections = E.W.load_sections(wbs)

    ready: list[dict] = []
    owner_only: list[dict] = []
    for title, packages in sections.items():
        for p in packages:
            state, why = E.classify(p, index)
            if state != E.READY or p.id in taken:
                continue
            item = {"id": p.id, "section": E.strip_markup(title)[:40], "why": why}
            # 黙って飛ばさない（設計 §10.6 の「飛び越したことは呼び出し側へ渡す」と同じ規律）
            if is_owner_only(p):
                owner_only.append(item)
                continue
            ready.append(item)

    if owner_only:
        print(f"  ⚠ オーナーの手作業のため払い出さない: {', '.join(i['id'] for i in owner_only)}")

    # ── 影響度順に並べ替える（2026-09-19 追加）────────────────────
    # 旧版は WBS の記載順（＝§1 から）に払い出していた。その結果、
    # 下流19件を止めている `3-2`（チェックイン）より、下流0件の §1 の行が先に出ていた。
    # 上限に達すると最も詰まりを解く1本が翌回まわしになる。
    # 「その行が完了すると何件が着手可能になるか」の降順で出す。
    def downstream(pid: str, seen: set[str] | None = None) -> int:
        seen = seen if seen is not None else set()
        n = 0
        for k, p in index.items():
            if k in seen or pid not in p.deps:
                continue
            seen.add(k)
            n += 1 + downstream(k, seen)
        return n

    for item in ready:
        item["downstream"] = downstream(item["id"])
    ready.sort(key=lambda i: -i["downstream"])
    if ready:
        head = ", ".join(f"{i['id']}(下流{i['downstream']})" for i in ready[:5])
        print(f"  影響度順: {head}")

    acted: list[str] = []
    for item in ready[: max(slots, 0)]:
        print(f"  + 払い出し: {item['id']}（{item['section']}）")
        if dry:
            acted.append(f"{item['id']} [dry-run]")
            continue
        out = sh([
            "gh", "workflow", "run", "wbs-to-issue.yml", "--repo", REPO,
            "-f", f"package={item['id']}", "-f", "resolve=false",
            "-f", "draft=false", "-f", "start_loop=true",
        ], check=False)
        acted.append(item["id"])
        del out
    return acted, ready, owner_only


# ── 4. 枯渇レポート ───────────────────────────────────────────


def unmet_deps(issue: dict, index) -> list[str]:
    """Issue 本文の `<!--wbs:X-->` から作業パッケージを引き、未完の依存を返す。

    「オーナー判断待ち」に見えている Issue が、実は**上流の実装待ち**である
    ことがある。実例: #4 は仕様の質問として `auto:blocked` が付いているが、
    オーナーは既に回答済みで、実際に止めているのは `6-1`（セルフ注文）の未実装。
    これを報告で見分けられないと、オーナーは「自分が何か答えないと動かない」と
    誤解したまま待つことになる。
    """
    body = issue.get("body") or ""
    if "<!--wbs:" not in body:
        return []
    pid = body.split("<!--wbs:", 1)[1].split("-->", 1)[0].strip()
    pkg = index.get(pid)
    if pkg is None:
        return []
    return [d for d in pkg.deps if not (index.get(d) and index[d].is_done)]


def build_report(issues: list[dict], ready: list[dict], owner_only: list[dict],
                 acted: dict, index=None) -> str:
    blocked = [i for i in issues if L_BLOCKED in i["labelNames"]]
    waiting = [i for i in issues if L_WAITING_DEP in i["labelNames"]]
    retrying = [i for i in issues if L_RETRY in i["labelNames"]]
    inflight = [i for i in issues if i["labelNames"] & INFLIGHT]

    L = [
        "# 自律ループ 枯渇レポート",
        "",
        f"生成: {now().strftime('%Y-%m-%d %H:%M')} UTC",
        "",
        "着手可能な仕事が尽きたため、**保留していたオーナー判断をまとめて報告します。**",
        "ここに挙がっているものだけが、人の判断を必要としています。",
        "",
        "| 区分 | 件数 |",
        "| --- | ---: |",
        f"| ⛔ オーナー判断が要る（仕様が未確定） | **{len(blocked)}** |",
        f"| ⏳ 上流の作業パッケージ待ち | {len(waiting)} |",
        f"| ↻ 自動再試行の待機中 | {len(retrying)} |",
        f"| 🔄 作業中 | {len(inflight)} |",
        f"| 📦 未起票で着手可能な作業パッケージ | {len(ready)} |",
        f"| 🙋 オーナーの手作業（ループでは完了できない） | {len(owner_only)} |",
        "",
    ]

    if blocked:
        L += [
            "## ⛔ オーナーの判断が要るもの",
            "",
            "**各 Issue の最後のコメントに、選択肢（A/B/C）と推奨案が書かれています。**",
            "回答をコメントしたうえで `auto:blocked` を外し、`auto` を付け直すと再開します。",
            "",
        ]
        for i in blocked:
            pending = unmet_deps(i, index) if index else []
            if pending:
                L.append(
                    f"- #{i['number']} {i['title']}\n"
                    f"  - ⚠️ **上流が未完のため、回答しても直ちには動きません**: "
                    f"{' / '.join(pending)}"
                )
            else:
                L.append(f"- #{i['number']} {i['title']}")
        L.append("")

    if owner_only:
        L += [
            "## 🙋 オーナーの手作業（ループでは完了できません）",
            "",
            "ブラウザ操作など、エージェントが原理的に実行できない作業です。",
            "**これが残っていると下流の作業パッケージが開きません。**",
            "",
        ]
        for i in owner_only:
            L.append(f"- `{i['id']}`（{i['section']}）")
        L.append("")

    if waiting:
        L += ["## ⏳ 上流待ち（判断は不要。上流が終われば自動で動きます）", ""]
        for i in waiting:
            L.append(f"- #{i['number']} {i['title']}")
        L.append("")

    if retrying:
        L += ["## ↻ 自動再試行の待機中（操作不要）", ""]
        for i in retrying:
            L.append(f"- #{i['number']} {i['title']}")
        L.append("")

    if acted.get("recovered") or acted.get("retried") or acted.get("dispensed"):
        L += ["## 今回のスイープで動かしたもの", ""]
        for k, label in (("recovered", "回収"), ("retried", "再試行"), ("dispensed", "払い出し")):
            for x in acted.get(k, []):
                L.append(f"- {label}: {x}")
        L.append("")

    if not blocked and not ready and not inflight and not owner_only:
        L += [
            "> [!success] 保留中のオーナー判断はありません",
            "> 着手可能な作業パッケージも尽きています。次は WBS の更新か、",
            "> `QUESTIONS.md` の回答による依存の解除が必要です。",
            "",
        ]
    return "\n".join(L)


def publish_report(body: str, dry: bool) -> None:
    if dry:
        print("\n--- [dry-run] レポート本文 ---\n" + body)
        return
    found = gh_json(
        ["issue", "list", "--repo", REPO, "--state", "open", "--limit", "5",
         "--search", f'"{REPORT_TITLE}" in:title', "--json", "number,title"],
        [],
    )
    num = next((f["number"] for f in found if f["title"] == REPORT_TITLE), None)
    if num:
        comment(num, body, dry)
        print(f"  レポートを #{num} へ追記しました")
    else:
        p = subprocess.run(
            ["gh", "issue", "create", "--repo", REPO, "--title", REPORT_TITLE,
             "--body-file", "-"],
            input=body, text=True, encoding="utf-8", capture_output=True,
        )
        print(f"  レポート Issue を作成: {p.stdout.strip()[:80]}")


# ── main ──────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="自律ループのスイーパー")
    ap.add_argument("--dry-run", action="store_true", help="操作せず、何をするかだけ出す")
    ap.add_argument("--max-inflight", type=int, default=3, help="同時に走らせる Issue の上限")
    ap.add_argument("--wbs", type=Path, default=E.DEFAULT_WBS)
    ap.add_argument("--no-dispense", action="store_true", help="払い出しを行わない")
    args = ap.parse_args()

    if not REPO:
        print("GITHUB_REPOSITORY が未設定です", file=sys.stderr)
        return 1

    issues = fetch_issues()
    print(f"open Issue: {len(issues)}件")

    print("\n[1] 回収（run が失われたものを拾い直す）")
    recovered = recover(issues, args.dry_run)

    print("\n[2] 再試行（クレジット切れ・基盤障害）")
    retried = retry(issues, args.dry_run)

    dispensed: list[str] = []
    ready: list[dict] = []
    owner_only: list[dict] = []
    if not args.no_dispense:
        print("\n[3] 払い出し（WBS の依存順）")
        dispensed, ready, owner_only = dispense(issues, args.max_inflight, args.wbs, args.dry_run)

    acted = {"recovered": recovered, "retried": retried, "dispensed": dispensed}
    moved = sum(len(v) for v in acted.values())

    inflight = [i for i in issues if i["labelNames"] & INFLIGHT]

    # 「ループが終了した」＝ **これ以上ひとりでに進めるものが無い** 状態。
    # 2026-09-16 オーナー決定では契機を「着手可能な仕事が尽きた or クレジットが尽きた」と
    # したが、この2つは同じ観測に落ちる:
    #   ・仕事が尽きた       → 動かせるものが無く、作業中も無い
    #   ・クレジットが尽きた → 払い出しも再開も失敗し、全部が auto:retry へ落ちて作業中が消える
    # どちらも「今回動かせた件数が 0、かつ作業中が 0」になる。
    # ready が残っていても（＝上限やクレジットで出せなかった）報告する価値があるため、
    # ready の有無は条件に入れない。
    exhausted = moved == 0 and not inflight

    print(f"\n動かした件数: {moved} / 作業中: {len(inflight)} / 着手可能: {len(ready)}")
    if exhausted:
        print("\n[4] 着手可能な仕事が尽きました。枯渇レポートを出します")
        index = E.W.load_packages(args.wbs)
        publish_report(build_report(issues, ready, owner_only, acted, index), args.dry_run)
    else:
        print("\n[4] まだ進められる仕事があるため、レポートは出しません")

    if gh_out := os.environ.get("GITHUB_OUTPUT"):
        with open(gh_out, "a", encoding="utf-8") as fh:
            fh.write(f"moved={moved}\n")
            fh.write(f"exhausted={'true' if exhausted else 'false'}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
