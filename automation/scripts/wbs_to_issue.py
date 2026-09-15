#!/usr/bin/env python3
"""WBS_Phase1.md の作業パッケージを Issue 本文へ変換する（設計 §10.1.5 導線1）。

このスクリプトは **転記しかしない**。仕様判断・優先順位づけ・完了条件の考案は行わない
（設計 §0：仕様判断はオーナーの専権事項）。

自動で埋まるのは Issue テンプレート5項目のうち3つ（目的・根拠となる仕様・想定サイズ）だけで、
**完了条件とスコープ外は意図的に空欄のまま**にする。WBS には検証可能な完了条件が
書かれていないため、ここを機械が埋めると「起票の場で仕様を考える」ことになり、
翌朝のゲート1が機能しなくなる（設計 §10.1.3 の警告）。

── 2026-09-13 改訂：入力が正しいのに起票できない不具合3件を修正した ──────
いずれも「ID が完全一致していない」ように見えるが、原因はすべてパーサ側にあった。

  ① 区切り行の判定が `-{3,}`（ダッシュ3本以上）を要求していた。WBS には `--:`
     （2本＋コロン＝右寄せ）のセルがあり、Markdown 仕様では合法なのに区切り行と
     認識されず、**ヘッダが確定できずに表ごと消えていた**。消えていたのは
     `§0-1. 最優先パッケージ` と `§2. 認証・アカウント基盤` の2表で、`2-1`〜`2-6`
     は「見つかりません」で起票不能だった。→ `is_separator` を仕様どおり1本以上に。

  ② 最初に一致した行を返していた。冒頭の §S-2 サマリー表は列構成が違う
     （`# / パッケージ / 実装 / 実体と残り`）ため `作業パッケージ`・`概要`・
     `ステータス` が1つも取れず、**タイトルが空・§番号ゼロ・needs-spec** になった。
     影響は 0-1 / 1-1 / 1-2 / 1-3 / 7-1（サマリー表の5行）。
     → 一致行を全部集め、**作業パッケージ列を持つ表を優先**して選ぶ（`table_score`）。

  ③ `CLAUDE.md §4.4` のような**他ドキュメントの節番号を v13 のものとして**出力していた。
     v13 に §4.4 は実在せず `spec_ref.py` が解決に失敗する（exit 3）。設計 §10.3 が
     「最頻の事故ポイント」と呼ぶ誤帰属そのもの。→ 出典を保持し、**v13 由来だけ**を
     `spec_ref`（auto ゲートの判定材料）に使う。他は参考として本文に併記する。

あわせて、コピペに混ざる表記ゆれ（全角数字・ハイフン異体字・`**0-1**`・`§`・空白）を
正規化して突き合わせる。それでも見つからなければ候補を JSON で返し、`wbs-resolve`
エージェントが確定する（設計 §10.1.5 導線1補遺 ／ 2026-09-13 オーナー決定）。

使い方:
    python3 automation/scripts/wbs_to_issue.py 3-5b
    python3 automation/scripts/wbs_to_issue.py 3-5b --wbs docs/spec/WBS_Phase1.md
    python3 automation/scripts/wbs_to_issue.py --list

出力: 標準出力へ JSON
  成功 (exit 0): title / body / labels / blocked / retired / spec_ref / reason / matched
  失敗 (exit 3): ok=false / input / candidates[]   ← 候補つきで返す
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import unicodedata
from pathlib import Path

DEFAULT_WBS = "docs/spec/WBS_Phase1.md"

# ステータス欄が「実装に進めない」ことを示す記号・語。§16 のブロッカー逆引き表と対応する。
BLOCKED_MARKERS = ("🔴", "ブロック中", "⏸", "保留")
# 廃止・不要化・統合済みを示す記号。これらは起票させない。
RETIRED_MARKERS = ("➖", "不要化", "廃止", "統合済み", "移送")


# 取り消し線で消された「旧い値」。WBS は改訂の経緯を `~~旧~~ → **新**` の形で
# セル内に残す（CLAUDE.md §2.4「決定を覆すときは元の行を消さず取り消し線で上書きする」）。
# 判定の前にこれを落とさないと、**撤回済みの宣言を現行の宣言として読む**。
SUPERSEDED_RE = re.compile(r"~~.*?~~", re.DOTALL)


def strip_superseded(cell: str) -> str:
    """取り消し線で消された「旧い値」を落とす。

    `strip_markup` は `~~` という**記号だけ**を消すため、`~~1-4~~ **なし**` は
    `1-4 なし` になり、**取り消したはずの値が生き返る**。
    """
    return SUPERSEDED_RE.sub(" ", cell)


def status_head(status: str) -> str:
    """ステータス欄の**宣言部分**（最初の句点まで）を返す。

    ⚠️ 旧実装はステータス欄の**全文**に対して上のマーカーを検索していたため、
    宣言と本文の区別がつかなかった。WBS のステータス欄は
    `🟢 着手可能。<経緯や申し送りの散文>` という構造をしており、散文側には
    「〜を不要化した」「〜は廃止された」のような**別のものについての記述**が入る。

    実害（2026-09-13 に検出）:
      - `4-1`（🟢 着手可能）は散文に「録音・自動送信は**すべて不要化**した」とあるため
        `retired` と誤判定され、**起票できない**状態だった
      - `4-2`（🔴 ブロック中）も同様に `retired` へ倒れ、ブロック理由が霞んでいた

    宣言部分だけを見れば、この2件は正しく「着手可能」「ブロック中」に戻る。
    取り消し線つきの ID（`~~13-2~~`）による廃止判定は別途行うため、
    本当に廃止された行の判定は変わらない（75行中、判定が変わるのは上記2行のみ）。

    ⚠️ 2026-09-15 追記: 宣言部分に**取り消し線で消された古い宣言**が残る形
    （`🟢 ~~ブロック中~~ → **2026-09-05 ブロック解除**：…`）があり、
    句点で切るだけでは撤回済みの語を拾ってしまう。CLAUDE.md §2.4 が
    「決定を覆すときは元の行を消さず取り消し線で上書きする」と定めているため、
    この形は WBS 全体に現れる。判定前に `strip_superseded()` で取り消し線を
    落とすこと（`status_declaration()` を使う）。
    """
    return status.split("。", 1)[0] if "。" in status else status


def status_declaration(status: str) -> str:
    """ステータス欄の宣言部分から、**取り消し線で撤回された語を除いた**もの。

    廃止・ブロックの判定はこちらを使う。`status_head()` だけでは
    `🟢 ~~ブロック中~~ → **2026-09-05 ブロック解除**` を「ブロック中」と読む。

    実害（2026-09-15 に検出）: `2-2`・`2-4`・`8-1`・`10-1` の4件が、
    ステータス欄に「ブロック解除」と明記されているにもかかわらず
    `blocked` と判定され、**導線4の払い出し対象から外れていた**。
    とくに `2-2`（RLS ポリシー設計）は `2-1` 完了で着手可能になった直後の
    要のパッケージであり、ここが払い出されないと `2-3`・`8-1` も開かない。
    """
    return strip_superseded(status_head(status))

# 「v13 §5.2.3」「§5.11.7」「§9 #46」のような節番号を拾う。
SECTION_RE = re.compile(r"§\s?\d+(?:\.\d+)*[a-z]?(?:\s?#\d+)?")

# 機能領域の見出し末尾の丸括弧。ここに正本の節番号が入る。
#   例: `## §3. 予約・チェックイン・宿泊管理（§5.2, §5.6.9, §5.8.5）`
# 見出し先頭の `§3.` は WBS 自身の節番号であって正本の節ではないため、括弧の中だけを
# 対象にする（先頭を拾うと誤った根拠を Issue に書いてしまう）。
PAREN_RE = re.compile(r"[（(]([^）)]*)[）)]")

# § の直前に置かれた出典名。`（CLAUDE.md §4.4 が…）` の `CLAUDE.md` を捕まえる。
# 出典が付かない § は正本（v13）を指す、という WBS の記法に従う。
#
# ⚠️ 2026-09-14 修正（起票支援エージェントが Issue #27 の起草時に検出）
#   旧実装は装飾を剥がさずに末尾一致を見ていたため、WBS 内の8件を誤判定していた。
#     `` `DB物理設計.md` §6-6b `` … `.md` の後ろにバッククォートがあり語尾一致が外れる
#     `会員データモデル §5.2a`     … 「モデル」が語尾リストに無い
#   いずれも出典なし＝**正本 v13 として扱われる**。
#
#   実害は「存在しない節」より「存在する別の節」にある。
#   `v13 §5.2a` は実在しないので spec_ref.py が止めるが、`v13 §6`（権限マトリクス）は
#   **実在するのですり抜ける**。スキーマ設計の根拠として権限マトリクスが載り、
#   設計 §10.3 が「最頻の事故ポイント」と呼ぶ状態がそのまま Issue に固定される。
#   再発検査は wbs_selftest.py が実物の WBS に対して行う。
SOURCE_SUFFIX = r"(?:\.md|設計|仕様|規約|ガイド|モデル|定義|マニュアル)"
SOURCE_BEFORE_RE = re.compile(
    r"(?:^|[\s（(、。，／/｜|【\[])"
    r"(?P<src>[^\s（()）、。，／/｜|【】\[\]]{1,48}?" + SOURCE_SUFFIX + r")"
    r"\s*$"
)

# 出典名にかかる装飾。Markdown の強調・コード・取り消し線は文書名の一部ではない。
SOURCE_MARKUP_RE = re.compile(r"[`*~＊]+")


def strip_source_markup(text: str) -> str:
    """出典名の判定を装飾に邪魔させない。

    `` `DB物理設計.md` `` → `DB物理設計.md`、`**CLAUDE.md` → `CLAUDE.md`。
    位置は使わず出典名の照合にしか使わないため、長さが変わっても差し支えない。
    """
    return SOURCE_MARKUP_RE.sub("", text)

# 正本を指す出典表記。これらは「他ドキュメント」ではなく v13 として扱う。
SPEC_ALIASES = ("v13", "正本", "総合要件定義")

# 作業パッケージ ID の見た目。`3-5b` / `1-2` / `0-1` / `14-6`。
PACKAGE_ID_RE = re.compile(r"^\d+-\d+[a-z]?$")

# コピペで紛れ込むハイフン類。NFKC では吸収されないものがあるため明示的に潰す。
HYPHEN_VARIANTS = "‐‑‒–—―−ｰー"


def strip_markup(cell: str) -> str:
    """セル内の装飾（太字・取り消し線・★・バッククォート）を落として素の文字列にする。"""
    text = cell.strip()
    text = text.replace("~~", "").replace("**", "").replace("`", "")
    text = text.replace("★", "").replace("*", "")
    return text.strip()


def normalize_id(cell: str) -> str:
    """作業パッケージ ID を突き合わせ用の正規形にする。

    利用者は WBS からコピペするため、セルの装飾や全角文字がそのまま入力欄へ入る。
    `**0-1**` / `０-１` / `§0-1` / `#0-1` / `0‑1`(非改行ハイフン) はすべて同じものを指す。
    ここを吸収しないと、正しくコピペした人ほど「完全一致させろ」と叱られることになる。
    """
    text = unicodedata.normalize("NFKC", strip_markup(cell))
    for variant in HYPHEN_VARIANTS:
        text = text.replace(variant, "-")
    text = text.strip().lstrip("#＃").lstrip("§§").strip()
    return re.sub(r"\s+", "", text).casefold()


def split_row(line: str) -> list[str]:
    """Markdown のテーブル行を列のリストへ分解する。"""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    """`| --- | ---: | --: |` のような区切り行か。

    ⚠️ 旧実装は `:?-{3,}:?` としてダッシュ3本以上を要求していたが、Markdown（GFM）が
    求めるのは **1本以上**である。WBS の L177・L199 にある `--:` を区切り行と認めず、
    ヘッダが確定しないまま**その表の全行が存在しないもの**として扱われていた。
    """
    cells = split_row(line)
    if not cells or not all(re.fullmatch(r":?-+:?", c) for c in cells):
        return False
    # 全セルが `-` だけの本文行を区切り行と誤認しないための最低限の歯止め。
    return any("-" in c for c in cells)


def table_score(headers: list[str]) -> int:
    """その表が「作業パッケージの正規の表」らしいかを点数化する。

    WBS には同じ ID が複数の表に現れる。冒頭の §S-2 サマリー表（`# / パッケージ /
    実装 / 実体と残り`）は進捗報告用で、Issue に要る `概要`・`依存`・`ステータス` を
    持たない。**先頭一致で拾うとこちらが勝つ**ため、列構成で優劣を付ける。
    """
    weights = {"作業パッケージ": 100, "概要": 10, "ステータス": 10, "依存": 5, "規模": 5}
    return sum(weight for column, weight in weights.items() if column in headers)


def iter_rows(path: Path):
    """WBS 内の全テーブル行を `(行番号, 見出し, ヘッダ, セル)` で順に返す。

    表ごとに列構成が違う（§0 は4列、§17 は7列、実装領域は9列）ため、直前のヘッダ行から
    列名を取得する。列位置の決め打ちはしない。
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    section = ""  # 直近の `## ` 見出し（機能領域名）
    headers: list[str] = []
    prev_line = ""

    for number, line in enumerate(lines, start=1):
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
            if cells:
                yield number, section, headers, cells

        prev_line = line


def parse_wbs(path: Path, package_id: str) -> tuple[dict | None, list[dict]]:
    """指定 ID の作業パッケージ行を探し、`(採用した行, 一致した全候補)` を返す。

    同じ ID が複数の表にある場合は `table_score` の高い表＝作業パッケージ列を持つ表を
    採用する。どの表から採ったかは呼び出し側で Issue に明記する（誤採用に気づけるように）。
    """
    wanted = normalize_id(package_id)
    matches: list[dict] = []

    for number, section, headers, cells in iter_rows(path):
        if normalize_id(cells[0]) != wanted:
            continue
        row = dict(zip(headers, cells))
        row["_section"] = section
        row["_raw_id"] = cells[0]
        row["_headers"] = headers
        row["_line"] = number
        row["_score"] = table_score(headers)
        matches.append(row)

    if not matches:
        return None, []

    best = max(matches, key=lambda r: r["_score"])

    # ⚠️ 作業パッケージ表**以外**の表に同じ値の行があると、そこへ誤着弾する。
    #    WBS には §16（QUESTIONS.md ブロッカー逆引き表: `# / 反映先 / 直した内容 / 状態`）や
    #    §19（実装順序）のように、1列目が数字の表が複数ある。
    #
    #    実害（2026-09-13 に検出）: `4` を入力すると §16 の行に一致し、
    #    **「[auto] WBS 4」という中身の無い Issue が作れてしまう**状態だった。
    #    機能領域を指定したつもりの入力（設計 §10.1.5 導線4）が、
    #    エピックではなく空の作業パッケージとして通ってしまう。
    #
    #    `table_score` が 0 の表は作業パッケージ列を持たない＝そもそも対象外である。
    #    WBS 実物では「N-M 形式なのに最高スコアが 0」の ID は 0 件であり、
    #    ここで弾いても正規の作業パッケージは1件も失われない。
    if best["_score"] == 0:
        return None, matches

    return best, matches


def collect_packages(path: Path) -> list[dict]:
    """WBS 上の作業パッケージを一覧する（候補提示・`--list` 用）。"""
    packages: dict[str, dict] = {}
    for number, section, headers, cells in iter_rows(path):
        key = normalize_id(cells[0])
        if not PACKAGE_ID_RE.match(key):
            continue
        row = dict(zip(headers, cells))
        entry = {
            "id": strip_markup(cells[0]),
            "key": key,
            "name": strip_markup(row.get("作業パッケージ", "")),
            "section": section,
            "line": number,
            "score": table_score(headers),
        }
        # 同じ ID が複数表にあるときは、正規の表（点数の高い方）を代表にする。
        if key not in packages or entry["score"] > packages[key]["score"]:
            packages[key] = entry
    return sorted(packages.values(), key=lambda e: e["line"])


def suggest_candidates(path: Path, package_id: str, limit: int = 6) -> list[dict]:
    """入力に近い作業パッケージを推測して並べる。

    ここでは **確定させない**。どれを採用するかは `wbs-resolve` エージェント
    （最終的にはオーナー）が決める。機械が黙って近いものへ寄せると、意図と違う
    パッケージを起票しても誰も気づけない。
    """
    wanted = normalize_id(package_id)
    scored: list[tuple[float, str, dict]] = []

    for entry in collect_packages(path):
        key, name = entry["key"], entry["name"]
        ratio = difflib.SequenceMatcher(None, wanted, key).ratio()

        if key.startswith(wanted) or wanted.startswith(key):
            # `3-5` と入力して `3-5a` / `3-5b` がある場合など
            scored.append((0.95, "ID の前方一致（枝番違いの可能性）", entry))
        elif wanted and wanted in normalize_id(name):
            scored.append((0.90, "パッケージ名に入力文字列が含まれる", entry))
        elif ratio >= 0.6:
            scored.append((ratio, f"ID が似ている（類似度 {ratio:.2f}）", entry))

    scored.sort(key=lambda t: t[0], reverse=True)
    return [
        {
            "id": entry["id"],
            "name": entry["name"],
            "section": entry["section"],
            "line": entry["line"],
            "why": why,
            "confidence": round(score, 3),
        }
        for score, why, entry in scored[:limit]
    ]


def pick(row: dict, *names: str, default: str = "") -> str:
    """列名の揺れ（`#` / `作業パッケージ` など）を吸収して値を取る。"""
    for name in names:
        if name in row and row[name].strip():
            return row[name].strip()
    return default


def extract_spec_refs(*texts: str) -> list[dict]:
    """節番号を **出典つき**で、出現順・重複なしに拾う。

    ⚠️ 旧実装は拾った節番号をすべて `v13 §…` として出力していた。WBS には
    `CLAUDE.md §4.4` のように**他ドキュメントの節**を指す記述があり、これを v13 の節と
    して書くと実在しない節番号が「根拠となる仕様」に載る。`spec_ref.py` は解決に失敗し、
    起票支援エージェントは起草を諦める。設計 §10.3 の「最頻の事故ポイント」そのものなので、
    出典を捨てずに持ち回る。
    """
    found: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for text in texts:
        if not text:
            continue
        for match in SECTION_RE.finditer(text):
            ref = re.sub(r"\s+", " ", match.group()).strip()

            source = "v13"
            # 装飾を剥がしてから出典名を探す（strip_source_markup の docstring を参照）。
            before = SOURCE_BEFORE_RE.search(strip_source_markup(text[: match.start()]))
            if before:
                candidate = before.group("src").strip()
                if not any(alias in candidate for alias in SPEC_ALIASES):
                    source = candidate

            if (source, ref) not in seen:
                seen.add((source, ref))
                found.append({"source": source, "ref": ref})
    return found


def section_spec_refs(section_title: str) -> list[dict]:
    """機能領域の見出しの括弧内から、正本の節番号を拾う。

    見出しは `## §3. 予約・チェックイン・宿泊管理（§5.2, §5.6.9, §5.8.5）` の形。
    先頭の `§3.` は WBS 自身の節番号なので拾わない。
    """
    return extract_spec_refs(*PAREN_RE.findall(section_title))


def format_refs(refs: list[dict]) -> str:
    """`v13 §9 #51 / CLAUDE.md §4.4` の形に整える（出典を必ず前置する）。"""
    return " / ".join(f"{r['source']} {r['ref']}" for r in refs)


def resolve_refs(summary: str, status: str, section: str) -> tuple[str, list[dict], str]:
    """Issue に載せる節番号を決める。

    行に書かれた節番号を優先し、無ければ機能領域の見出しにある節番号へ落とす。
    見出し由来は「その領域が依拠する節」であって作業パッケージ固有ではないため、
    由来を Issue 上で区別できるように印を付ける。

    ⚠️ 見出しへ落とす判定は「行に **v13 の** 節が無いか」で行う。「行に節が1つも無いか」で
    判定すると、`CLAUDE.md §7.1` しか書かれていない行（10-1 など）が
    「節はある」と見なされて見出し由来の `§5.8` を取り逃がす。
    """
    row_refs = extract_spec_refs(summary, status)
    spec_refs = [r for r in row_refs if r["source"] == "v13"]
    other_refs = [r for r in row_refs if r["source"] != "v13"]

    # auto ゲートが見るのは「正本 v13 の節が引けたか」。他ドキュメントの節は参考として
    # 本文に載せるが、ゲートの判定材料にはしない（spec_ref.py が解決できないため）。
    from_heading = False
    if not spec_refs:
        spec_refs = [r for r in section_spec_refs(section) if r["source"] == "v13"]
        from_heading = bool(spec_refs)

    spec_ref_text = format_refs(spec_refs)
    if spec_ref_text and from_heading:
        spec_ref_text += "（機能領域の見出し由来。要確認）"
    return spec_ref_text, other_refs, format_refs(other_refs)


def build_issue(package_id: str, row: dict, matches: list[dict]) -> dict:
    # 表示は **WBS 上の正規の ID** を使う。利用者の入力（`**2-1**` など）をそのまま
    # 出すと、タイトルが `[auto] WBS **2-1** …` になり Markdown が二重に崩れる。
    # 入力の揺れを吸収するのが normalize_id の役目であって、揺れを Issue へ持ち込まない。
    display_id = strip_markup(row["_raw_id"]) or package_id
    name = strip_markup(pick(row, "作業パッケージ"))
    summary = pick(row, "概要")
    depends = pick(row, "依存", default="—")
    size = strip_markup(pick(row, "規模", default="未設定"))
    status = pick(row, "ステータス", "完成度", default="")
    design_pct = pick(row, "設計", default="—")
    impl_pct = pick(row, "実装", default="—")
    section = row.get("_section", "")

    # マーカーは**宣言部分だけ**に対して探す（理由は status_head の docstring）。
    declaration = status_declaration(status)
    retired = "~~" in row["_raw_id"] or any(m in declaration for m in RETIRED_MARKERS)
    blocked = any(m in declaration for m in BLOCKED_MARKERS)
    spec_ref_text, other_refs, other_refs_text = resolve_refs(summary, status, section)

    # 起票可能かの3条件（設計 §10.1.3）のうち、機械が判定できるのは1と2だけ。
    # 3（完了条件が検証可能）は WBS に情報が無いため、必ずオーナーが埋める。
    reasons: list[str] = []
    if retired:
        reasons.append("この作業パッケージは廃止・不要化・Phase 2 移送済みです")
    if blocked:
        reasons.append(f"WBS のステータスがブロック中です: {status}")
    if not spec_ref_text:
        if other_refs:
            reasons.append(
                f"正本 v13 の節番号がありません（他ドキュメントの参照のみ: {other_refs_text}）"
            )
        else:
            reasons.append("概要・ステータスから正本 v13 の節番号を抽出できませんでした")

    spec_block = spec_ref_text or (
        "⚠️ **WBS から抽出できませんでした。正本 v13 の節番号を手で記入してください。**"
    )
    if other_refs:
        spec_block += (
            "\n\n> [!note] 他ドキュメントへの参照（v13 の節ではないため上の判定には使っていません）\n"
            + "\n".join(f"> - `{r['source']} {r['ref']}`" for r in other_refs)
        )

    # 機械可読マーカー。導線5（§10.1.5）がマージ後にどの作業パッケージの進捗を
    # 更新すべきかを、この1行から決める。人間可読の「生成元」行を正規表現で読むと、
    # 装飾（`**4-1**`）や取り消し線で簡単に破綻するため、別に置く。
    body = f"""<!--wbs:{display_id}-->
> [!note] この Issue は `WBS_Phase1.md` から自動生成されました
> 生成元: **{display_id}**（{section} ／ L{row["_line"]}）／ 生成ワークフロー: `wbs-to-issue.yml`
> 転記のみを行っており、仕様判断はしていません（設計 §0・§10.1.5 導線1）。

## 目的

{summary if summary else name}

（WBS 作業パッケージ **{display_id} {name}**）

## 根拠となる仕様

{spec_block}

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

## WBS の記録（参考・{display_id}）

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

    return {
        "title": f"[auto] WBS {display_id} {name}".strip(),
        "body": body,
        "labels": ["needs-spec"] if (blocked or not spec_ref_text) else [],
        "blocked": blocked,
        "retired": retired,
        "spec_ref": spec_ref_text,
        "other_refs": other_refs_text,
        "reason": " / ".join(reasons),
        "matched": {
            "id": strip_markup(row["_raw_id"]),
            "section": section,
            "line": row["_line"],
            "columns": row["_headers"],
            "other_tables": [m["_line"] for m in matches if m["_line"] != row["_line"]],
        },
    }


def selftest(wbs_path: Path) -> int:
    """2026-09-13 に踏んだ不具合が戻っていないかを、実物の WBS に対して検査する。

    ここで固定するのは「過去に実際に壊れた振る舞い」だけである。CI から呼ばれ、
    WBS の編集（表の追加・列名の変更）で静かに壊れたときに気づけるようにする。
    """
    failures: list[str] = []

    def check(label: str, ok: bool, detail: str = "") -> None:
        if not ok:
            failures.append(f"{label}{f': {detail}' if detail else ''}")

    packages = collect_packages(wbs_path)
    check("作業パッケージを1件も読めていない", len(packages) >= 60, f"{len(packages)}件")

    # ① 区切り行 `--:` で消えていた2表が読めること
    for pid in ("0-1", "2-1", "2-6"):
        row, _ = parse_wbs(wbs_path, pid)
        check(f"①{pid} が見つからない（区切り行の判定漏れの再発）", row is not None)

    # ② サマリー表ではなく作業パッケージの表が採用されること
    for pid in ("0-1", "1-1", "1-2", "1-3", "7-1"):
        row, matches = parse_wbs(wbs_path, pid)
        if row is None:
            check(f"②{pid} が見つからない", False)
            continue
        issue = build_issue(pid, row, matches)
        name = issue["title"].removeprefix(f"[auto] WBS {pid}").strip()
        check(f"②{pid} のタイトルにパッケージ名が無い（サマリー表を拾っている）", bool(name))
        check(f"②{pid} が作業パッケージ列を持たない表から作られている",
              "作業パッケージ" in row["_headers"])

    # ③ 他ドキュメントの節を v13 として出力しないこと
    for pid in ("1-3", "10-1", "8-3"):
        row, matches = parse_wbs(wbs_path, pid)
        if row is None:
            continue
        issue = build_issue(pid, row, matches)
        for ref in issue["spec_ref"].split(" / "):
            check(f"③{pid} の spec_ref に v13 以外の出典が混ざっている",
                  not ref or ref.startswith("v13"), ref)

    # 表記ゆれの吸収と、表示は正規の ID であること
    for raw, want in (("**0-1**", "0-1"), ("０-１", "0-1"), ("§0-1", "0-1"), (" 2-1 ", "2-1")):
        row, matches = parse_wbs(wbs_path, raw)
        if row is None:
            check(f"表記ゆれ '{raw}' を吸収できていない", False)
            continue
        title = build_issue(raw, row, matches)["title"]
        check(f"'{raw}' のタイトルが正規の ID になっていない", title.startswith(f"[auto] WBS {want} "), title)

    if failures:
        print("セルフテスト失敗:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 3
    print(f"セルフテスト通過（作業パッケージ {len(packages)} 件）")
    return 0


def main() -> int:
    # Windows の既定コンソールは cp932 で、絵文字・§ を含む出力が UnicodeEncodeError に
    # なる。CI(Linux) では不要だが、手元で動作確認できないとワークフローの検証ができない
    # ため明示的に固定する。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="WBS の作業パッケージを Issue 本文へ変換する")
    parser.add_argument("package", nargs="?", help="作業パッケージ番号（例: 1-2 / 3-5b / 0-1）")
    parser.add_argument("--wbs", default=DEFAULT_WBS, help=f"WBS のパス（既定: {DEFAULT_WBS}）")
    parser.add_argument(
        "--list",
        action="store_true",
        dest="as_list",
        help="WBS 上の作業パッケージを一覧して終わる",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="過去の不具合が再発していないかを実物の WBS で検査する（CI 用）",
    )
    args = parser.parse_args()

    wbs_path = Path(args.wbs)
    if not wbs_path.is_file():
        print(f"WBS が見つかりません: {wbs_path}", file=sys.stderr)
        return 2

    if args.selftest:
        return selftest(wbs_path)

    if args.as_list:
        payload = {"ok": True, "packages": collect_packages(wbs_path)}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if not args.package:
        print("作業パッケージ番号を指定してください（または --list）", file=sys.stderr)
        return 2

    row, matches = parse_wbs(wbs_path, args.package)
    if row is None:
        # 候補は **標準出力へ JSON で**返す。wbs-resolve エージェントがこれを読んで確定する。
        candidates = suggest_candidates(wbs_path, args.package)
        print(
            json.dumps(
                {"ok": False, "input": args.package, "candidates": candidates},
                ensure_ascii=False,
            )
        )
        hint = f" 候補: {', '.join(c['id'] for c in candidates)}" if candidates else ""
        print(
            f"作業パッケージ '{args.package}' が {wbs_path} に見つかりません。{hint}",
            file=sys.stderr,
        )
        return 3

    print(json.dumps(build_issue(args.package, row, matches), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
