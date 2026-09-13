#!/usr/bin/env bash
#
# verify.sh — オーケストレータ内で回す「速い検証」
#
#   bash automation/scripts/verify.sh [--json <出力先>]
#
# ── 位置づけ（設計 §12.1.6 段7・§12.1.7）─────────────────────────
# これは **CI の代替ではない**。往復削減のための道具である。
#
#   verify.sh  : 実装オーケストレータのプロセス内で、コーディング／修正の
#                ループを回すために使う。数十秒で終わることを優先する。
#   ci.yml     : マージの根拠。E2E を含む。**絶対に外さない**（設計 §11.6）。
#
# 設計 §11.6 は「エージェントのローカル緑は接地していない信号」と定めている。
# したがって verify.sh が緑でもマージの根拠にはならない。緑になって初めて
# PR を出す、という順序を守るためだけに存在する。
#
# ── 出力 ────────────────────────────────────────────────────────
# 人間向けにはログを標準出力へ。機械向けには --json で下記を書き出す。
#
#   { "ok": true|false,
#     "steps": [ { "name": "typecheck", "ok": true, "code": 0, "tail": "..." } ] }
#
# 終了コード: すべて緑なら 0、1つでも落ちたら 1。
set -uo pipefail

JSON_OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON_OUT="${2:-}"; shift 2 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

# 失敗しても即座に抜けない。全ステップの結果を集めたほうが、
# エージェントが1往復で直せる情報量が増えるため。
STEP_NAMES=()
STEP_OKS=()
STEP_CODES=()
STEP_TAILS=()

run_step() {
  local name="$1"; shift
  local log
  log="$(mktemp)"
  echo "── ${name} ──────────────────────────────"
  # shellcheck disable=SC2068
  if $@ >"$log" 2>&1; then
    local code=0
  else
    local code=$?
  fi
  cat "$log"
  # 末尾だけを機械向けに残す。全文は Actions のログにある。
  local tail_text
  tail_text="$(tail -c 4000 "$log")"
  rm -f "$log"

  STEP_NAMES+=("$name")
  STEP_CODES+=("$code")
  STEP_TAILS+=("$tail_text")
  if [ "$code" -eq 0 ]; then
    STEP_OKS+=("true")
    echo "✅ ${name}"
  else
    STEP_OKS+=("false")
    echo "❌ ${name} (exit ${code})"
  fi
  echo
}

if [ ! -f package.json ]; then
  echo "::error::package.json が見つかりません。リポジトリのルートで実行してください"
  exit 2
fi

# node_modules が無い状態で呼ばれることがある（別ジョブのキャッシュ外など）。
if [ ! -d node_modules ]; then
  echo "node_modules がありません。npm ci を実行します"
  run_step "install" npm ci --no-audit --no-fund
fi

run_step "typecheck" npm run typecheck
run_step "lint"      npm run lint
run_step "test"      npm test -- --ci --passWithNoTests

ALL_OK=true
for ok in "${STEP_OKS[@]}"; do
  [ "$ok" = "true" ] || ALL_OK=false
done

if [ -n "$JSON_OUT" ]; then
  # エスケープは node で行う。当初 jq を使っていたが、jq は入っていない環境があり
  # （Git Bash・最小構成のコンテナ）、その場合に **壊れた JSON を書いたまま
  # 「すべて緑」と報告していた**。node は npm ci 済みの前提で必ず在る。
  #
  # 値は環境変数で渡す。引数やヒアドキュメントに混ぜると、ログに含まれる
  # 引用符・バックスラッシュ・改行でシェルの解釈が壊れる。
  #
  # 区切りは各要素の **前** に置く。コマンド置換は末尾の改行を落とすため、
  # 後置区切り＋末尾要素の切り捨てだと最後の1件が消える（実際に消えた）。
  #
  # ⚠️ 継続行（\）の途中にコメントを挟まないこと。`\` の次の行が `#` で始まると
  #    そこでコマンドが切れ、以降の変数代入が別コマンドになる。
  #    実際に V_OK だけが node へ渡らず、全ステップ緑でも ok=false になった。
  V_OK="$ALL_OK" \
  V_NAMES="$(printf '%s\n' "${STEP_NAMES[@]}")" \
  V_OKS="$(printf '%s\n' "${STEP_OKS[@]}")" \
  V_CODES="$(printf '%s\n' "${STEP_CODES[@]}")" \
  V_TAILS="$(printf '@@VERIFY_STEP_SEP@@\n%s\n' "${STEP_TAILS[@]}")" \
  node -e '
    const lines = (s) => (s ?? "").split("\n").filter((x) => x.length > 0);
    const names = lines(process.env.V_NAMES);
    const oks   = lines(process.env.V_OKS);
    const codes = lines(process.env.V_CODES);
    // 先頭が区切りなので split の第1要素は空。それだけを落とす。
    const tails = (process.env.V_TAILS ?? "")
      .split("@@VERIFY_STEP_SEP@@\n")
      .slice(1)
      .map((t) => t.replace(/\n$/, ""));
    const steps = names.map((name, i) => ({
      name,
      ok: oks[i] === "true",
      code: Number(codes[i] ?? -1),
      tail: tails[i] ?? "",
    }));
    process.stdout.write(JSON.stringify({ ok: process.env.V_OK === "true", steps }));
  ' > "$JSON_OUT"

  # 書き出した JSON が実際に読めることを確かめる。読めなければ緑と言わない。
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$JSON_OUT" 2>/dev/null; then
    echo "::error::検証結果の JSON を書き出せませんでした（${JSON_OUT}）"
    exit 1
  fi
  echo "検証結果を ${JSON_OUT} へ書き出しました"
fi

if [ "$ALL_OK" = "true" ]; then
  echo "verify.sh: すべて緑"
  exit 0
fi
echo "verify.sh: 失敗あり"
exit 1
