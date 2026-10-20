import { readFile } from "node:fs/promises";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  expectNoHorizontalScroll,
  signIn,
  signUpAndVerify,
  uniqueEmail,
  watchCsp,
} from "./helpers";

// identity.spec.ts already uses the per-IP sign-up budget (3 per hour) for
// 127.0.0.1. Each client here sends its own documentation-range address in
// X-Forwarded-For, the header the limiter keys on (CLAUDE.md, section 4), so
// this file has its own budget. Per-email limits are unaffected.
function clientIp() {
  return `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
}

test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "x-forwarded-for": clientIp() } });

async function secondClient(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 360, height: 780 },
    locale: "ar-EG",
    extraHTTPHeaders: { "x-forwarded-for": clientIp() },
  });
  return { context, page: await context.newPage() };
}

test("complete a profile in Arabic, share it with members, hide it, export my data (360px)", async ({
  page,
  browser,
  baseURL,
}) => {
  const csp = watchCsp(page);
  const owner = uniqueEmail("profile-owner");
  await signUpAndVerify(page, owner);
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/account$/);

  // From the account page to the empty profile.
  await page.getByRole("link", { name: "ملفي المهني" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "ملفي المهني",
  );
  await expect(page.getByTestId("profile-empty")).toBeVisible();
  await expect(page.getByTestId("experience-empty")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Public profile, with Arabic digits. An out-of-range value is refused first.
  await page.getByLabel("الاسم الظاهر").fill("  د. سـارة   الاختبار ");
  await page.getByLabel("المسمى المهني").fill("صيدلانية مجتمع");
  await page.getByLabel("المرحلة المهنية").selectOption({ label: "صيدلي" });
  await page.getByLabel("سنوات الخبرة").fill("٧٠");
  await page.getByLabel("المحافظة").selectOption({ label: "الإسكندرية" });
  await page.getByLabel("صيدلية مجتمع").check();
  await page.getByLabel("الصيدلة الإكلينيكية").check();
  await page.getByLabel("أبحث عن فرصة عمل").check();
  await page.getByRole("button", { name: "حفظ الملف" }).click();
  await expect(page.getByText("الرقم خارج النطاق المسموح.")).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "راجع الحقول المميزة" }),
  ).toBeVisible();

  await page.getByLabel("سنوات الخبرة").fill("٧");
  await page.getByRole("button", { name: "حفظ الملف" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم حفظ ملفك." }),
  ).toBeVisible();
  await expect(page.getByTestId("visibility-state")).toHaveText("ظاهر للأعضاء");

  // Private details, clearly marked.
  const details = page.getByRole("region", { name: /بيانات خاصة/ });
  await expect(details.getByText("خاص", { exact: true })).toBeVisible();
  await details.getByLabel("رقم الموبايل").fill("٠١١٥٥٥٠١٢٣٤");
  await details.getByLabel("الجامعة").fill("جامعة الإسكندرية");
  await details.getByLabel("سنة التخرج").fill("٢٠١٨");
  await details.getByRole("button", { name: "حفظ البيانات الخاصة" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم حفظ بياناتك الخاصة." }),
  ).toBeVisible();

  // Experience: add, then edit.
  await page.getByRole("button", { name: "إضافة خبرة" }).click();
  const addForm = page.getByRole("form", { name: "إضافة خبرة" });
  await addForm.getByLabel("المسمى الوظيفي").fill("صيدلي أول");
  await addForm.getByLabel("جهة العمل").fill("صيدلية الشفاء");
  const start = addForm.getByRole("group", { name: "تاريخ البداية" });
  await start.getByLabel("الشهر").selectOption("3");
  await start.getByLabel("السنة").fill("٢٠١٩");
  await addForm.getByLabel("ما زلت أعمل هنا").check();
  await expect(
    addForm.getByRole("group", { name: "تاريخ النهاية" }),
  ).toHaveCount(0);
  await addForm.getByRole("button", { name: "حفظ الخبرة" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تمت إضافة الخبرة." }),
  ).toBeVisible();
  const list = page.getByTestId("experience-list");
  await expect(list).toContainText("صيدلي أول");
  await expect(list).toContainText("حتى الآن");
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "تعديل صيدلي أول" }).click();
  const editForm = page.getByRole("form", { name: "تعديل خبرة" });
  await editForm.getByLabel("المسمى الوظيفي").fill("مدير صيدلية");
  await editForm.getByRole("button", { name: "حفظ الخبرة" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم تحديث الخبرة." }),
  ).toBeVisible();
  await expect(list).toContainText("مدير صيدلية");

  // The owner's preview of the member view.
  await page.getByRole("link", { name: "عرض ملفي كما يراه الأعضاء" }).click();
  await expect(page).toHaveURL(/\/profiles\/[0-9a-f-]{36}$/);
  const profileUrl = new URL(page.url()).pathname;
  const view = page.getByTestId("profile-view");
  await expect(page.getByTestId("profile-name")).toHaveText("د. سارة الاختبار");
  await expect(view).toContainText("الإسكندرية");
  await expect(view).toContainText("صيدلي");
  await expect(view).toContainText("الصيدلة الإكلينيكية");
  await expect(view).toContainText("مدير صيدلية");
  await expect(view).toContainText("هذه معاينة لملفك");
  await expectNoHorizontalScroll(page);

  // Download my data.
  await page.goto("/account");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "تنزيل بياناتي" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^pharmacist-platform-data-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(exported).toMatchObject({
    format: "pharmacist-platform.export",
    account: { email: owner, emailVerified: true },
    profile: {
      displayName: "د. سارة الاختبار",
      yearsExperience: 7,
      governorate: { code: "EG-ALX" },
      specialties: ["community", "clinical"],
    },
    professionalDetails: {
      phoneE164: "+201155501234",
      graduationYear: 2018,
    },
    experience: [{ title: "مدير صيدلية", endMonth: null }],
  });
  const raw = JSON.stringify(exported);
  for (const key of ["password", "token", "secret", "backupCodes"])
    expect(raw).not.toContain(`"${key}"`);

  // A second member sees the profile, without the private details.
  const other = await secondClient(browser, baseURL);
  const viewerEmail = uniqueEmail("profile-viewer");
  await signUpAndVerify(other.page, viewerEmail);
  await signIn(other.page, viewerEmail);
  await expect(other.page).toHaveURL(/\/account$/);
  const seen = await other.page.goto(profileUrl);
  expect(seen?.status()).toBe(200);
  await expect(other.page.getByTestId("profile-name")).toHaveText(
    "د. سارة الاختبار",
  );
  await expect(other.page.getByTestId("profile-view")).not.toContainText(
    "هذه معاينة لملفك",
  );
  // Neither in the visible page nor anywhere in the HTML payload.
  const html = await other.page.content();
  for (const secret of [
    "01155501234",
    "+201155501234",
    "٠١١٥٥٥٠١٢٣٤",
    "جامعة الإسكندرية",
    owner,
  ])
    expect(html).not.toContain(secret);
  const visible = await other.page.locator("main").innerText();
  for (const year of ["2018", "٢٠١٨"]) expect(visible).not.toContain(year);

  // The owner hides the profile.
  await page.goto("/profile");
  await page.getByRole("radio", { name: /أنا فقط/ }).check();
  await page.getByRole("button", { name: "حفظ الملف" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم حفظ ملفك." }),
  ).toBeVisible();
  await expect(page.getByTestId("visibility-state")).toHaveText("مخفي");

  // Now the other member gets the same 404 as for a profile that never existed.
  const hidden = await other.page.goto(profileUrl);
  expect(hidden?.status()).toBe(404);
  await expect(other.page.getByRole("heading", { level: 1 })).toHaveText(
    "الصفحة غير موجودة",
  );
  const hiddenText = await other.page.locator("main").innerText();
  expect(hiddenText).not.toContain("سارة");
  const missing = await other.page.goto(
    "/profiles/00000000-0000-4000-8000-000000000000",
  );
  expect(missing?.status()).toBe(404);
  expect(await other.page.locator("main").innerText()).toBe(hiddenText);

  // The owner still sees it, with a notice that it is hidden.
  await page.goto(profileUrl);
  await expect(page.getByTestId("profile-name")).toHaveText("د. سارة الاختبار");
  await expect(page.getByTestId("profile-view")).toContainText(
    "ملفك مخفي حاليًا",
  );

  // Delete the experience, with confirmation.
  await page.goto("/profile");
  await page.getByRole("button", { name: "حذف مدير صيدلية" }).click();
  await page.getByRole("button", { name: "نعم، احذف" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم حذف الخبرة." }),
  ).toBeVisible();
  await expect(page.getByTestId("experience-empty")).toBeVisible();

  await other.context.close();
  expect(csp).toEqual([]);
});

test("signed-out visitors cannot open profiles or the data export", async ({
  page,
}) => {
  await page.goto("/profiles/00000000-0000-4000-8000-000000000000");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/sign-in$/);
  const response = await page.request.get("/api/account/export");
  expect(response.status()).toBe(401);
  expect(response.headers()["content-disposition"]).toBeUndefined();
});
