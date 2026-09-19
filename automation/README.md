# 開発自動化（自律開発ループ）

**このディレクトリはアプリのソースコードでも仕様書でもない。** 開発プロセスを回すための構成物である。

| 見たいもの | 行き先 |
| --- | --- |
| **設計の正本**（なぜこう組んだか） | [`docs/自律開発ループ設計.md`](../docs/自律開発ループ設計.md) |
| 実装状況・着手順序 | このファイルの下部 |
| プロンプトの書き方 | [`agents/README.md`](agents/README.md) |
| 権限設定の意図 | [設計 §7.2](../docs/自律開発ループ設計.md) |

> [!IMPORTANT]
> **設計の内容をこのファイルに複製しない。** CLAUDE.md §1.1 の二重管理禁止に抵触する。
> ここに書くのは「どこに何があるか」と「今どこまで出来ているか」だけ。

---

## ディレクトリの分け方

開発自動化は、アプリのソース・仕様書と**混ざらないよう分離してある**。

| 場所 | 中身 | なぜそこか |
| --- | --- | --- |
| `automation/agents/` | エージェント定義11本（frontmatter が権限の宣言を兼ねる） | 任意の場所でよいので、自動化を1箇所に集約 |
| `automation/settings/` | エージェントごとの権限設定5本 | 同上 |
| `automation/scripts/` | ワークフローから呼ぶスクリプト | YAML に長い処理を埋めると読めず、手元で検証もできないため分離 |
| `.github/workflows/` | ワークフロー8本 | **GitHub の仕様で位置が固定**されている |
| `.github/ISSUE_TEMPLATE/` | Issue テンプレート | 同上 |
| `docs/` | 仕様書（正本）・設計 | ループが読む対象。**ループは書き換えない**（§8.2） |
| ルート | アプリのソース | ループが書く対象 |

---

## 実装状況

| 区分 | ファイル | 状態 | 備考 |
| --- | --- | --- | --- |
| **権限設定** | `settings/readonly.json` | 🟡 未検証 | レビュー 5a/5b/5c 用。記法の実機確認が必要（設計 §12 #5） |
| | `settings/research.json` | 🟡 未検証 | **調査専用**。読み取り＋Issue コメントのみ（下記「調査の権限」参照） |
| | `settings/pm.json` | 🟡 未検証 | 同上 |
| | `settings/test.json` | 🟡 未検証 | 同上 |
| | `settings/code.json` | 🟡 未検証 | 同上 |
| **ワークフロー** | `.github/workflows/auto-01-plan.yml` | 🟢 完成 | 計画フェーズ。**2026-09-16: ゲート1・2と30分異議窓を撤去**（`approve-definition` / `approve-plan` / `low-risk-*` / `rejected` を削除し `notify-classification` を新設）。停止事由を `blocked_kind` でラベルへ振り分ける（設計 §4.1・§5）。**足場が無くても動く** |
|  | `.github/workflows/auto-02-implement.yml` | 🟢 完成 | 実装フェーズ。テスト設計 → 実装 → PR。ゲートなし（設計 §6）。**2026-09-16: concurrency を Issue 単位へ**（`format('auto-implement-{0}', issue.number)`。リテラル `'auto-implement'` は pending 追い出しで Issue を無音のまま永久停止させる。設計 §8.3）。**足場が必要** |
|  | `.github/workflows/auto-03-review-merge.yml` | 🟢 完成 | **最重量**（レビュー3並列＋修正ループ＋リトライ判定＋仕様書ガード＋ゲート3）。**2026-09-16: 自動通過を `RISK = low` → `RISK != high` へ拡大**。PII 繰り上げと `auto:needs-review` はゲート3を強制。**条件③（段取りの宣言範囲内）は停止事由から警告へ格下げ**（設計 §4.1）。**足場が必要** |
|  | `.github/workflows/auto-05-sweep.yml` | 🟢 **完成（2026-09-16 新設）** | **ループで唯一のイベント非依存の入口**（cron `*/30` ＋ 手動）。`auto-01`〜`04` は全て `labeled` 駆動で、run が死ぬと Issue が永久静止していた（設計 §6.4） |
| **エージェント定義** | `agents/pm-define.md` | 🟢 完成 | タスク定義＋リスク区分の判定。**2026-09-16: 新章「仮決定で進む」を追加**（低・中リスクの未確定論点はここが正。設計 §3.4） |
|  | `agents/research.md` | 🟢 完成 | 調査。§3.2 の6軸と質問形式を転記済み |
|  | `agents/pm-plan.md` | 🟢 完成 | 段取り＋`QUESTIONS.md` への起票。仮決定の書式は**再掲せず `pm-define.md` を参照**する（二重管理の禁止） |
|  | `agents/test-design.md` | 🟢 完成 | 仕様だけを見て受入テストを先に書く（設計 §11.6 の commit-first） |
|  | `agents/coding.md` | 🟢 完成 | 実装。テストと `docs/spec/` は書き換えない |
|  | `agents/review-quality.md` | 🟢 完成 | レビュー 5a。バグ・認可漏れ・CLAUDE.md §4 |
|  | `agents/review-spec.md` | 🟢 完成 | レビュー 5b。**差分を読む前に仕様から要件を列挙する2段構造**（設計 §11.6） |
|  | `agents/review-privacy.md` | 🟢 完成 | レビュー 5c。**最後の防波堤**。ダミーデータでは止めない（2026-09-05 オーナー決定） |
|  | `agents/fix.md` | 🟢 完成 | 修正。振る舞いが変わるなら直さず止まる（設計 §7.1） |
|  | `agents/pm-report.md` | 🟢 完成 | 報告。`LOOP_LOG.md` へ §10.9 の指標の**素材**を記録する |
|  | `agents/risk-classify.md` | 🟢 完成 | **2026-09-07 新設**。PM の自己判定を独立 subagent の再判定へ分離（設計 §4.1・§11.6）。**2026-09-16 修正**: 出力例が `triggered` / `reasons` / `escalated_axis` / `uncertain` という**`RISK_SCHEMA` に存在しない4キー**を載せていた。`additionalProperties: false` のため**未知キーを返すと検証に落ち、`plan.mjs` が安全側に倒して `high` 扱いになる**（独立判定が常に `high` へ縮退する）。使えるのは `risk` / `reason` / `triggers` の3つだけ |
| **スクリプト** | `scripts/post_agent_output.sh` | 🟢 完成 | エージェントの最終メッセージを Issue / PR へ転記する（下記「出力先に届かないエージェント」） |
| | `automation/scripts/sweep.py` | 🟢 **完成（2026-09-16 新設）** | `auto-05-sweep.yml` の実体。**①回収**（停滞した `auto:planning`/`approved`/`implementing`/`review` をラベル付け直しで再起動。閾値 90/30/150/150分）**②再試行**（`auto:retry` を冷却60分後に復帰。戻り先は `<!--retry:from=X-->`）**③払い出し**（作業中が上限未満なら WBS 依存順で次の ready を `wbs-to-issue.yml` へ dispatch）**④枯渇レポート**。**`auto:blocked` には触れない**（オーナーの専権事項・設計 §0）。`--dry-run` で手元検証できる |
| **Issue テンプレ** | `.github/ISSUE_TEMPLATE/auto-task.yml` | 🟢 完成 | 起票3条件を必須フィールド化 |
| **起票導線** | `.github/workflows/wbs-to-issue.yml` | 🟢 完成 | **導線1（§10.1.5）**。WBS の作業パッケージ番号を渡すと Issue を生成。手動起動 |
| | `automation/scripts/wbs_to_issue.py` | 🟢 完成 | 上記のパーサ。`python3 automation/scripts/wbs_to_issue.py 3-5b` で手元検証できる |
| | `agents/issue-draft.md` ＋ `settings/draft.json` | 🟢 **完成（2026-09-13）** | **導線2（§10.1.5）**。WBS から生成した Issue に、仕様を読んで**完了条件とスコープ外を起草**する。オーナーは起草を読んで `auto` を付けるだけになる（`auto` を付ける行為が承認）。`draft.json` が `Write`/`Edit` を全面拒否するため **`docs/spec/` を1文字も書けない** |
| | 導線3（QUESTIONS.md からの逆流） | 🔴 未着手 | 設計 §10.1.5 |
| **正本参照** | `automation/scripts/spec_ref.py` | 🟢 完成 | **エージェント化 段1**（設計 §12.1.6）。`v13 §5.2.3` / `§9 #51` をパス・行範囲・本文・`sha256` へ解決する。解決できない参照は終了コード3で落ちるため、**ゲート1へ到達する前**に止められる。`python3 automation/scripts/spec_ref.py "v13 §5.2.3"` で手元検証できる |
| **定義の検査** | `automation/scripts/check_agents.py` | 🟢 完成 | **エージェント化 段2**。frontmatter の `tools:`（ツール層）と `settings/*.json`（パス層）の対応を検査し、「`docs/spec/` を書けない」「`coding`/`fix` は `tests/` を書けない」を強制する。違反があれば終了コード3。**2026-09-13 修正**: `Write(<glob>)` を有効な防御として数えていたのをやめた（下の警告を参照） |
| **オーケストレータ** | `orchestrator/plan.mjs` | 🟢 **完成（2026-09-13）** | **段3**。PM定義 → リスク判定 → 調査 → PM段取り を1プロセスで回し、**構造化出力（JSON Schema）**で受け渡す。Issue コメントの grep 判定を全廃した。**2026-09-16: 仮決定を Issue コメント（`<!--provisional-->`）と `state.provisional` に記録し、`blocked_kind` を出力する** |
| | `orchestrator/implement.mjs` | 🟢 完成・配線済み | **段7**。テスト設計 → テストの sha256 固定 → コーディング → `verify.sh` のループ |
| | `orchestrator/review.mjs` | 🟢 完成・配線済み | **段7**。5a/5b/5c 並列 → 修正 → `verify.sh` → テストハッシュ照合 → `spec_ref` の sha 再検証 |
| | `orchestrator/lib/runAgent.mjs` | 🟢 **完成（2026-09-13）** | **SDK に触れるのはこのファイルだけ。** Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）を呼ぶ。PreToolUse フックで `Write` のパス拒否を補完する（下の警告） |
| | `orchestrator/lib/{agents,schema,state,gh}.mjs` | 🟢 完成 | 定義の読み込み／構造化出力の検証／state（試行3分類＋エラー指紋）／gh ラッパ。**2026-09-16: `schema.mjs` に `provisionalDecision`（`reversibility` 必須・設計 §3.4）、`state.mjs` に `classifyBlock()`（`spec`/`infra`/`credit` の分類・設計 §5）を追加** |
| **速い検証** | `automation/scripts/verify.sh` | 🟢 **完成（2026-09-13）** | **段7**。型・lint・単体を数十秒で回し JSON で返す。**CI の代替ではない**（設計 §11.6：マージの根拠にできるのは CI の合否と人間の承認だけ） |

> [!IMPORTANT] 導線1 は `auto` ラベルを自動では付けない
> 起票可能かの3条件（設計 §10.1.3）のうち、機械が判定できるのは**2つだけ**。
>
> | 条件 | 自動判定 | 根拠 |
> | --- | --- | --- |
> | 1. 節番号が引ける | ✅ できる | WBS の概要・ステータス欄、無ければ機能領域の見出しから抽出 |
> | 2. ブロッカーが解けている | ✅ できる | WBS のステータス欄の 🔴／ブロック中 を判定 |
> | 3. **完了条件が検証可能** | ❌ **できない** | **WBS に完了条件が書かれていない** |
>
> 3を機械が埋めると「起票の場で仕様を考える」ことになり、翌朝のゲート1
> （PM の解釈とオーナーの意図の照合）が空回りする（§10.1.3 の警告）。
> そのため **Issue の「完了条件」「スコープ外」は意図的に空欄**で生成し、
> 既定では `auto` を付けない。人が埋めてから手で付ける運用にしている。
>
> `start_loop: true` を明示すれば `auto` まで付けられるが、条件1・2 が
> 満たされない場合はワークフロー側が拒否する（安全側へ倒す）。

> [!WARNING] `Write(<パス>)` の拒否は効かない（2026-09-13 判明）
> **Claude Code がパス規則を評価するのは `Edit(path)` と `Read(path)` だけ。**
> `Write(...)` / `NotebookEdit(...)` / `Glob(...)` のパス規則は受け付けるが参照しない
> （起動時に警告が出るだけ）。
>
> つまり `settings/code.json` の `"Write(tests/**)"` は**効いていなかった**。
> コーディングエージェントは `Write` で受入テストを上書きでき、
> 設計 §11.6 の commit-first と §12.1.5 が塞いだはずの穴が空いたままだった。
> `check_agents.py` は文字列が在れば合格と判定していたため検出できていない。
>
> **現在の防御は3層:**
> 1. `settings/*.json` の `Edit(<glob>)` 拒否（Claude Code が評価する）
> 2. `orchestrator/lib/runAgent.mjs` の **PreToolUse フック**が、`Edit` の拒否から
>    `Write` 拒否を自動補完する（フックは権限評価の最前段で、`bypassPermissions` でも効く）
> 3. `implement.mjs` / `review.mjs` が **tests/ の sha256 を前後で照合**する
>
> ⚠️ 2 はオーケストレータ経由のときだけ効く。`claude-code-action` から直接
> エージェントを呼ぶ旧経路では 1 と 3 しか働かない。
>
> <!-- 由来: 2026-09-13 段3の実装中に Agent SDK の権限仕様を確認して判明
>      防ぐ失敗: 受入テストを実装側が書き換え、commit-first が空洞化すること -->

> [!IMPORTANT] 調査の権限 — `readonly.json` を調査に使わない
> `readonly.json` は `Bash` を全面拒否するため、これを調査エージェントに与えると
> **設計 §3 が定める出力先（Issue コメント）に到達できず、調査メモが消える**。
> 調査には `research.json`（読み取り＋`gh issue comment` のみ）を使う。
>
> `QUESTIONS.md` への起票とラベル操作は調査の権限外であり、**次に動く PM（段取り）が引き継ぐ**。
> ラベル遷移はワークフローがマーカー（`<!--blocked-->` / `<!--risk:*-->`）を読んで行う。

---

## 着手順序

> [!WARNING] 2026-09-13 訂正：「移行という作業は無い」は**層①だけの話だった**
> 下の 2026-09-08 の記述は **層①（各エージェント）について正しく、層②（連携）については誤り**だった。
> 設計 §12.1.1 は書き換える対象を「②誰がいつ動くか」だけと定めており、
> §12.1.6 の段取り表は段3で `orchestrator/plan.mjs` を書き、段4で YAML を削ると明記している。
> ところが本 callout が「移行は無い／工数を取る必要はない」と断定したため、
> **段3・段4 が誰にも着手されないまま5日間「完了扱い」で放置された**。
>
> 2026-09-13 に段3・4・5 を実施し、段7 を一部実施した。現況は下表を参照。
>
> <!-- 由来: 2026-09-13 段3〜5の実装 / 防ぐ失敗: 断定的な要約が段取り表を打ち消し、
>      未着手の工程が「完了扱い」で放置されること -->

> [!IMPORTANT] 2026-09-08：「移行」という作業は無い — タスクを流すだけ（※上の訂正を先に読むこと）
> オーナー確定（2026-09-08）: **エージェント定義11本・`auto-01`〜`auto-03`・承認ゲートはすでに揃っている。**
> 2026-09-07 の「エージェント方式への移行」は作り直しではなく**方式の再定義**であり、
> **移行プロジェクトとして工数を取る必要はない**。下表の順序はそのまま有効。
>
> ⚠️ ただし「流すだけ」を阻んでいた不具合2件を 2026-09-08 に修正した:
> **①`auto-02`／`auto-03` が `automation/prompts/*.md` を指したまま**だった（7か所。存在しないパスで必ず失敗する）／
> **②09-05 作成の定義7本に frontmatter が無かった**（`tools:`／`settings:` 未宣言で §7.2 の権限制限が効かない）。
> **`python automation/scripts/check_agents.py` で違反なしを確認してから流すこと。**

**計画ループ（`auto-01`）だけを先に完成させると、足場が無くても動き始める。**
計画フェーズのエージェントは Issue にコメントするだけでコードに触らないため。

| 順 | やること | 目安 | 状態 |
| --- | --- | --- | --- |
| 1 | GitHub の器（PAT・Environments・ラベル・通知） | 45分 | ✅ 完了（設計 §9 フェーズ1） |
| 2 | `settings/*.json` の実機検証 | 1時間 | ⬜ **試運転 3-3 で確認する**（設計 §12 #5） |
| 3 | `agents/pm-define.md` | 1時間 | ✅ 完了 |
| 4 | **`agents/research.md`** | 1.5時間 | ✅ 完了 |
| 5 | `agents/pm-plan.md` | 1時間 | ✅ 完了 |
| 6 | `auto-01-plan.yml` の完成 | 1時間 | ✅ 完了 |
| 7 | 試運転（設計 §9 フェーズ3 の 3-3 / 3-5 / 3-6） | 1時間 | ⬅ **次はここ** |
| 8 | `prompts/` 残り7本（テスト設計〜PM報告） | — | ✅ 完了 |
| 9 | `auto-02-implement.yml` / `auto-03-review-merge.yml` | — | ✅ 完了（**足場のマージ待ち**） |
| 10 | 実装ループの試運転（設計 §9 フェーズ3 の 3-2 / 3-4） | 1時間 | ⬜ 足場が main に入ってから |

> [!WARNING] ~~試運転の前に Environment を1つ追加する~~ → **ラベルを3つ追加する（2026-09-16）**
> ~~低リスクの**30分の異議申立て窓**（設計 §4.1）を Environment の **Wait timer**
> （`gate-low-risk-objection`／Wait timer = 30分）で実現しているため、これが無いと
> 低リスクの Issue が `low-risk-window` で失敗し自動通過せずに止まる。~~
> → **30分の異議窓ごと撤去した。この Environment はもう参照されない**（設計 §4.2）。
> **必須の Environment は `gate-merge` だけ**である。
>
> 代わりに `Settings → Labels` へ**3つのラベルを作る**。無いとワークフローの
> `gh issue edit --add-label` が失敗し、**停止の行き先が分からなくなる**。
>
> | ラベル | 意味 | 誰が解くか |
> | --- | --- | --- |
> | `auto:retry` | 基盤エラー・クレジット切れ | スイーパー（冷却60分） |
> | `auto:waiting-dep` | 上流の作業パッケージ待ち | 上流の完了 |
> | `auto:needs-review` | オーナーの異議。区分によらずゲート3を強制 | オーナー |
>
> 意味と使い分けの根拠は**設計 §5 が正本**。ここに複製しない。

**ここまでで「仕様の曖昧さが選択肢に変換されて返ってくる」状態になる。**

実装ループ（`auto-02` / `auto-03`）も実装済みだが、**動かすには足場が要る**
（設計 §9 フェーズ0-1・§12 #2）。`tests/` `app/` `supabase/` がまだ存在しないため、
テスト設計エージェントには書き込み先が無く、`ci.yml` の Lint・型・E2E も実体を持たない。

> [!IMPORTANT] ゲート3の Environment
> `auto-03` は `gate-merge` で停止する。`Settings → Environments` に
> **`gate-merge`（Required reviewers にオーナー）** が無いと、承認を待たずに素通りする。
> 設計 §9 フェーズ1-1 で作成済みのはずだが、実装ループを回す前に実在を確認すること。

> [!IMPORTANT] 出力先に届かないエージェントがいる
> `readonly.json`（レビュー 5a/5b/5c）は `Bash` を全面拒否し、
> `test.json`（テスト設計）は `gh` を許可していない。
> **この4体は設計 §3 が定める出力先（Issue / PR コメント）へ自力で到達できない。**
>
> 権限を緩めると §3 の権限表が崩れるため、**転記はワークフローが行う**
> （`scripts/post_agent_output.sh` が `claude-code-action` の `execution_file` から
> 最終メッセージを取り出してコメントする）。
> auto-01 の試運転で踏んだ「①権限不足で Issue コメントに到達できない」
> 「③エージェントの編集がランナー内に留まる」と同じ形の不具合を避けるための措置である。

> [!IMPORTANT]
> **手順4（`research.md`）が全体の成否を決める。**
> [設計 §3.2 の質問の作法](../docs/自律開発ループ設計.md)が正しく転記されていないと、
> 「矛盾があります」とだけ言って止まるループになる。試運転 3-5 はそれを検出するためのもの。

---

## 前提となる Secrets

`Settings → Secrets and variables → Actions` に登録する。**値をワークフロー YAML に書かない**（CLAUDE.md §3.2）。

| 名前 | 用途 | 権限 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | 全エージェント | — |
| `AUTOMATION_PAT` | PR 作成・ラベル付け替え | fine-grained PAT。`Contents` / `Pull requests` / `Issues` / `Workflows` を Read and write |

> [!WARNING]
> **`AUTOMATION_PAT` を `GITHUB_TOKEN` で代用しない。**
> `GITHUB_TOKEN` で作成した PR やラベル変更は他のワークフローをトリガしない仕様のため、
> CI が走らず「CI が赤い PR はマージしない」（CLAUDE.md §6.2）が**検証不能なまま素通りする**。
> 詳細は設計 §8.1。

---

## 関連

- [設計の正本](../docs/自律開発ループ設計.md) — 全体フロー・ゲート・エージェント定義・安全制約・運用
- [`CLAUDE.md`](../CLAUDE.md) — 開発ルールの正本。ループもこれに従う
- [`QUESTIONS.md`](../QUESTIONS.md) — 未決事項。ループが停止した時の起票先
- [`LOOP_LOG.md`](../LOOP_LOG.md) — 実行記録
- 公開用テンプレート: [develop_automation](https://github.com/KoshiNakano1017/develop_automation) — 匿名化した汎用版（片方向コピー元）
