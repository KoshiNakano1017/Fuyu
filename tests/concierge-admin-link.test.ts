// 浮遊街コンシェルジュ（line-rag-bot）管理画面への外部リンクの受入テスト
// （WBS `9-2` line-rag-bot管理画面への導線（外部リンクのみ）／ Issue #94）。
//
// 固定する完了条件:
//   完了条件1 ボタンの文言（v13 §5.9.1「ナレッジ登録フォーム（§5.7）」行 ／ 画面設計.md §4 B9）
//   完了条件2 別タブで開く（`target="_blank"` ＋ `rel="noopener noreferrer"`）
//   完了条件4 URL が未設定・開けない値ならボタンそのものを描画しない（v13 §5.9.5「空振りの禁止」）
//
// JSX を書かずに、コンポーネント関数を直接呼んで返り値の React 要素を検査する。
// jest の `testEnvironment` は `node`（`jest.config.mjs`）で DOM が無いため、
// レンダラに依存しない形にしてある。Server Component 化されて Promise を返しても
// 通るよう、呼び出し結果は常に `await` する。
//
// 実装側への前提（このテストが固定する口）:
//   - `src/lib/concierge/admin-link.ts` が `readConciergeAdminUrl(): string | null` を公開する
//   - `src/components/concierge/ConciergeAdminLink.tsx` が同名の関数を公開し、
//     **引数なしで呼べる**（props は任意）。描画しない場合は `null` を返す

import { ConciergeAdminLink } from "@/components/concierge/ConciergeAdminLink";
import { readConciergeAdminUrl } from "@/lib/concierge/admin-link";

/** 検査対象の最小形。React の型はバージョンで props の型付けが揺れるため、ここで受け皿を定義する。 */
type RenderedAnchor = {
  type: string;
  props: { href?: string; target?: string; rel?: string; children?: unknown };
};

/** 環境変数を書き換えるため、実行後に必ず元へ戻す（`tests/supabase-env.test.ts` と同じ手当て）。 */
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

/** `NEXT_PUBLIC_CONCIERGE_ADMIN_URL` を与えたうえでリンクを描画する。 */
async function renderLinkWithUrl(url: string | undefined): Promise<RenderedAnchor | null> {
  if (url === undefined) {
    delete process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL;
  } else {
    process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL = url;
  }
  return (await ConciergeAdminLink()) as unknown as RenderedAnchor | null;
}

/** 要素ツリーの文字列だけを連結する（ボタンの文言の照合用）。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return children === undefined ? "" : textOf(children);
}

const VALID_ADMIN_URL = "https://concierge.example.invalid/admin";

describe("readConciergeAdminUrl（完了条件4 ／ v13 §5.9.5 空振りの禁止）", () => {
  test("管理画面 URL が設定されていればその値を返す", () => {
    process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL = VALID_ADMIN_URL;
    expect(readConciergeAdminUrl()).toBe(VALID_ADMIN_URL);
  });

  test("管理画面 URL が未設定なら null を返す", () => {
    // 例外にしない。URL 未設定は「導線を出さない」だけであり、
    // 店員タブレットの他の機能を巻き込んで落とす理由が無い
    // （`RAG基盤_line-rag-bot概要.md` §2-1 の逆方向リンク `PARENT_APP_URL` と同じ扱い）。
    delete process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL;
    expect(readConciergeAdminUrl()).toBeNull();
  });

  test("管理画面 URL が空文字なら未設定として扱い null を返す", () => {
    process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL = "";
    expect(readConciergeAdminUrl()).toBeNull();
  });

  test("管理画面 URL が空白のみなら未設定として扱い null を返す", () => {
    process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL = "   ";
    expect(readConciergeAdminUrl()).toBeNull();
  });

  test("URL として解釈できない値なら null を返す", () => {
    process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL = "concierge-admin";
    expect(readConciergeAdminUrl()).toBeNull();
  });

  test("http でも https でもないスキームなら null を返す", () => {
    // 別タブで開く先に `javascript:` を通すと、設定ミス1つでアプリ内スクリプト実行の口になる。
    process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL = "javascript:alert(1)";
    expect(readConciergeAdminUrl()).toBeNull();
  });

  test("http の管理画面 URL は開ける値として扱う（ローカルの Streamlit 向け）", () => {
    process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL = "http://localhost:8501";
    expect(readConciergeAdminUrl()).toBe("http://localhost:8501");
  });
});

describe("ConciergeAdminLink の描画（完了条件1・2）", () => {
  test("管理画面 URL が設定されていれば a 要素を返す", async () => {
    const link = await renderLinkWithUrl(VALID_ADMIN_URL);
    expect(link?.type).toBe("a");
  });

  test("ボタンの文言が「浮遊街コンシェルジュ管理画面を開く」を含む", async () => {
    const link = await renderLinkWithUrl(VALID_ADMIN_URL);
    expect(textOf(link)).toContain("浮遊街コンシェルジュ管理画面を開く");
  });

  test("href に管理画面 URL が入る", async () => {
    const link = await renderLinkWithUrl(VALID_ADMIN_URL);
    expect(link?.props.href).toBe(VALID_ADMIN_URL);
  });

  test("target=\"_blank\" で別タブで開く", async () => {
    // 画面設計.md §4 B9「タップで別タブで開く（システム間の認証連携なし）」。
    const link = await renderLinkWithUrl(VALID_ADMIN_URL);
    expect(link?.props.target).toBe("_blank");
  });

  test("rel に noopener が含まれる", async () => {
    const link = await renderLinkWithUrl(VALID_ADMIN_URL);
    expect(link?.props.rel).toContain("noopener");
  });

  test("rel に noreferrer が含まれる", async () => {
    const link = await renderLinkWithUrl(VALID_ADMIN_URL);
    expect(link?.props.rel).toContain("noreferrer");
  });
});

describe("ConciergeAdminLink を描画しない条件（完了条件4 ／ v13 §5.9.5）", () => {
  test("管理画面 URL が未設定ならボタンそのものを描画しない", async () => {
    expect(await renderLinkWithUrl(undefined)).toBeNull();
  });

  test("管理画面 URL が空文字ならボタンそのものを描画しない", async () => {
    expect(await renderLinkWithUrl("")).toBeNull();
  });

  test("管理画面 URL が開けない値ならボタンそのものを描画しない", async () => {
    expect(await renderLinkWithUrl("javascript:alert(1)")).toBeNull();
  });
});
