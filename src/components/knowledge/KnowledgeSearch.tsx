"use client";

import { useActionState } from "react";

import { similarityLabel, sourceTypeLabel } from "@/lib/knowledge/search";

import {
  INITIAL_KNOWLEDGE_SEARCH,
  searchKnowledgeAction,
  type KnowledgeSearchState,
} from "@/app/staff/knowledge/actions";

/**
 * 横断セマンティック検索（WBS 9-1 ／ 画面は `/staff/knowledge` に同居）。
 *
 * ## チャットではない
 *
 * v13 §9 #31 は「本体はエンドユーザー向け AI チャット UI を持たない」を維持している。
 * ここは**語句を入れて索引を引く検索**であり、会話の体裁（吹き出し・履歴・追問）を持たせない。
 * 体裁をチャットに寄せると、方針の上で作らないと決めたものを作ったことになる。
 *
 * ## 出すのは伏字化後の本文だけ
 *
 * `knowledge_chunks.chunk_text` は伏字化後のテキストしか持たない（`0100`）。
 * 画面側で投影元の生テキストを引き直して並べない。**そうすると伏字化が無意味になる。**
 *
 * ## 類似度を数字で出す理由
 *
 * 上位に並んだからといって関連があるとは限らない（ベクトル検索は必ず何かを返す）。
 * 類似度を添えると「これは遠い」と運営が判断できる。**閾値で切って隠さない**のは、
 * 何が切られたか分からない状態を作らないためである。
 */
export function KnowledgeSearch() {
  const [state, submit] = useActionState<KnowledgeSearchState, FormData>(
    searchKnowledgeAction,
    INITIAL_KNOWLEDGE_SEARCH,
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold">横断検索</h2>
        <p className="text-sm text-neutral-600">
          写真・朝会議事録・作業ログ・クエストを横断して、意味の近いものを探します。
          クエストの起票・評価で「前に似たことをやっていないか」を確かめるための機能です。
        </p>
      </div>

      <form action={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          探したいこと
          <input
            type="text"
            name="query"
            required
            defaultValue={state.query}
            placeholder="例: 薪の乾かし方"
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
          検索する
        </button>
      </form>

      {state.message ? <p className="text-sm text-red-700">{state.message}</p> : null}

      {state.status === "done" ? (
        state.hits.length === 0 ? (
          <p className="text-sm text-neutral-600">
            近いものは見つかりませんでした。索引に入っていない題材かもしれません。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.hits.map((hit) => (
              <li
                key={hit.chunkId}
                className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-neutral-600">
                  <span className="rounded bg-neutral-100 px-2 py-0.5">
                    {sourceTypeLabel(hit.sourceType)}
                  </span>
                  <span>近さ {similarityLabel(hit.similarity)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{hit.chunkText}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
