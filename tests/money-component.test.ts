// 通貨表示の共通コンポーネント `Money` の受入テスト（Issue #13 ／ WBS `0-1` 通貨表示の共通コンポーネント化）。
//
// 固定する完了条件（Issue #13 の本文そのまま）:
//  1 Uii の金額が円の金額より大きいフォントサイズで表示される
//  2 円の金額が Uii より淡い色（コントラストの低い色）で表示される
//  3 円の併記が消えていない（旅館業法対応・現金精算のため円表記は必須）
//  4 `toUii` が返す換算結果が変更前と一致する（`tests/uii.test.ts` が変更なしで通る）
//
// 根拠: v13 §5.5「★ 通貨併記の原則」とその実装上の注意
//       （「フォントサイズ・色のコントラストでも主副を表現する」「円は併記を維持する」）。
//
// ## DOM を使わずに要素ツリーを見ている理由
//
// 本リポジトリの Jest は `testEnvironment: "node"` であり（`jest.config.mjs`）、
// jsdom も `@testing-library` も入っていない。`Money` は副作用のない関数なので、
// **返り値の React 要素をそのまま辿れば**クラス名と並び順を検査できる。
// 描画のためだけに jsdom を足すより、依存を増やさないこちらを採る（CLAUDE.md §4.4）。

import type { ReactElement } from "react";

import { Money } from "@/components/ui/Money";
import { toUii } from "@/lib/uii";

type ElementLike = { props: { className?: string; children?: unknown } };

/** 子要素を配列で取り出す（1つでも配列でも同じ形で扱う）。 */
function childrenOf(element: ElementLike): ElementLike[] {
  const children = element.props.children;
  return (Array.isArray(children) ? children : [children]).filter(
    (child): child is ElementLike =>
      typeof child === "object" && child !== null && "props" in child,
  );
}

/** 要素配下のテキストを連結する。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (typeof node === "object" && "props" in (node as ElementLike)) {
    return textOf((node as ElementLike).props.children);
  }
  return "";
}

function renderMoney(priceYen: number): { uii: ElementLike; yen: ElementLike; text: string } {
  const element = Money({ priceYen }) as unknown as ElementLike;
  const parts = childrenOf(element);
  expect(parts).toHaveLength(2);
  return { uii: parts[0], yen: parts[1], text: textOf(element as unknown as ReactElement) };
}

describe("主副を見た目で表す（v13 §5.5 の実装上の注意）", () => {
  test("円は Uii より小さい文字で表示される", () => {
    const { uii, yen } = renderMoney(3000);
    // 円だけに一段小さいサイズを与える。主表示（Uii）は埋め込み先の大きさをそのまま継ぐ。
    expect(yen.props.className).toContain("text-[0.8em]");
    expect(uii.props.className ?? "").not.toContain("text-[");
  });

  test("円は Uii より淡い色で表示される", () => {
    const { uii, yen } = renderMoney(3000);
    expect(yen.props.className).toContain("text-neutral-500");
    // 主表示に淡い色を付けない（付けると主副のコントラストが消える）。
    expect(uii.props.className ?? "").not.toContain("text-neutral-");
  });

  test("Uii 側は太字で主表示だと分かる", () => {
    const { uii } = renderMoney(3000);
    expect(uii.props.className).toContain("font-semibold");
  });

  test("★ 文字サイズを絶対値で指定していない（埋め込み先で主副が逆転しないこと）", () => {
    // `text-xs` 等の絶対値を置くと、`text-sm` の一覧の中では円が本文より大きくなる。
    const { uii, yen } = renderMoney(3000);
    for (const size of ["text-xs", "text-sm", "text-base", "text-lg"]) {
      expect(uii.props.className ?? "").not.toContain(size);
      expect(yen.props.className ?? "").not.toContain(size);
    }
  });
});

describe("円の併記を消さない（旅館業法・現金精算 ／ v13 §5.5）", () => {
  test("円が括弧つきで併記される", () => {
    expect(renderMoney(3000).text).toContain("（¥3,000）");
  });

  test("表記順は Uii → 円である（2026-08-20 の逆転 ／ §9 #41）", () => {
    const { text } = renderMoney(3000);
    expect(text.indexOf("Uii")).toBeLessThan(text.indexOf("¥"));
  });

  test("桁区切りが入る", () => {
    expect(renderMoney(120000).text).toContain("96,000 Uii");
  });
});

describe("換算ロジックは変えない（Issue #13 スコープ外 ／ v13 §5.5）", () => {
  test("表示する Uii は toUii() の戻り値そのままである", () => {
    for (const priceYen of [0, 1, 999, 1900, 3000, 30000]) {
      expect(renderMoney(priceYen).text).toContain(`${toUii(priceYen).toLocaleString("ja-JP")} Uii`);
    }
  });

  test("単品ごとの floor(単価 × 0.8) が保たれている", () => {
    // 合計に 0.8 を掛ける方式へ変わっていないことの歯止め（§5.5 の端数処理）。
    expect(toUii(999)).toBe(799);
    expect(toUii(1900)).toBe(1520);
  });
});
