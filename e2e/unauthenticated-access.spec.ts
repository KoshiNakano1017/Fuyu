import { expect, test } from "@playwright/test";

/**
 * 未認証からの到達性（WBS 1-3 ／ `e2e/TEST_PLAN.md` A 群のうち**DBを要しない範囲**）。
 *
 * ## なぜここだけ先に書けるのか
 *
 * `TEST_PLAN.md` §0-1 が定めるとおり、ロール別の試験には**テスト用 Supabase プロジェクト**
 * （WBS `1-1b` ／ オーナー作業）が要る。一方、**未認証の利用者に何を見せないか**は
 * ログインを伴わないため、いまの CI（プレースホルダの Supabase 値）でも検証できる。
 *
 * ## DOM の非表示ではなく「到達できないこと」を見る
 *
 * v13 §5.9.3 は「画面上の非表示と**サーバサイド認可を必ず併置する**」と定めている。
 * したがってここで確かめるのは、**URL を直接叩いたときにどうなるか**である
 * （タブが描画されないことは `tests/role-navigation.test.ts` が別に押さえている）。
 */

/** middleware（`src/middleware.ts`）が保護している経路。 */
const PROTECTED_PAGES = [
  { path: "/quests", name: "クエストボード" },
  { path: "/orders", name: "カフェ注文" },
  { path: "/me", name: "マイページ" },
  { path: "/upload", name: "アップロード" },
  { path: "/reservations", name: "宿泊予約" },
  { path: "/shopping", name: "買い物リスト" },
  { path: "/staff/orders", name: "店員用タブレット" },
  { path: "/staff/quests", name: "クエスト承認・査定" },
  { path: "/staff/eumo", name: "Eumo給付一覧" },
  { path: "/admin", name: "管理ダッシュボード" },
  { path: "/admin/master", name: "マスタ管理" },
  { path: "/admin/morning-meetings", name: "朝会議事録の投入" },
];

test.describe("未認証では保護された画面へ到達できない（v13 §5.9.3）", () => {
  for (const page of PROTECTED_PAGES) {
    test(`未認証で ${page.path}（${page.name}）を開くとログイン画面へ送られる`, async ({
      page: browserPage,
    }) => {
      await browserPage.goto(page.path);
      await expect(browserPage).toHaveURL(/\/login/);
    });
  }
});

test.describe("未認証でも開く経路（v13 §5.2.6・§8）", () => {
  test("ログイン画面は未認証で開ける", async ({ page }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBe(200);
  });

  test("ヘルスチェックは認証を要求しない（死活監視が巻き添えで落ちないため）", async ({
    request,
  }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
  });

  test("公開予約ページはログインへ送られない（v13 §5.2.3 ／ WBS 3-5b）", async ({ page }) => {
    // ⚠️ ステータスまでは見ない。この画面は表示の材料を `service_role` で読むため、
    //    CI のようにキーを持たない環境では 500 になる（`src/app/reserve/page.tsx` の注記）。
    //    ここで固定したいのは「**未ログインの入口であり、ログインへ飛ばさない**」ことである。
    await page.goto("/reserve");
    await expect(page).toHaveURL(/\/reserve/);
  });
});

test.describe("未認証の API 呼び出しは 401 で拒否される（v13 §5.11.5）", () => {
  test("署名付きアップロードURLは未認証には発行されない", async ({ request }) => {
    const response = await request.post("/api/media/signed-upload-url", {
      data: { contentType: "image/jpeg", purposeTags: ["クエスト報告"] },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(401);
  });

  test("クエスト一覧の API は未認証に中身を返さない", async ({ request }) => {
    const response = await request.get("/api/quests", { failOnStatusCode: false });
    // 401（拒否）でも 200 の空配列でもなく、**報酬額や指示内容が漏れていないこと**が要件である。
    // ここでは認証を要求していること自体を固定する（v13 §5.10.6 の列マスクは DB テスト側で検証済み）。
    expect(response.status()).toBe(401);
  });
});
