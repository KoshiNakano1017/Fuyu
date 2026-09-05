#!/usr/bin/env bash
#
# エージェントの最終メッセージを取り出し、Issue / PR コメントへ転記する。
#
#   post_agent_output.sh <execution_file> <issue|pr> <番号> <見出し> <出力先ファイル>
#
# ── なぜ転記をワークフローが行うのか ─────────────────────────────
# 設計 §3 は各エージェントの出力先を「Issue コメント」「PR レビューコメント」と定める一方、
# §7.2 は同じエージェントの書き込み権限を settings で機械的に落とすことも定めている。
# `readonly.json` は Bash を全面拒否し、`test.json` は gh を許可していない。
# **エージェントは自力で出力先に到達できない。**
#
# 権限を緩めて解決すると §3 の権限表が崩れる。そこで auto-01 の規律
# 「機械的に決まるものは機械が持つ」を転記にも適用する。
# auto-01 の試運転で踏んだ ①権限不足で Issue コメントに到達できない
# ③エージェントの出力がランナー内に留まる、の再発防止でもある。
#
# 転記に失敗してもジョブは落とさない。マーカーが読めない場合、
# 呼び出し側は安全側（findings / 高リスク）に倒す作りになっているため。
set -uo pipefail

EXEC_FILE="${1:-}"
TARGET_KIND="${2:-}"   # issue | pr
TARGET_NUM="${3:-}"
HEADING="${4:-}"
OUT_FILE="${5:-/tmp/agent-output.md}"

: > "$OUT_FILE"

if [ -z "$EXEC_FILE" ] || [ ! -f "$EXEC_FILE" ]; then
  echo "::warning::エージェントの実行ログが見つかりません（${EXEC_FILE:-未指定}）。転記をスキップします"
  exit 0
fi

# claude-code-action の execution_file は SDK メッセージの JSON。
# 版によって形が変わりうるので、確度の高い順に3通り試す。
extract() {
  jq -r '[.. | objects | select(.type? == "result") | .result? // empty] | last // empty' "$EXEC_FILE" 2>/dev/null && return 0
  return 1
}
BODY="$(extract || true)"

if [ -z "$BODY" ]; then
  BODY="$(jq -r '
    [.. | objects | select(.type? == "assistant")
       | .message?.content[]? | select(.type? == "text") | .text? // empty] | last // empty
  ' "$EXEC_FILE" 2>/dev/null || true)"
fi

if [ -z "$BODY" ]; then
  BODY="$(jq -r '[.. | objects | select(has("text")) | .text? // empty] | last // empty' "$EXEC_FILE" 2>/dev/null || true)"
fi

if [ -z "$BODY" ]; then
  echo "::warning::エージェントの最終メッセージを取り出せませんでした。呼び出し側は安全側で扱われます"
  exit 0
fi

# GitHub のコメント上限は 65536 文字。超える場合は末尾を残す
# （マーカーは末尾にあるため、先頭ではなく中間を落とす）。
LIMIT=60000
if [ "${#BODY}" -gt "$LIMIT" ]; then
  HEAD_PART="${BODY:0:40000}"
  TAIL_PART="${BODY: -15000}"
  BODY="${HEAD_PART}

---
*（長さの上限のため中間を省略しました。全文は Actions のログを参照）*
---

${TAIL_PART}"
fi

printf '%s\n' "$BODY" > "$OUT_FILE"

{
  [ -n "$HEADING" ] && printf '<!-- %s -->\n\n' "$HEADING"
  printf '%s\n' "$BODY"
} > /tmp/_post_body.md

case "$TARGET_KIND" in
  issue) gh issue comment "$TARGET_NUM" --repo "$GITHUB_REPOSITORY" --body-file /tmp/_post_body.md \
           || echo "::warning::Issue #${TARGET_NUM} へのコメントに失敗しました" ;;
  pr)    gh pr comment    "$TARGET_NUM" --repo "$GITHUB_REPOSITORY" --body-file /tmp/_post_body.md \
           || echo "::warning::PR #${TARGET_NUM} へのコメントに失敗しました" ;;
  none)  echo "転記先の指定なし。ファイルへの書き出しのみ行いました" ;;
  *)     echo "::warning::転記先の種別が不正です: ${TARGET_KIND}" ;;
esac

exit 0
