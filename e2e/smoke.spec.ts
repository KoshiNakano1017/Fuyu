import { expect, test } from "@playwright/test";

test("トップページが200で表示され、タイトルに「浮遊街」を含む", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/浮遊街/);
});
