import { expect, test } from "@playwright/test";

test("root serves Arabic RTL", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the landing page shows its sections and sign-up actions when signed out", async ({
  page,
}) => {
  await page.goto("/");
  for (const id of ["pharmacists", "pharmacies", "trust"]) {
    await expect(page.getByTestId(`home-${id}`)).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "إنشاء حساب" })).toBeVisible();
  await expect(page.getByRole("link", { name: "تسجيل الدخول" })).toBeVisible();
  await expect(page.getByRole("link", { name: "الوظائف" })).toBeVisible();
  await expect(page.getByRole("link", { name: "حسابي" })).toHaveCount(0);
});

test("no horizontal scroll at 360px", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("language switch reaches English LTR and back", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "English" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("/en renders LTR", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("health endpoint is ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
