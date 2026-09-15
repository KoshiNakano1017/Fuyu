#!/usr/bin/env bash
# 自律運用デーモン（2026-09-16 オーナー指示）
#
#   「いちいち止めずに推奨プランで進める」
#   「マージも自律ループで対応」
#   「CI で赤くなったら数回修正し、直らなければ依存の少ない別機能へ切り替えて開発を止めない」
#
# ── やること ──────────────────────────────────────────────
#   1. 承認待ちのゲートを承認する
#   2. **全チェックが緑の** PR をマージする
#   3. 赤い PR を数える。RED_LIMIT 回続いたら、その Issue を退避して
#      **依存の少ない別パッケージ**を起票し、開発を止めない
#   4. 起きたことを全部ログへ書く
#
# ── やらないこと（意図的）──────────────────────────────────
#   - **CI が赤い PR のマージ**（CLAUDE.md §6.2。自動化しても外さない）
#   - 保留チェックがある PR のマージ（レビュー実行中に突っ込まない）
#   - `auto:blocked` への回答（選択肢の判断は人間／対話セッションの領分・設計 §0）
#
# 止める:  touch automation/state/auto_loop.stop

set -uo pipefail

REPO="KoshiNakano1017/Fuyu"
STATE="automation/state"
LOG="$STATE/auto_loop.log"
STOP="$STATE/auto_loop.stop"
REDS="$STATE/auto_loop_reds"        # PR番号ごとの連続赤カウント置き場
RED_LIMIT=3                          # 何回赤が続いたら見切るか
INTERVAL=45

# 依存が少ない順のフォールバック（automation/scripts で実測して並べたもの）。
# 依存0件を先に、次に規模の小さいものを置く。被依存が多いものは波及が大きいので後ろ。
FALLBACK="18-2 17-2 18-1 9-2 2-4 1-1b 13-1"

mkdir -p "$STATE" "$REDS"
: > "$LOG"
log() { printf '[%s] %s\n' "$(date -u +%m-%d\ %H:%M:%S)" "$1" >> "$LOG"; }

log "起動。停止は touch $STOP"
log "フォールバック順: $FALLBACK"

prev=""
while :; do
  [ -f "$STOP" ] && { log "STOP を検出。終了"; break; }

  # ── 1. ゲートの承認 ───────────────────────────────────────
  for wf in auto-01-plan.yml auto-02-implement.yml auto-03-review-merge.yml; do
    for r in $(gh run list --workflow="$wf" --limit 6 --repo "$REPO" \
                 --json databaseId,status --jq 'map(select(.status=="waiting"))|.[].databaseId' 2>/dev/null); do
      for e in $(gh api "repos/$REPO/actions/runs/$r/pending_deployments" \
                   --jq '.[] | select(.current_user_can_approve) | .environment.id' 2>/dev/null); do
        gh api "repos/$REPO/actions/runs/$r/pending_deployments" -X POST \
          -f state=approved -f comment="推奨プランに基づく自動承認（2026-09-16 オーナー指示）" \
          -F "environment_ids[]=$e" >/dev/null 2>&1 \
          && log "ゲート承認: $wf run=$r env=$e"
      done
    done
  done

  # ── 2. PR の処理（緑ならマージ／赤なら数える）──────────────────
  for pr in $(gh pr list --repo "$REPO" --json number --jq '.[].number' 2>/dev/null); do
    checks=$(gh pr checks "$pr" --repo "$REPO" 2>&1)
    nfail=$(printf '%s' "$checks" | grep -c $'\tfail\t')
    npend=$(printf '%s' "$checks" | grep -cE $'\t(pending|in_progress)\t')
    npass=$(printf '%s' "$checks" | grep -c $'\tpass\t')

    if [ "$npend" -gt 0 ]; then
      continue                                   # 実行中。次の周回で見る
    fi

    if [ "$nfail" -eq 0 ] && [ "$npass" -gt 0 ]; then
      if gh pr merge "$pr" --repo "$REPO" --merge >/dev/null 2>&1; then
        log "マージ: PR #$pr（pass=$npass fail=0）"
        rm -f "$REDS/$pr"
      fi
      continue
    fi

    # ── 赤い PR ────────────────────────────────────────────
    n=$(cat "$REDS/$pr" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$REDS/$pr"
    log "⛔ PR #$pr が赤い（fail=$nfail ／ 連続 $n 回目）。CLAUDE.md §6.2 によりマージしない"

    if [ "$n" -lt "$RED_LIMIT" ]; then
      # ループ自身の PR なら、検証フェーズをやり直させる（修正エージェントが走る）
      iss=$(gh pr view "$pr" --repo "$REPO" --json headRefName \
              --jq '.headRefName | capture("issue-(?<n>[0-9]+)") | .n' 2>/dev/null)
      if [ -n "${iss:-}" ]; then
        gh issue edit "$iss" --repo "$REPO" --remove-label "auto:blocked" >/dev/null 2>&1
        gh issue edit "$iss" --repo "$REPO" --add-label "auto:review" >/dev/null 2>&1 \
          && log "  → Issue #$iss を auto:review へ付け直し、修正を再試行させた（$n/$RED_LIMIT）"
      fi
      continue
    fi

    # ── 見切り: 退避して別パッケージへ ────────────────────────
    iss=$(gh pr view "$pr" --repo "$REPO" --json headRefName \
            --jq '.headRefName | capture("issue-(?<n>[0-9]+)") | .n' 2>/dev/null)
    if [ -n "${iss:-}" ]; then
      gh issue comment "$iss" --repo "$REPO" --body \
"CI が $RED_LIMIT 回連続で赤のままのため、**このタスクを一旦退避**します（2026-09-16 オーナー方針「直らなければ依存の少ない別機能へ切り替えて開発を止めない」）。

PR #$pr は開いたまま残します。**マージはしていません**（CLAUDE.md §6.2「CI が赤い PR はマージしない」）。

再開するときは、CI の失敗を人が直してから \`auto:review\` を付け直してください。" >/dev/null 2>&1
      gh issue edit "$iss" --repo "$REPO" --remove-label "auto:review" >/dev/null 2>&1
      gh issue edit "$iss" --repo "$REPO" --add-label "auto:blocked" >/dev/null 2>&1
      log "  → Issue #$iss を退避（auto:blocked）。PR #$pr は開いたまま残す"
    fi

    # 依存の少ない順に、まだ Issue が無いものを1件だけ起票する
    for wp in $FALLBACK; do
      if gh issue list --repo "$REPO" --state all --limit 60 --json title \
           --jq '.[].title' 2>/dev/null | grep -q "WBS $wp "; then
        continue
      fi
      gh workflow run wbs-to-issue.yml --repo "$REPO" --ref main \
        -f package="$wp" -f draft=true -f resolve=true -f start_loop=false >/dev/null 2>&1 \
        && log "  → 代替として WBS $wp を起票した（依存が少ない順）"
      break
    done
    rm -f "$REDS/$pr"
  done

  # ── 3. 状態が変わったときだけ記録 ──────────────────────────
  now=$(gh issue list --repo "$REPO" --limit 14 --json number,labels \
          --jq '[.[] | "#\(.number):\(.labels|map(.name)|map(select(startswith("auto")))|join("+"))"]|join(" ")' 2>/dev/null)
  [ "$now" != "$prev" ] && { log "状態: $now"; prev="$now"; }

  sleep "$INTERVAL"
done
log "終了"
