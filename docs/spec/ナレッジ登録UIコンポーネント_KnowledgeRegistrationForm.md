---
title: "ナレッジ登録UIコンポーネント（KnowledgeRegistrationForm）"
date: "2026-08-16"
updated: "2026-08-16"
theme: "浮遊街アプリ・FELプロジェクト"
tags: ["浮遊街アプリ", "RAG", "UI", "React", "TailwindCSS", "Phase1"]
status: "参照実装（フロントエンドのみ・API未接続）"
up: "[[浮遊街アプリ 総合要件定義・設計書_v13]]"
---

# ナレッジ登録UIコンポーネント（KnowledgeRegistrationForm）

> [[浮遊街アプリ 総合要件定義・設計書_v13]] §5.7.7「★ ナレッジ登録UIの拡張思想 — タイプ別構造化入力」の参照実装。現場担当者が主語や背景を含むナレッジをスムーズに入力でき、RAGの検索精度を高める構造化データ（JSON＋メタデータ付きテキスト）を生成するためのフロントエンドコンポーネント。

## 位置づけ

- 対象ロール：管理者（`admin`）・コアメンバー（`core_member`）のみ（[[浮遊街アプリ 総合要件定義・設計書_v13]] §5.7.1 に準拠）。
- §5.7.6 の画面モック（テキストUI）を置き換えるものではなく、**実際に動作するコンポーネントとして補完**する位置づけ。
- Phase 1 のスコープは**フォーム入力とJSONプレビューまで**。ベクトルDBへの実送信（API接続）は含まない（送信ボタンはAPI接続後に実装）。
- 「✨ AIで文章を整頓する」ボタンは疑似的な文脈補完・整形サンプルの注入であり、実際のAI API呼び出しは行わない（[[浮遊街アプリ 総合要件定義・設計書_v13]] §5.7.7 ④）。
- `target_audience`（複数選択）と既存 `target_role`（単一値のアクセス制御キー）の整合は未決事項 **#29** として管理する。本実装では `target_role` を配列化する案を暫定採用している。

## 画面構成

| # | 領域 | 内容 |
| --- | --- | --- |
| ① | 登録タイプ選択タブ | Q&A形式／手順（Step-by-Step）形式／トラブル・事例形式 |
| ② | メタデータ設定領域 | 業務領域（domain）／分類カテゴリ（category）／対象者・権限（target_audience）／関連機器・ツール名 |
| ③ | 本文入力領域 | タイプ別可変フォーム（Stepは動的追加・削除） |
| ④ | UXサポート | リアルタイムヒントパネル（⭕良い例／❌悪い例）、「✨AIで文章を整頓する」ボタン |
| ⑤ | 送信・JSONプレビュー | 「ナレッジを登録する」ボタン → 構造化JSONプレビューモーダル |

## 依存関係

- React 18+（Hooksのみ、外部状態管理ライブラリ不使用）
- Tailwind CSS（ビルド設定済みプロジェクトを想定。CDN版でも動作可）
- 外部UIライブラリ非依存（アイコンは絵文字で代用。`crypto.randomUUID` が無い環境向けにフォールバックあり）

## コンポーネントコード

`components/KnowledgeRegistrationForm.jsx` として配置する想定。

```jsx
import React, { useMemo, useState } from "react";

/**
 * ナレッジ登録Web UI画面
 * 浮遊街アプリ 総合要件定義・設計書_v13 §5.7.7 準拠の参照実装
 *
 * - 3つの登録タイプ（Q&A / 手順 / トラブル事例）をタブで切替
 * - 共通メタデータ（業務領域・分類カテゴリ・対象者権限・関連機器名）
 * - タイプ別の可変フォーム（手順はStepを動的に追加・削除）
 * - リアルタイムヒントパネル（⭕良い例／❌悪い例）
 * - 「✨ AIで文章を整頓する」疑似補完ボタン（実AI呼び出しなし）
 * - 送信時にRAG/VectorDB用JSONプレビューをモーダル表示（送信確定はAPI接続後）
 *
 * 依存: React 18+, Tailwind CSS
 * 外部UIライブラリ非依存（アイコンは絵文字で代用）
 */

const REGISTRATION_TYPES = [
  { key: "qa", label: "Q&A形式", icon: "❓", description: "一問一答型のナレッジ" },
  { key: "step", label: "手順（Step-by-Step）", icon: "📋", description: "作業手順・マニュアル" },
  { key: "trouble", label: "トラブル・事例", icon: "🛠️", description: "発生した問題と対処の記録" },
];

const DOMAIN_OPTIONS = ["ホテル予約管理", "飲食・接客", "農業・機器操作", "その他"];
const CATEGORY_OPTIONS = ["システム操作", "クレーム・例外対応", "機械トラブル・メンテナンス"];
const AUDIENCE_OPTIONS = [
  { value: "all_incl_new", label: "全員（新人含む）" },
  { value: "store_admin_only", label: "店舗管理者のみ" },
];

// タイプ別・入力ヒント（⭕良い例 / ❌悪い例）
const HINTS = {
  qa: {
    good: [
      "Q: 「芝刈り機（GX200）のエンジンが始動しないときはどうすればいいですか？」",
      "A: 「GX200は、①燃料コックを『開』にし、②チョークを引いた状態でリコイルスターターを引きます。混合ガソリン（25:1）以外は使用しないでください。」",
    ],
    bad: ["Q: 「動かないんですけど」", "A: 「直してください」／「見ればわかります」"],
  },
  step: {
    good: [
      "タイトル: 「芝刈り機（GX200）始動手順」",
      "Step1: 「燃料コックを『開』（レバーを縦）にする」",
      "前提条件: 「混合ガソリン(25:1)が満タンであること」",
    ],
    bad: [
      "タイトル: 「機械の使い方」（どの機械か不明）",
      "Step1: 「スイッチを押す」（どのスイッチか、何のためか不明）",
    ],
  },
  trouble: {
    good: [
      "発生現象: 「GX200のエンジンが始動直後に停止する」",
      "原因: 「混合ガソリンの配合比率の誤り（25:1ではなく50:1で作成）」",
      "解決手順: 「正しい配合比率(25:1)で燃料を作り直し、キャブレター内の残燃料を抜いてから再始動する」",
    ],
    bad: [
      "発生現象: 「壊れた」",
      "原因: 「わからない」",
      "解決手順: 「業者に電話した」（社内で再現可能な対処手順になっていない）",
    ],
  },
};

const emptyStep = () => ({
  id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()),
  text: "",
});

const initialBodyState = {
  qa: { question: "", answer: "" },
  step: { title: "", prerequisites: "", steps: [emptyStep()] },
  trouble: { symptom: "", cause: "", solution: "" },
};

export default function KnowledgeRegistrationForm() {
  const [activeType, setActiveType] = useState("qa");
  const [metadata, setMetadata] = useState({
    domain: DOMAIN_OPTIONS[0],
    category: CATEGORY_OPTIONS[0],
    targetAudience: [],
    relatedEquipment: "",
  });
  const [body, setBody] = useState(initialBodyState);
  const [showPreview, setShowPreview] = useState(false);
  const [errors, setErrors] = useState([]);

  const hint = HINTS[activeType];

  const updateBody = (type, patch) =>
    setBody((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));

  const toggleAudience = (value) => {
    setMetadata((prev) => {
      const exists = prev.targetAudience.includes(value);
      return {
        ...prev,
        targetAudience: exists
          ? prev.targetAudience.filter((v) => v !== value)
          : [...prev.targetAudience, value],
      };
    });
  };

  // Step-by-step: 動的追加・削除
  const addStep = () => updateBody("step", { steps: [...body.step.steps, emptyStep()] });
  const removeStep = (id) => updateBody("step", { steps: body.step.steps.filter((s) => s.id !== id) });
  const changeStep = (id, text) =>
    updateBody("step", { steps: body.step.steps.map((s) => (s.id === id ? { ...s, text } : s)) });

  // 「✨ AIで文章を整頓する」— 疑似的な文脈補完・整形サンプルの注入（実AI呼び出しなし）
  const handleAiPolish = () => {
    const equipment = metadata.relatedEquipment || "対象の機器・システム";
    if (activeType === "qa") {
      updateBody("qa", {
        question: body.qa.question?.trim() || `${equipment}について、〇〇したいときはどうすればいいですか？`,
        answer:
          `【整頓済み】${equipment}に関する手順は次のとおりです。\n` +
          `1. まず状態を確認します（電源・接続・残量など）。\n` +
          `2. 手順の要点を明確にします：${body.qa.answer?.trim() || "（ここに元の回答が入ります）"}\n` +
          `3. 対応後は結果を確認し、異常があれば運営へ共有してください。`,
      });
    } else if (activeType === "step") {
      updateBody("step", {
        title: body.step.title?.trim() || `${equipment} 操作手順`,
        prerequisites:
          body.step.prerequisites?.trim() || `${equipment}が使用可能な状態であること（燃料・充電・接続を確認）`,
        steps: body.step.steps.map((s, i) => ({
          ...s,
          text: s.text?.trim() || `${equipment}の手順${i + 1}を具体的に記入してください（主語・対象を明記）`,
        })),
      });
    } else {
      updateBody("trouble", {
        symptom: body.trouble.symptom?.trim() || `${equipment}で発生した具体的な症状を記入`,
        cause: body.trouble.cause?.trim() || `【整頓済み】想定される原因（例：設定ミス／消耗品交換忘れ／操作手順の誤り）を記入`,
        solution:
          body.trouble.solution?.trim() ||
          `【整頓済み】1. 状況の切り分け 2. 暫定対応 3. 恒久対応・再発防止策 の順で記入`,
      });
    }
  };

  const validate = () => {
    const errs = [];
    if (!metadata.domain) errs.push("業務領域（domain）を選択してください");
    if (!metadata.category) errs.push("分類カテゴリ（category）を選択してください");
    if (metadata.targetAudience.length === 0) errs.push("対象者・権限を1つ以上選択してください");

    if (activeType === "qa") {
      if (!body.qa.question.trim()) errs.push("質問（Q）を入力してください");
      if (!body.qa.answer.trim()) errs.push("回答（A）を入力してください");
    } else if (activeType === "step") {
      if (!body.step.title.trim()) errs.push("タイトルを入力してください");
      if (body.step.steps.every((s) => !s.text.trim())) errs.push("Stepを1つ以上入力してください");
    } else {
      if (!body.trouble.symptom.trim()) errs.push("発生現象を入力してください");
      if (!body.trouble.cause.trim()) errs.push("原因を入力してください");
      if (!body.trouble.solution.trim()) errs.push("解決手順を入力してください");
    }
    setErrors(errs);
    return errs.length === 0;
  };

  // RAG / Vector DB 送信用の構造化JSON（要件書 §5.7.5 のメタデータ設計に準拠）
  const payload = useMemo(() => buildPayload(activeType, metadata, body), [activeType, metadata, body]);

  const handleSubmit = () => {
    if (!validate()) return;
    setShowPreview(true);
  };

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-emerald-800">🌿 ナレッジ登録</h1>
          <p className="text-sm text-stone-500 mt-1">
            主語・背景を含めて入力すると、AIコンシェルジュの回答精度が上がります。
          </p>
        </header>

        {/* ① 登録タイプ選択タブ */}
        <div className="flex gap-2 mb-6 border-b border-stone-200">
          {REGISTRATION_TYPES.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveType(t.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                activeType === t.key
                  ? "border-emerald-600 text-emerald-700 bg-white"
                  : "border-transparent text-stone-500 hover:text-stone-700"
              }`}
            >
              <span className="mr-1">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* 左カラム：フォーム本体 */}
          <div className="md:col-span-2 space-y-6">
            {/* ② メタデータ設定領域 */}
            <section className="bg-white rounded-xl border border-stone-200 p-5">
              <h2 className="font-semibold text-stone-700 mb-3">メタデータ設定</h2>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">業務領域（domain）</label>
                  <select
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                    value={metadata.domain}
                    onChange={(e) => setMetadata((p) => ({ ...p, domain: e.target.value }))}
                  >
                    {DOMAIN_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">分類カテゴリ（category）</label>
                  <select
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                    value={metadata.category}
                    onChange={(e) => setMetadata((p) => ({ ...p, category: e.target.value }))}
                  >
                    {CATEGORY_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-stone-500 mb-1">
                    対象者・権限（target_audience）
                  </label>
                  <div className="flex flex-wrap gap-4">
                    {AUDIENCE_OPTIONS.map((opt) => (
                      <label key={opt.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="rounded border-stone-300"
                          checked={metadata.targetAudience.includes(opt.value)}
                          onChange={() => toggleAudience(opt.value)}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-stone-500 mb-1">関連機器・ツール名</label>
                  <input
                    type="text"
                    placeholder="例：芝刈り機-GX200"
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                    value={metadata.relatedEquipment}
                    onChange={(e) => setMetadata((p) => ({ ...p, relatedEquipment: e.target.value }))}
                  />
                </div>
              </div>
            </section>

            {/* ③ 本文入力領域（タイプ別可変フォーム） */}
            <section className="bg-white rounded-xl border border-stone-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-stone-700">本文入力</h2>
                <button
                  onClick={handleAiPolish}
                  className="text-xs font-medium px-3 py-1.5 rounded-full bg-violet-100 text-violet-700 hover:bg-violet-200 transition-colors"
                >
                  ✨ AIで文章を整頓する
                </button>
              </div>

              {activeType === "qa" && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">質問（Q）</label>
                    <textarea
                      rows={2}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="例：芝刈り機（GX200）のエンジンが始動しないときはどうすればいいですか？"
                      value={body.qa.question}
                      onChange={(e) => updateBody("qa", { question: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">回答（A）</label>
                    <textarea
                      rows={5}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="結論→手順の順で、主語を省略せずに記入してください"
                      value={body.qa.answer}
                      onChange={(e) => updateBody("qa", { answer: e.target.value })}
                    />
                  </div>
                </div>
              )}

              {activeType === "step" && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">タイトル</label>
                    <input
                      type="text"
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="例：芝刈り機（GX200）始動手順"
                      value={body.step.title}
                      onChange={(e) => updateBody("step", { title: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">前提条件</label>
                    <input
                      type="text"
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="例：混合ガソリン(25:1)が満タンであること"
                      value={body.step.prerequisites}
                      onChange={(e) => updateBody("step", { prerequisites: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">Step</label>
                    <div className="space-y-2">
                      {body.step.steps.map((s, i) => (
                        <div key={s.id} className="flex items-start gap-2">
                          <span className="mt-2 text-xs font-semibold text-emerald-700 w-6">{i + 1}.</span>
                          <textarea
                            rows={1}
                            className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm"
                            placeholder={`Step ${i + 1} の操作内容（誰が・何を・どうするか）`}
                            value={s.text}
                            onChange={(e) => changeStep(s.id, e.target.value)}
                          />
                          <button
                            onClick={() => removeStep(s.id)}
                            disabled={body.step.steps.length === 1}
                            className="mt-1 text-stone-400 hover:text-rose-600 disabled:opacity-30 text-sm px-2"
                            title="このStepを削除"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    <button onClick={addStep} className="mt-2 text-xs font-medium text-emerald-700 hover:text-emerald-900">
                      ＋ Stepを追加
                    </button>
                  </div>
                </div>
              )}

              {activeType === "trouble" && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">発生現象</label>
                    <textarea
                      rows={2}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="例：GX200のエンジンが始動直後に停止する"
                      value={body.trouble.symptom}
                      onChange={(e) => updateBody("trouble", { symptom: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">原因</label>
                    <textarea
                      rows={2}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="例：混合ガソリンの配合比率の誤り（25:1ではなく50:1で作成）"
                      value={body.trouble.cause}
                      onChange={(e) => updateBody("trouble", { cause: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">解決手順</label>
                    <textarea
                      rows={4}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="番号付きで、現場で再現できる粒度で記入してください"
                      value={body.trouble.solution}
                      onChange={(e) => updateBody("trouble", { solution: e.target.value })}
                    />
                  </div>
                </div>
              )}
            </section>

            {errors.length > 0 && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg p-3">
                <p className="font-medium mb-1">入力内容を確認してください：</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* ⑤ 送信ボタン */}
            <div className="flex justify-end">
              <button
                onClick={handleSubmit}
                className="px-6 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors shadow-sm"
              >
                ナレッジを登録する
              </button>
            </div>
          </div>

          {/* 右カラム：④ リアルタイムヒントパネル */}
          <aside className="md:col-span-1">
            <div className="bg-white rounded-xl border border-stone-200 p-5 sticky top-6">
              <h2 className="font-semibold text-stone-700 mb-3">入力ヒント</h2>
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-semibold text-emerald-700 mb-1">⭕ 良い入力例</p>
                  <ul className="space-y-1">
                    {hint.good.map((g, i) => (
                      <li key={i} className="text-xs text-stone-600 bg-emerald-50 rounded-md p-2">
                        {g}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold text-rose-600 mb-1">❌ 悪い入力例</p>
                  <ul className="space-y-1">
                    {hint.bad.map((b, i) => (
                      <li key={i} className="text-xs text-stone-600 bg-rose-50 rounded-md p-2">
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="text-[11px] text-stone-400 leading-relaxed pt-2 border-t border-stone-100">
                  ポイント：「これ／それ」等の指示語を避け、主語（誰が・何を）と背景（いつ・どんな状況で）を明記してください。
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* ⑤ JSONプレビューモーダル */}
      {showPreview && <JsonPreviewModal payload={payload} onClose={() => setShowPreview(false)} />}
    </div>
  );
}

function JsonPreviewModal({ payload, onClose }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(payload, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // クリップボードAPI非対応環境ではコピー不可。無視して継続。
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200">
          <h3 className="font-semibold text-stone-800">📦 RAG登録用 JSON プレビュー（Vector DB Metadata）</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700">
            ✕
          </button>
        </div>
        <div className="p-5 overflow-auto flex-1">
          <pre className="bg-stone-900 text-emerald-300 text-xs rounded-lg p-4 overflow-auto">
            <code>{json}</code>
          </pre>
        </div>
        <div className="px-5 py-4 border-t border-stone-200 flex justify-end gap-2">
          <button
            onClick={handleCopy}
            className="px-4 py-2 text-sm rounded-lg border border-stone-300 text-stone-600 hover:bg-stone-50"
          >
            {copied ? "コピーしました" : "JSONをコピー"}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-emerald-700 text-white hover:bg-emerald-800">
            閉じる（登録確定はAPI接続後に実装）
          </button>
        </div>
      </div>
    </div>
  );
}

// target_audience（UI用チェックボックス値）→ target_role（既存仕様・§5.7.2/§5.7.5のアクセス制御キー）への変換
// ★ 複数選択を許容するため、target_role は単一値ではなく配列として扱う設計とする（要件書 §9 #29）
function mapAudienceToTargetRole(targetAudience) {
  const roles = new Set();
  targetAudience.forEach((v) => {
    if (v === "all_incl_new") {
      roles.add("guest");
      roles.add("member");
    }
    if (v === "store_admin_only") {
      roles.add("core_member");
    }
  });
  return Array.from(roles);
}

function buildPayload(type, metadata, body) {
  const contentByType = {
    qa: { question: body.qa.question, answer: body.qa.answer },
    step: {
      title: body.step.title,
      prerequisites: body.step.prerequisites,
      steps: body.step.steps.filter((s) => s.text.trim()).map((s, i) => ({ order: i + 1, text: s.text })),
    },
    trouble: { symptom: body.trouble.symptom, cause: body.trouble.cause, solution: body.trouble.solution },
  };

  const embeddingSourceText = {
    qa: `Q: ${body.qa.question}\nA: ${body.qa.answer}`,
    step:
      `${body.step.title}\n前提条件: ${body.step.prerequisites}\n` +
      body.step.steps.map((s, i) => `${i + 1}. ${s.text}`).join("\n"),
    trouble: `発生現象: ${body.trouble.symptom}\n原因: ${body.trouble.cause}\n解決手順: ${body.trouble.solution}`,
  }[type];

  return {
    type, // "qa" | "step" | "trouble"
    metadata: {
      domain: metadata.domain,
      category: metadata.category,
      target_audience: metadata.targetAudience,
      related_equipment: metadata.relatedEquipment || null,
    },
    content: contentByType[type],
    rag_metadata: {
      target_role: mapAudienceToTargetRole(metadata.targetAudience), // 要件書 §5.7.5 準拠（配列化案）
      category_id: null, // 業務カテゴリマスタ（15ドメイン）への正式マッピングは運用時に付与
      usage_scene: [],
      keywords: metadata.relatedEquipment ? [metadata.relatedEquipment] : [],
      agent_type: null,
      review_status: "draft",
      embedding_source_text: embeddingSourceText,
    },
    created_at: new Date().toISOString(),
  };
}
```

## 未実装・要検討事項

| # | 内容 | 対応方針 |
| --- | --- | --- |
| 1 | ベクトルDBへの実送信（API接続） | Phase 1のUI単体ではプレビューまで。バックエンドAPI（Supabase Edge Function等）確定後に接続する |
| 2 | 「✨ AIで文章を整頓する」の実AI化 | 現状は疑似的な整形サンプル注入。実装する場合は既存のGemini API呼び出し（朝会パイプライン／§5.7.4）への相乗りを検討 |
| 3 | `target_audience`（複数選択）と `target_role`（単一値）の整合 | 要件書 §9 #29 で管理。本実装は `target_role` を配列化する暫定案 |
| 4 | `domain` / `category` と既存 15業務ドメインマスタ・`category_id` の正式マッピング | [[業務カテゴリ体系とAIエージェント設計]] 側の確定を待って対応表を作成する |
| 5 | 添付ファイル（画像・PDF）のアップロード | §5.7.2 STEP4に既存の補足添付要件があるが、本コンポーネントには未実装（Cloud Storage for Firebase連携が前提のため） |

## 関連ノート

- [[浮遊街アプリ 総合要件定義・設計書_v13]]（§5.7 ナレッジ登録画面）
- [[RAGシステム仕様]]（Recipeマスタ・failure_patterns・現場ナレッジカード）
- [[業務カテゴリ体系とAIエージェント設計]]
- [[HTMLモック_v13]]
