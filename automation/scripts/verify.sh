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
  {
    printf '{"ok":%s,"steps":[' "$ALL_OK"
    for i in "${!STEP_NAMES[@]}"; do
      [ "$i" -gt 0 ] && printf ','
      # jq でエスケープする。tail にはログがそのまま入るため自前の escape は危険。
      printf '{"name":%s,"ok":%s,"code":%s,"tail":%s}' \
        "$(printf '%s' "${STEP_NAMES[$i]}" | jq -R -s .)" \
        "${STEP_OKS[$i]}" \
        "${STEP_CODES[$i]}" \
        "$(printf '%s' "${STEP_TAILS[$i]}" | jq -R -s .)"
    done
    printf ']}\n'
  } > "$JSON_OUT"
  echo "検証結果を ${JSON_OUT} へ書き出しました"
fi

if [ "$ALL_OK" = "true" ]; then
  echo "verify.sh: すべて緑"
  exit 0
fi
echo "verify.sh: 失敗あり"
exit 1
