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
| `automation/settings/` | エージェントごとの権限設定4本 | 同上 |
| `.github/workflows/` | ワークフロー3本 | **GitHub の仕様で位置が固定**されている |
| `.github/ISSUE_TEMPLATE/` | Issue テンプレート | 同上 |
| `docs/` | 仕様書（正本）・設計 | ループが読む対象。**ループは書き換えない**（§8.2） |
| ルート | アプリのソース | ループが書く対象 |

---

## 実装状況

| 区分 | ファイル | 状態 | 備考 |
| --- | --- | --- | --- |
| **権限設定** | `settings/readonly.json` | 🟡 未検証 | 記法の実機確認が必要（設計 §12 #5） |
| | `settings/pm.json` | 🟡 未検証 | 同上 |
| | `settings/test.json` | 🟡 未検証 | 同上 |
| | `settings/code.json` | 🟡 未検証 | 同上 |
| **ワークフロー** | `.github/workflows/auto-01-plan.yml` | 🟢 骨子 | 計画フェーズ。**足場が無くても動く** |
| | `.github/workflows/auto-02-implement.yml` | 🔴 未着手 | 実装フェーズ |
| | `.github/workflows/auto-03-review-merge.yml` | 🔴 未着手 | **最重量**（レビュー3並列＋修正ループ＋リトライ判定＋仕様書ガード） |
| **プロンプト** | `prompts/*.md` | 🔴 未着手 | 10本。[書き方](prompts/README.md) |
| **Issue テンプレ** | `.github/ISSUE_TEMPLATE/auto-task.yml` | 🟢 完成 | 起票3条件を必須フィールド化 |

---

## 着手順序

**計画ループ（`auto-01`）だけを先に完成させると、足場が無くても動き始める。**
計画フェーズのエージェントは Issue にコメントするだけでコードに触らないため。

| 順 | やること | 目安 | 前提 |
| --- | --- | --- | --- |
| 1 | GitHub の器（PAT・Environments・ラベル・通知） | 45分 | なし。**設計 §9 フェーズ1** |
| 2 | `settings/readonly.json` `pm.json` の実機検証 | 1時間 | 1 |
| 3 | `prompts/pm-define.md` | 1時間 | — |
| 4 | **`prompts/research.md`** | 1.5時間 | — |
| 5 | `prompts/pm-plan.md` | 1時間 | — |
| 6 | `auto-01-plan.yml` の完成 | 1時間 | 2〜5 |
| 7 | 試運転（設計 §9 フェーズ3 の 3-3 / 3-5 / 3-6） | 1時間 | 6 |

**ここまでで「仕様の曖昧さが選択肢に変換されて返ってくる」状態になる。**
実装ループ（`auto-02` / `auto-03` と残りプロンプト7本）は足場が出来てから。

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
