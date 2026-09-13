// 完了条件（受入基準）まわりの純粋関数（設計 §10.1.3 条件3 の補遺）。
//
// ここに切り出したのは、オーケストレータ本体（plan.mjs / implement.mjs）が
// 起動と同時に走るスクリプトで、**読み込むだけで副作用が出るため単体テストできない**から。
// 判定ロジックだけを純粋関数として分離し、tests/acceptance.test.ts が検証する。
//
// 「完了条件が未記入か」を機械が正しく判定できることが、この機能の要である。
// ここを誤ると、穴埋めの角括弧がそのまま受入基準になる（＝誰も気づけない事故）。

/**
 * Markdown から `## 見出し` のブロックを1つ取り出す。
 * 次の同レベル見出し（`## ` / `### `）または文末までを返す。
 */
export function section(markdown, heading) {
  if (!markdown) return '';
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,3}\s/.test(l) && l.includes(heading));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{2,3}\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * 未記入のテンプレートを「空」として扱えるよう、雛形の痕跡を落とす。
 *
 * `wbs-to-issue.yml` が生成する Issue の「完了条件」は、オーナーが埋めるまで
 *   <!-- ⚠️ ここは自動で埋まりません。 -->
 *   - [ ] 〔「〜が〜できる」の形で、検証可能に書く〕
 * のままである。これをそのまま渡すと、テスト設計は**穴埋め用の角括弧を
 * 完了条件だと解釈しうる**。「未記入」と「記入済み」を機械が区別できることが、
 * 導出を発動させるかどうかの分かれ目になる。
 */
export function stripTemplate(text) {
  if (!text) return '';
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, '') // HTML コメント（雛形の注意書き）
    .split(/\r?\n/)
    .filter((line) => {
      const bare = line.replace(/^[\s>*-]*(\[[ xX]\])?/, '').trim();
      if (!bare) return false;
      // 〔…〕だけの行は穴埋めプレースホルダ。中身ではない。
      return !/^[〔［(][\s\S]*[〕］)]$/.test(bare);
    })
    .join('\n')
    .trim();
}

/** 完了条件が1件でも「導出」かどうか。 */
export function hasDerived(acceptance) {
  return (acceptance ?? []).some((a) => a.origin === 'derived');
}

/** テスト設計へ渡す、承認済み完了条件の1行表現。 */
export function formatApproved(acceptance) {
  return (acceptance ?? [])
    .map(
      (a, i) =>
        `${i + 1}. ${a.criterion}（出どころ: ${a.origin === 'derived' ? '導出' : 'タスク定義'}／根拠: ${a.basis ?? '—'}）`,
    )
    .join('\n');
}

/** Issue へ掲示する表の行。根拠が無い導出は目立たせる（承認の判断材料になるため）。 */
export function acceptanceRows(acceptance) {
  return (acceptance ?? []).map((a, i) => {
    const origin = a.origin === 'derived' ? '**導出**' : 'タスク定義';
    const basis = a.basis ?? (a.origin === 'derived' ? '⚠️ 根拠なし' : '—');
    return `| ${i + 1} | ${a.criterion} | ${origin} | ${basis} | ${a.test ?? '—'} |`;
  });
}
