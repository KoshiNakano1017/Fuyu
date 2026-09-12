#!/usr/bin/env python3
"""正本（v13）の節番号を、ファイル上の位置・本文・内容ハッシュへ解決する（設計 §12.1.6 段1）。

「v13 §5.2.3」のような参照が **実在するか** を機械的に確かめるためのスクリプト。
設計 §10.3 は「引用された節番号が実際にその仕様を指しているか」を
**最頻の事故ポイント**と呼びながら、その検査を朝のオーナーの目視に委ねている。
ここだけを機械へ移す。

このスクリプトは **引くだけ**で、内容の解釈も採否の判断もしない
（設計 §0：仕様判断はオーナーの専権事項 ／ §3.1：調査は事実だけを返す）。

想定する使われ方は3つ:
  1. 解決できない節番号を検出し、**ゲート1へ到達する前に落とす**
  2. 節の本文だけを取り出し、5b（仕様適合）へ差分を見せる前に渡す（設計 §11.6 の commit-first）
  3. 承認時の `sha256` を state へ残し、ゲート3で再解決して
     **承認後に正本が改訂されていないか**を照合する（照合自体はオーケストレータ側の仕事）

使い方:
    python3 automation/scripts/spec_ref.py "v13 §5.2.3"
    python3 automation/scripts/spec_ref.py "§9 #51" "§5.11.2" --brief
    python3 automation/scripts/spec_ref.py --list

出力: 標準出力へ JSON `{"spec": ..., "all_resolved": bool, "results": [...]}`
終了コード: 0=全件解決 ／ 2=正本が見つからない ／ 3=解決できない参照がある
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

DEFAULT_SPEC = "docs/spec/浮遊街アプリ 総合要件定義・設計書_v13.md"

# 受け付ける参照の書式。先頭の版指定（v13 等）は読み飛ばす。
# 参照先の正本は --spec で決まるので、版の食い違いをここで判定はしない。
#   "v13 §5.2.3" / "§5.11.7" / "5.2.3" / "§9 #51" / "v13 §9 #46"
REF_RE = re.compile(
    r"""^\s*
    (?:v[\d.]+\s*)?                     # 任意の版指定
    [§§]?\s*
    (?P<section>\d+(?:\.\d+)*[a-z]?)    # 節番号
    (?:\s*[#＃]\s*(?P<item>\d+))?   # 任意の項目番号（§9 #51 の 51）
    \s*$""",
    re.VERBOSE,
)

# 見出しが「自分の節番号」を持つのは、見出し文が数字で始まるときだけ。
#   ○ `#### 5.2.3 ★ 宿泊予約の受付経路…`
#   × `#### ★ 利用者向け表示名（…／§9 #58）`
# 後者を拾うと、本文中の相互参照を見出し自身の節番号と誤認する。正本には実在する形なので、
# 「先頭が数字か」で判定することが誤検出を防ぐ唯一の条件になる。
HEADING_RE = re.compile(
    r"^(?P<hashes>#{1,6})\s+(?P<num>\d+(?:\.\d+)*[a-z]?)\.?\s+(?P<title>.*)$"
)

# §9 のような課題管理表の行。1列目が項目番号で、解決済みは `~~51~~`、
# 未決は `**17**` のように装飾されるため、装飾を剥がしてから比較する。
ITEM_ROW_RE = re.compile(r"^\|\s*(?:~~|\*\*)*\s*(?P<num>\d+)\s*(?:~~|\*\*)*\s*\|")


def sha256_of(text: str) -> str:
    """本文のハッシュ。改行コードの差でハッシュが動かないよう正規化してから取る。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def parse_sections(lines: list[str]) -> tuple[dict[str, dict], list[str]]:
    """見出しを走査し、節番号 -> {行番号, 階層, 見出し} の索引を作る。

    同じ節番号の見出しが2つある場合は解決を諦める（どちらを指すか機械には決められない）。
    戻り値の2つ目は重複した節番号のリスト。
    """
    sections: dict[str, dict] = {}
    duplicated: list[str] = []

    for index, line in enumerate(lines):
        match = HEADING_RE.match(line)
        if match is None:
            continue
        num = match.group("num")
        if num in sections:
            if num not in duplicated:
                duplicated.append(num)
            continue
        sections[num] = {
            "line": index,  # 0始まり。出力時に +1 する
            "level": len(match.group("hashes")),
            "heading": line.rstrip(),
        }

    for num in duplicated:
        sections.pop(num, None)

    return sections, duplicated


def section_body_range(lines: list[str], entry: dict) -> tuple[int, int]:
    """節の本文が占める行範囲（0始まり・終端を含む）を返す。

    次に現れる「同じ階層以浅」の見出しの直前までを、その節の本文とみなす。
    """
    start = entry["line"]
    level = entry["level"]

    end = len(lines) - 1
    for index in range(start + 1, len(lines)):
        match = HEADING_RE.match(lines[index])
        if match is not None and len(match.group("hashes")) <= level:
            end = index - 1
            break
        # 節番号を持たない見出し（`#### ★ …`）でも、階層が同じか浅ければ節は終わる。
        bare = re.match(r"^(#{1,6})\s+\S", lines[index])
        if bare is not None and len(bare.group(1)) <= level:
            end = index - 1
            break

    while end > start and not lines[end].strip():
        end -= 1
    return start, end


def find_item_row(lines: list[str], start: int, end: int, item: str) -> int | None:
    """節の中から `| 51 | …` の形の表行を探し、その行番号（0始まり）を返す。"""
    for index in range(start, end + 1):
        match = ITEM_ROW_RE.match(lines[index])
        if match is not None and match.group("num") == item:
            return index
    return None


def nearest_sections(sections: dict[str, dict], missing: str, limit: int = 5) -> list[str]:
    """解決できなかったとき、同じ親を持つ実在の節を候補として並べる。

    「§5.10.2 が無い」とだけ返されても直しようがないため、
    「§5.10.1 と §5.10.3 はある」まで示して、人が1手で直せる状態にする。
    """
    parent = missing.rsplit(".", 1)[0] if "." in missing else ""
    prefix = f"{parent}." if parent else ""
    siblings = [num for num in sections if num.startswith(prefix) and num != missing]
    if not siblings and parent:
        # 親そのものも無い場合は、より浅い階層まで遡って候補を出す。
        grandparent = parent.rsplit(".", 1)[0] if "." in parent else ""
        prefix = f"{grandparent}." if grandparent else ""
        siblings = [num for num in sections if num.startswith(prefix)]

    def sort_key(num: str) -> list[int]:
        return [int(part) for part in re.findall(r"\d+", num)]

    return sorted(set(siblings), key=sort_key)[:limit]


def resolve(
    ref: str,
    lines: list[str],
    sections: dict[str, dict],
    duplicated: list[str],
    spec_path: str,
    brief: bool,
) -> dict:
    """参照1件を解決する。解決できない理由は必ず `reason` に入れて返す。"""
    result: dict = {"ref": ref, "resolved": False}

    match = REF_RE.match(ref)
    if match is None:
        result["reason"] = (
            "参照の書式を解釈できません。"
            "「v13 §5.2.3」「§9 #51」「5.2.3」のいずれかの形で指定してください"
        )
        return result

    section = match.group("section")
    item = match.group("item")
    result["section"] = section
    result["item"] = item

    if section in duplicated:
        result["reason"] = f"節 §{section} の見出しが正本に複数あり、どちらを指すか特定できません"
        return result

    entry = sections.get(section)
    if entry is None:
        result["reason"] = f"節 §{section} は正本に存在しません"
        candidates = nearest_sections(sections, section)
        if candidates:
            result["candidates"] = [f"§{num}" for num in candidates]
        return result

    start, end = section_body_range(lines, entry)

    if item is not None:
        row = find_item_row(lines, start, end, item)
        if row is None:
            result["reason"] = f"節 §{section} の中に項目 #{item} の行が見つかりません"
            return result
        start = end = row

    body = "\n".join(lines[start : end + 1])

    result.update(
        {
            "resolved": True,
            "path": spec_path,
            "heading": entry["heading"],
            "line_start": start + 1,  # 1始まりに直す（grep -n やエディタと揃える）
            "line_end": end + 1,
            "sha256": sha256_of(body),
        }
    )
    if not brief:
        result["text"] = body
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="正本の節番号をファイル上の位置とハッシュへ解決する（設計 §12.1.6 段1）"
    )
    parser.add_argument("refs", nargs="*", help="解決したい参照（例: 'v13 §5.2.3' '§9 #51'）")
    parser.add_argument("--spec", default=DEFAULT_SPEC, help=f"正本のパス（既定: {DEFAULT_SPEC}）")
    parser.add_argument(
        "--brief", action="store_true", help="本文（text）を出力に含めない。state へ残す用途向け"
    )
    parser.add_argument(
        "--list", action="store_true", dest="list_sections", help="解決可能な節番号を一覧する"
    )
    args = parser.parse_args()

    spec_path = Path(args.spec)
    if not spec_path.is_file():
        print(f"正本が見つかりません: {spec_path}", file=sys.stderr)
        return 2

    # 出力は state / Issue コメントへ渡るため、区切り文字を POSIX 形式へ揃える
    # （手元は Windows、CI は ubuntu。ハッシュ照合の鍵にパスが混ざると環境差で外れる）
    spec_display = spec_path.as_posix()
    lines = spec_path.read_text(encoding="utf-8").splitlines()
    sections, duplicated = parse_sections(lines)

    if args.list_sections:
        listed = [
            {"section": num, "line": entry["line"] + 1, "heading": entry["heading"]}
            for num, entry in sorted(
                sections.items(), key=lambda kv: [int(p) for p in re.findall(r"\d+", kv[0])]
            )
        ]
        print(
            json.dumps(
                {
                    "spec": spec_display,
                    "count": len(listed),
                    "duplicated": duplicated,
                    "sections": listed,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    if not args.refs:
        parser.error("解決したい参照を1つ以上指定してください（一覧は --list）")

    results = [
        resolve(ref, lines, sections, duplicated, spec_display, args.brief) for ref in args.refs
    ]
    all_resolved = all(item["resolved"] for item in results)

    print(
        json.dumps(
            {"spec": spec_display, "all_resolved": all_resolved, "results": results},
            ensure_ascii=False,
            indent=2,
        )
    )
    # 解決できない参照が1件でもあれば非ゼロ。ゲート1の手前で落とすための終了コード。
    return 0 if all_resolved else 3


if __name__ == "__main__":
    sys.exit(main())
