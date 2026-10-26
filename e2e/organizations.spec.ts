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
import { latestLinkTo } from "./mailpit";
import { sendQueuedInvitationEmails } from "./worker-helpers";

// Organizations (ADR-005) in Arabic at 360 px: an owner creates a pharmacy and
// invites an address that has no account yet; the invitee gets the email,
// signs up with that address, accepts on /organizations and becomes a
// recruiter. A third member cannot open the organization at all.
//
// Each client sends its own documentation-range address in X-Forwarded-For,
// so this file does not share 127.0.0.1's sign-up budget (see profiles.spec.ts).
function clientIp() {
  return `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
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

test("create a pharmacy, invite a recruiter by email, accept, manage members (360px)", async ({
  page,
  browser,
  baseURL,
}) => {
  const csp = watchCsp(page);
  const owner = uniqueEmail("org-owner");
  await signUpAndVerify(page, owner);
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/account$/);

  // From the account page to the empty list.
  await page.getByRole("link", { name: "منشآتي" }).click();
  await expect(page).toHaveURL(/\/organizations$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("organizations-empty")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // A missing name is refused before anything is sent.
  await page.getByLabel("المحافظة").selectOption({ label: "الجيزة" });
  await page.getByRole("button", { name: "إنشاء المنشأة" }).click();
  await expect(page.getByText("هذا الحقل مطلوب.")).toBeVisible();

  await page.getByLabel("اسم المنشأة").fill("  صيدلية   الاختبار  ");
  await page.getByLabel("العنوان").fill("١٢ شارع التحرير، الدقي");
  await page.getByRole("button", { name: "إنشاء المنشأة" }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}$/);
  const orgPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "صيدلية الاختبار",
  );
  await expect(page.getByTestId("my-role")).toHaveText("مالك");
  await expect(page.getByTestId("organization-kind")).toHaveText("صيدلية");
  await expectNoHorizontalScroll(page);

  // Invite an address that has no account yet.
  const invitee = uniqueEmail("org-invitee");
  await page.getByLabel("البريد الإلكتروني للمدعو").fill(invitee);
  await page
    .getByLabel("الدور", { exact: true })
    .selectOption({ label: "مسؤول توظيف" });
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "تم إرسال الدعوة." }),
  ).toBeVisible();
  await expect(page.getByTestId("invitation-list")).toContainText(invitee);
  // A second invitation to the same address is refused.
  await page.getByLabel("البريد الإلكتروني للمدعو").fill(invitee);
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "توجد دعوة معلقة" }),
  ).toBeVisible();

  // The worker's email job, through Mailpit.
  expect(await sendQueuedInvitationEmails()).toBeGreaterThanOrEqual(1);
  const link = await latestLinkTo(page.request, invitee, "دعوة للانضمام");
  expect(new URL(link).pathname).toBe("/organizations");

  // The invitee signs up with the invited address and accepts.
  const second = await secondClient(browser, baseURL);
  await signUpAndVerify(second.page, invitee);
  await signIn(second.page, invitee);
  await expect(second.page).toHaveURL(/\/account$/);
  await second.page.goto("/organizations");
  const invitation = second.page.getByTestId("my-invitation");
  await expect(invitation).toContainText("صيدلية الاختبار");
  await expect(invitation).toContainText("مسؤول توظيف");
  await expectNoHorizontalScroll(second.page);
  await invitation.getByRole("button", { name: "قبول الدعوة" }).click();
  await expect(second.page).toHaveURL(new RegExp(`${orgPath}$`));
  await expect(second.page.getByTestId("my-role")).toHaveText("مسؤول توظيف");
  // A recruiter sees neither members nor invitations.
  await expect(second.page.getByTestId("member-list")).toHaveCount(0);
  await expect(second.page.locator("main")).not.toContainText(owner);

  // A third member cannot open the organization: the same 404 as a missing one.
  const third = await secondClient(browser, baseURL);
  const outsider = uniqueEmail("org-outsider");
  await signUpAndVerify(third.page, outsider);
  await signIn(third.page, outsider);
  await expect(third.page).toHaveURL(/\/account$/);
  const denied = await third.page.goto(orgPath);
  expect(denied?.status()).toBe(404);

  // The owner sees the new member and removes them after confirming.
  await page.reload();
  const rows = page.getByTestId("member-row");
  await expect(rows).toHaveCount(2);
  const row = rows.filter({ hasText: invitee });
  await expect(row.getByTestId("member-role")).toHaveText("مسؤول توظيف");
  await expect(page.getByTestId("invitations-empty")).toBeVisible();
  await row.getByRole("button", { name: "إزالة من المنشأة" }).click();
  await row.getByRole("button", { name: "نعم، أزل العضو" }).click();
  await expect(page.getByTestId("member-row")).toHaveCount(1);

  // The sole owner cannot leave.
  await page.getByRole("button", { name: "مغادرة المنشأة" }).click();
  await page.getByRole("button", { name: "نعم، غادر" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "مالك واحد على الأقل" }),
  ).toBeVisible();

  // The removed recruiter no longer has access.
  const gone = await second.page.goto(orgPath);
  expect(gone?.status()).toBe(404);

  expect(csp).toEqual([]);
  await second.context.close();
  await third.context.close();
});
