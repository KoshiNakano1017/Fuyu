"""導線4・導線5（設計 §10.1.5）の再発検査。実物の WBS に対して実行する。

`wbs_to_issue.py --selftest` と同じ思想で、**WBS 側の編集で静かに壊れる**ものを拾う。
ここで守っているのは次の6点である。

1. **総合% の算術** — 総合 ＝ 設計 × 0.4 ＋ 実装 × 0.6（WBS L95）。
   既存行と計算が一致しなくなったら、重みが変わったか列がずれている。
2. **依存列の取り消し線** — `~~1-4~~ **なし**` を `1-4` と読むと依存順が狂う。
3. **廃止・ブロック判定の範囲** — 散文に出てくる「不要化」で誤判定しない
   （2026-09-13 に `4-1` が起票不能だった不具合の再発検査）。
4. **ガードの拒否条件** — 対象外の行・対象外の列・行の増減を確実に弾く。
5. **機能領域の振り分け** — `4` が作業パッケージ表以外へ着弾しない（導線4）。
6. **出典名の抽出** — 装飾に壊されない（2026-09-14 の不具合の再発検査）。

5 と 6 はいずれも「**間違った結果が正しい顔で通る**」型の不具合だった。
5 は空の Issue が作れ、6 は v13 に実在する別の節が根拠として載る。
存在しない節なら `spec_ref.py` が止めるが、存在する節は止まらない。
"""

from __future__ import annotations

import re, sys
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
        ("12-4", False, True, "ブロック中が廃止に倒れている"),
        ("13-2", True, False, "取り消し線つき ID の廃止を見落としている"),
    ]:
        package = packages.get(normalize_id(package_id))
        if package is None:
            failures.append(f"{package_id} が WBS に見つかりません（検査を更新してください）")
            continue
        check(package.is_dropped is want_dropped, f"{package_id}: is_dropped={package.is_dropped} — {note}")
        check(package.is_blocked is want_blocked, f"{package_id}: is_blocked={package.is_blocked} — {note}")

    # ── 3b. 取り消し線で撤回された宣言を拾わないこと（2026-09-15 の不具合）──
    #   WBS は改訂の経緯を `~~旧~~ → **新**` で残す（CLAUDE.md §2.4）。
    #   `🟢 ~~ブロック中~~ → **2026-09-05 ブロック解除**：…` を「ブロック中」と読むと、
    #   **解除済みの作業パッケージが払い出し対象から外れる**。
    #   実害: 2-2・2-4・8-1・10-1 の4件。とくに 2-2（RLS ポリシー設計）は
    #   2-1 完了で着手可能になった要のパッケージで、ここが止まると 2-3・8-1 も開かない。
    from wbs_to_issue import BLOCKED_MARKERS, status_declaration

    for status, want, note in [
        ("🟢 ~~ブロック中~~ → **2026-09-05 ブロック解除**：A案で確定。", False, "撤回済みの宣言を拾っている"),
        ("🔴 **ブロック中**：非同期ジョブ実行基盤が未決。", True, "現行のブロック宣言を見落としている"),
    ]:
        got = any(m in status_declaration(status) for m in BLOCKED_MARKERS)
        check(got is want, f"ブロック判定が誤っています: {status[:28]!r} → {got} — {note}")

    # ⚠️ ここは**実データ（WBS の現物）を固定値で検査している**ため、
    # プロジェクトの進行でブロックが解除されると検査が落ちる。
    # 2026-09-19: 1-5・4-2 のブロック（非同期ジョブ実行基盤）が §16-1 のとおり
    # 2026-09-10 に解決していたのにステータス欄が追随しておらず、
    # それを直したらこの検査が落ちた。**検査が落ちたのは正しい挙動**である
    # （現物が変わったのだから）。ブロック解除のたびに、
    # そのとき実際にブロック中の行へ差し替えること。
    # パーサの挙動そのものは、上のリテラル文字列の検査が受け持っている。
    # 2026-09-22: 3-9 は #55 を実装で回避（room_type を CHECK でなく accommodation_types
    # への FK にした）ため 🔴 → 🟡 へ変わり検査が落ちた。#55 自体（正本の表記不整合）は
    # 未解決のドキュメント債務として残るが、実装のブロッカーではなくなったための差し替え。
    # 3-9 の代わりに、引き続き未解決（#59）でブロック中の 12-4 を固定値に採る。
    for package_id, want_blocked in [("2-2", False), ("2-4", False), ("12-4", True), ("5-7", True)]:
        package = packages.get(normalize_id(package_id))
        if package is None:
            failures.append(f"{package_id} が WBS に見つかりません（検査を更新してください）")
            continue
        check(
            package.is_blocked is want_blocked,
            f"{package_id}: is_blocked={package.is_blocked}（期待 {want_blocked}）— 宣言部の取り消し線の扱い",
        )


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

    # ── 6. 出典名の抽出が装飾に壊されないこと（2026-09-14 の不具合の再発検査）──
    #   `` `DB物理設計.md` §6-6b `` を「出典なし＝正本 v13」と誤判定すると、
    #   **v13 に実在する別の §6（権限マトリクス）が根拠として Issue に載る**。
    #   存在しない節なら spec_ref.py が止めるが、存在する節はすり抜けるため、
    #   設計 §10.3 が「最頻の事故ポイント」と呼ぶ状態がゲート1まで温存される。
    from wbs_to_issue import extract_spec_refs

    for text, want_source in [
        ("`DB物理設計.md` §6-6b のトリガー", "DB物理設計.md"),
        ("**CLAUDE.md §6.2** のとおり", "CLAUDE.md"),
        ("会員データモデル §5.2a を参照", "会員データモデル"),
        ("`非機能要件詳細.md` §7-2", "非機能要件詳細.md"),
        ("v13 §5.10.2 に定義", "v13"),
        ("正本 §4 のスコープ", "v13"),
    ]:
        refs = extract_spec_refs(text)
        got = refs[0]["source"] if refs else "(なし)"
        check(
            got == want_source,
            f"出典の抽出が誤っています: {text!r} → {got!r}（期待 {want_source!r}）",
        )

    # 実物の WBS に対する検査。`.md` を含む語が § の直前にあるのに v13 扱いなら、
    # それは装飾か語尾リストの取りこぼしであり、偽陽性の根拠が混入する。
    from wbs_to_issue import SECTION_RE, SOURCE_BEFORE_RE, SPEC_ALIASES, strip_source_markup

    leaked = []
    for package in packages.values():
        blob = " ".join([package.get(W.COL_SUMMARY), package.status])
        for match in SECTION_RE.finditer(blob):
            before = strip_source_markup(blob[: match.start()])
            found = SOURCE_BEFORE_RE.search(before)
            source = "v13"
            if found:
                candidate = found.group("src").strip()
                if not any(alias in candidate for alias in SPEC_ALIASES):
                    source = candidate
            # **直前のトークン**が `.md` を含むのに v13 と判定されたら取りこぼし。
            # 後方30文字などの広い窓にすると、`（QUESTIONS.md 2026-09-05 起票分）。§9 #54`
            # のように「別の話として出てきた .md」まで拾って誤検知する（2-3 で踏んだ）。
            #
            # ⚠️ 既知の未対応: `` `画面設計.md` に **§2-4** `` のように助詞を挟む形は
            #    このガードでも SOURCE_BEFORE_RE でも拾えない（18-2 に実在）。
            #    助詞を許すと「CLAUDE.md に書いてある v13 §4」まで誤って出典化するため、
            #    隣接形だけを対象にしている。別途の課題として QUESTIONS.md へ起票済み。
            tail = re.split(r"[\s（(、。，／/｜|【\[]", before.rstrip())
            adjacent = tail[-1] if tail else ""
            if source == "v13" and ".md" in adjacent:
                leaked.append(f"{package.id}: …{adjacent!r} → v13 {match.group()}")
    check(not leaked, "出典を取りこぼした参照があります: " + " / ".join(leaked[:3]))

    if failures:
        print("セルフテスト失敗:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"セルフテスト通過（導線4・導線5 ／ 作業パッケージ {len(packages)} 件・総合% 検算 {checked} 行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
