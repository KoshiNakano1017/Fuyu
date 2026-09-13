// 完了条件の受け渡し（設計 §10.1.3 条件3 の補遺）の単体テスト。
//
// ここで固定したいのは1点に尽きる:
//   **`wbs-to-issue.yml` が作る穴埋めのままの完了条件を「記入済み」と誤認しないこと。**
// 誤認すると、角括弧のプレースホルダ（`- [ ] 〔「〜が〜できる」の形で、検証可能に書く〕`）が
// そのまま受入基準になり、実装もレビューもそれを正しいものとして通す。
// 誰も気づけない種類の事故なので、機械で固定する（CLAUDE.md §4.4）。

import {
  section,
  stripTemplate,
  hasDerived,
  formatApproved,
  acceptanceRows,
} from '../automation/orchestrator/lib/acceptance.mjs';

/** wbs-to-issue.yml が生成する Issue 本文（オーナーが未記入の状態）。 */
const ISSUE_BODY_UNFILLED = [
  '> [!note] この Issue は `WBS_Phase1.md` から自動生成されました',
  '',
  '## 目的',
  '',
  'Uii換算ロジック',
  '',
  '## 根拠となる仕様',
  '',
  'v13 §5.5',
  '',
  '## 完了条件',
  '',
  '<!-- ⚠️ ここは自動で埋まりません。オーナーが記入してください。 -->',
  '<!-- WBS には検証可能な完了条件が書かれていないため、機械が考案すると -->',
  '',
  '- [ ] 〔「〜が〜できる」の形で、検証可能に書く〕',
  '',
  '## スコープ外',
  '',
  '- 〔今回やらないことを明示する〕',
  '',
  '## 想定サイズ',
  '',
  'S',
].join('\n');

describe('section(): Issue 本文から節を取り出す', () => {
  it('完了条件の節だけを取り出す', () => {
    const got = section(ISSUE_BODY_UNFILLED, '完了条件');
    expect(got).toContain('〔「〜が〜できる」の形で、検証可能に書く〕');
    expect(got).not.toContain('スコープ外');
    expect(got).not.toContain('Uii換算ロジック');
  });

  it('CRLF の本文でも取り出せる', () => {
    const crlf = ISSUE_BODY_UNFILLED.replace(/\n/g, '\r\n');
    expect(section(crlf, '完了条件')).toContain('検証可能に書く');
  });

  it('存在しない見出しは空を返す', () => {
    expect(section(ISSUE_BODY_UNFILLED, '存在しない節')).toBe('');
  });
});

describe('stripTemplate(): 未記入と記入済みを区別する', () => {
  it('⭐ 穴埋めのままの完了条件は「空」と判定される（＝エージェントが導出に入る）', () => {
    const raw = section(ISSUE_BODY_UNFILLED, '完了条件');
    expect(raw).not.toBe(''); // 素のままでは中身があるように見える
    expect(stripTemplate(raw)).toBe(''); // 雛形を落とすと空になる
  });

  it('⭐ エージェント／オーナーが書き込んだ完了条件は残る', () => {
    const filled = [
      '- [ ] 単価1,000円が800Uiiに換算される（v13 §5.5.2）',
      '- [ ] 全画面が Money コンポーネント経由で表示される（v13 §9 #51）',
    ].join('\n');
    const got = stripTemplate(filled);
    expect(got).toContain('800Uiiに換算される');
    expect(got).toContain('Money コンポーネント');
  });

  it('一部だけ書き換えた場合、実際に書かれた行だけが残る', () => {
    const partial = [
      '- [ ] 〔「〜が〜できる」の形で、検証可能に書く〕',
      '- [ ] 「CB」表記が全廃されている',
    ].join('\n');
    expect(stripTemplate(partial)).toBe('- [ ] 「CB」表記が全廃されている');
  });

  it('HTML コメントだけの節は空になる', () => {
    expect(stripTemplate('<!-- ⚠️ ここは自動で埋まりません。 -->')).toBe('');
  });

  it('チェック済み `- [x]` の行も中身として残す', () => {
    expect(stripTemplate('- [x] 宿泊券が4枚付与されている')).toContain('宿泊券が4枚');
  });
});

describe('完了条件の出どころ（origin）の扱い', () => {
  const acceptance = [
    { criterion: 'ゲストは受注できない', origin: 'issue' as const, test: 'tests/q.spec.ts:拒否' },
    {
      criterion: '単価1,000円が800Uiiに換算される',
      origin: 'derived' as const,
      basis: 'v13 §5.5.2',
      test: 'tests/uii.spec.ts:換算',
    },
  ];

  it('導出が1件でもあれば検知する', () => {
    expect(hasDerived(acceptance)).toBe(true);
    expect(hasDerived([{ criterion: 'a', origin: 'issue' as const }])).toBe(false);
    expect(hasDerived([])).toBe(false);
    expect(hasDerived(undefined)).toBe(false);
  });

  it('テスト設計へ渡す文に、出どころと根拠が必ず含まれる', () => {
    const got = formatApproved(acceptance);
    expect(got).toContain('出どころ: タスク定義');
    expect(got).toContain('出どころ: 導出');
    expect(got).toContain('根拠: v13 §5.5.2');
  });

  it('⭐ 根拠の無い導出は表で警告として目立つ（承認の判断材料になるため）', () => {
    const rows = acceptanceRows([{ criterion: '推測で書いた条件', origin: 'derived' as const }]);
    expect(rows[0]).toContain('**導出**');
    expect(rows[0]).toContain('⚠️ 根拠なし');
  });

  it('タスク定義由来の行は導出として表示されない', () => {
    const rows = acceptanceRows([{ criterion: '書かれていた条件', origin: 'issue' as const }]);
    expect(rows[0]).toContain('タスク定義');
    expect(rows[0]).not.toContain('**導出**');
  });
});

describe('⭐ 全体の流れ: 穴埋め → 導出発動 → 書き込まれる', () => {
  it('未記入の Issue は「導出が必要」と判定され、導出後は完了条件が埋まる', () => {
    // 1. wbs-to-issue.yml が作った直後 — 完了条件は穴埋めのまま
    const fromIssue = stripTemplate(section(ISSUE_BODY_UNFILLED, '完了条件'));
    expect(fromIssue).toBe('');

    // 2. 承認済みも無い → テスト設計が調査結果から導出する条件が揃う
    const approvedBefore = formatApproved([]);
    expect(approvedBefore).toBe('');

    // 3. エージェント（pm-plan / test-design）が調査結果から導出した結果
    const derived = [
      { criterion: '単価1,000円が800Uiiに換算される', origin: 'derived' as const, basis: 'v13 §5.5.2' },
    ];

    // 4. 完了条件が埋まり、根拠つきでテスト設計へ渡る
    const approvedAfter = formatApproved(derived);
    expect(approvedAfter).not.toBe('');
    expect(approvedAfter).toContain('800Uiiに換算される');
    expect(approvedAfter).toContain('v13 §5.5.2');
    expect(hasDerived(derived)).toBe(true); // → Issue へ掲示され、人間が承認する
  });
});
