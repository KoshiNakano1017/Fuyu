# 開発自動化（自律開発ループ）

**このディレクトリはアプリのソースコードでも仕様書でもない。** 開発プロセスを回すための構成物である。

| 見たいもの | 行き先 |
| --- | --- |
| **設計の正本**（なぜこう組んだか） | [`docs/自律開発ループ設計.md`](../docs/自律開発ループ設計.md) |
| 実装状況・着手順序 | このファイルの下部 |
| プロンプトの書き方 | [`prompts/README.md`](prompts/README.md) |
| 権限設定の意図 | [設計 §7.2](../docs/自律開発ループ設計.md) |

> [!IMPORTANT]
> **設計の内容をこのファイルに複製しない。** CLAUDE.md §1.1 の二重管理禁止に抵触する。
> ここに書くのは「どこに何があるか」と「今どこまで出来ているか」だけ。

---

## ディレクトリの分け方

開発自動化は、アプリのソース・仕様書と**混ざらないよう分離してある**。

| 場所 | 中身 | なぜそこか |
| --- | --- | --- |
| `automation/prompts/` | エージェントのプロンプト10本 | 任意の場所でよいので、自動化を1箇所に集約 |
| `automation/settings/` | エージェントごとの権限設定5本 | 同上 |
| `automation/scripts/` | ワークフローから呼ぶスクリプト | YAML に長い処理を埋めると読めず、手元で検証もできないため分離 |
| `.github/workflows/` | ワークフロー6本 | **GitHub の仕様で位置が固定**されている |
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
| **ワークフロー** | `.github/workflows/auto-01-plan.yml` | 🟢 完成 | 計画フェーズ。§4.1 のリスク分岐・停止・異議申立て窓まで実装。**足場が無くても動く** |
| | `.github/workflows/auto-02-implement.yml` | 🟢 完成 | 実装フェーズ。テスト設計 → 実装 → PR。ゲートなし（設計 §6）。**足場が必要** |
| | `.github/workflows/auto-03-review-merge.yml` | 🟢 完成 | **最重量**（レビュー3並列＋修正ループ＋リトライ判定＋仕様書ガード＋ゲート3）。**足場が必要** |
| **プロンプト** | `prompts/pm-define.md` | 🟢 完成 | タスク定義＋リスク区分の判定 |
| | `prompts/research.md` | 🟢 完成 | 調査。§3.2 の6軸と質問形式を転記済み |
| | `prompts/pm-plan.md` | 🟢 完成 | 段取り＋`QUESTIONS.md` への起票 |
| | `prompts/test-design.md` | 🟢 完成 | 仕様だけを見て受入テストを先に書く（設計 §11.6 の commit-first） |
| | `prompts/coding.md` | 🟢 完成 | 実装。テストと `docs/spec/` は書き換えない |
| | `prompts/review-quality.md` | 🟢 完成 | レビュー 5a。バグ・認可漏れ・CLAUDE.md §4 |
| | `prompts/review-spec.md` | 🟢 完成 | レビュー 5b。**差分を読む前に仕様から要件を列挙する2段構造**（設計 §11.6） |
| | `prompts/review-privacy.md` | 🟢 完成 | レビュー 5c。**最後の防波堤**。ダミーデータでは止めない（2026-09-05 オーナー決定） |
| | `prompts/fix.md` | 🟢 完成 | 修正。振る舞いが変わるなら直さず止まる（設計 §7.1） |
| | `prompts/pm-report.md` | 🟢 完成 | 報告。`LOOP_LOG.md` へ §10.9 の指標の**素材**を記録する |
| **スクリプト** | `scripts/post_agent_output.sh` | 🟢 完成 | エージェントの最終メッセージを Issue / PR へ転記する（下記「出力先に届かないエージェント」） |
| **Issue テンプレ** | `.github/ISSUE_TEMPLATE/auto-task.yml` | 🟢 完成 | 起票3条件を必須フィールド化 |
| **起票導線** | `.github/workflows/wbs-to-issue.yml` | 🟢 完成 | **導線1（§10.1.5）**。WBS の作業パッケージ番号を渡すと Issue を生成。手動起動 |
| | `automation/scripts/wbs_to_issue.py` | 🟢 完成 | 上記のパーサ。`python3 automation/scripts/wbs_to_issue.py 3-5b` で手元検証できる |
| | 導線2（仕様ナビ）・導線3（QUESTIONS.md からの逆流） | 🔴 未着手 | 設計 §10.1.5 |

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

> [!IMPORTANT] 調査の権限 — `readonly.json` を調査に使わない
> `readonly.json` は `Bash` を全面拒否するため、これを調査エージェントに与えると
> **設計 §3 が定める出力先（Issue コメント）に到達できず、調査メモが消える**。
> 調査には `research.json`（読み取り＋`gh issue comment` のみ）を使う。
>
> `QUESTIONS.md` への起票とラベル操作は調査の権限外であり、**次に動く PM（段取り）が引き継ぐ**。
> ラベル遷移はワークフローがマーカー（`<!--blocked-->` / `<!--risk:*-->`）を読んで行う。

---

## 着手順序

**計画ループ（`auto-01`）だけを先に完成させると、足場が無くても動き始める。**
計画フェーズのエージェントは Issue にコメントするだけでコードに触らないため。

| 順 | やること | 目安 | 状態 |
| --- | --- | --- | --- |
| 1 | GitHub の器（PAT・Environments・ラベル・通知） | 45分 | ✅ 完了（設計 §9 フェーズ1） |
| 2 | `settings/*.json` の実機検証 | 1時間 | ⬜ **試運転 3-3 で確認する**（設計 §12 #5） |
| 3 | `prompts/pm-define.md` | 1時間 | ✅ 完了 |
| 4 | **`prompts/research.md`** | 1.5時間 | ✅ 完了 |
| 5 | `prompts/pm-plan.md` | 1時間 | ✅ 完了 |
| 6 | `auto-01-plan.yml` の完成 | 1時間 | ✅ 完了 |
| 7 | 試運転（設計 §9 フェーズ3 の 3-3 / 3-5 / 3-6） | 1時間 | ⬅ **次はここ** |
| 8 | `prompts/` 残り7本（テスト設計〜PM報告） | — | ✅ 完了 |
| 9 | `auto-02-implement.yml` / `auto-03-review-merge.yml` | — | ✅ 完了（**足場のマージ待ち**） |
| 10 | 実装ループの試運転（設計 §9 フェーズ3 の 3-2 / 3-4） | 1時間 | ⬜ 足場が main に入ってから |

> [!WARNING] 試運転の前に Environment を1つ追加する
> 低リスクの**30分の異議申立て窓**（設計 §4.1）は、`sleep` ではなく
> Environment の **Wait timer** で実現している（待機中に Actions の実行時間を消費しないため）。
>
> `Settings → Environments` に **`gate-low-risk-objection`** を作り、
> **Wait timer = 30 分／Required reviewers なし**を設定する。
> これが無いと低リスクの Issue が `low-risk-window` で失敗し、
> **自動通過せずに止まる**（安全側には倒れるが、試運転 3-1 が再現しない）。

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
