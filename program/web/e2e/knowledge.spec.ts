import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectContained(container: Locator, child: Locator) {
  await child.scrollIntoViewIfNeeded();
  const [parentBox, childBox] = await Promise.all([container.boundingBox(), child.boundingBox()]);
  expect(parentBox).not.toBeNull();
  expect(childBox).not.toBeNull();
  expect(childBox!.x).toBeGreaterThanOrEqual(parentBox!.x - 1);
  expect(childBox!.y).toBeGreaterThanOrEqual(parentBox!.y - 1);
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(parentBox!.x + parentBox!.width + 1);
  expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(parentBox!.y + parentBox!.height + 1);
}

async function expectNoDocumentOverflow(page: Page) {
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
}

test("standalone library reads the isolated canonical fixture and developer contracts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.getByLabel("Knowledge documents").getByRole("button").first()).toBeVisible();
  await expect(page.locator(".document-workspace h2")).toHaveText("Knowledge Browser Acceptance Fixture");
  await expect(page.getByText("This document exists only inside the Playwright-managed temporary SQLite database.")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page).toHaveURL(/\?view=settings&companyId=default&section=models/);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  const settings = page.locator(".dg-settings-page");
  await expect(settings.getByRole("heading", { name: "Connect your models" })).toBeVisible();
  // The browser fixture has no owner attestation: model settings explain that instead of failing silently.
  await expect(settings.getByText("Model settings are owner-only")).toBeVisible();
  await settings.getByRole("button", { name: "Runtime" }).click();
  await expect(page).toHaveURL(/section=runtime/);
  await settings.getByLabel("Workspace ID").fill("team-alpha");
  await settings.getByRole("button", { name: "Switch workspace" }).click();
  await expect(page).toHaveURL(/view=settings.*companyId=team-alpha/);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/view=library&companyId=team-alpha/);
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page).toHaveURL(/view=settings&companyId=team-alpha&section=models/);
  await settings.getByRole("button", { name: "Runtime" }).click();
  await expect(page.getByLabel("Workspace ID")).toHaveValue("team-alpha");
  await page.reload();
  await expect(page.getByLabel("Workspace ID")).toHaveValue("team-alpha");
  await settings.getByRole("button", { name: "Developer" }).click();
  await expect(settings.getByText("/api/companies/{companyId}/knowledge/search", { exact: true })).toBeVisible();
  await expect(settings.getByText("Connections are managed on the server")).toBeVisible();
  await expect(settings.getByText("Version control", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Version control" })).toHaveCount(0);
  await settings.getByRole("button", { name: "Dependencies" }).click();
  await expect(settings.getByRole("heading", { name: "Services" })).toBeVisible();
  const services = settings.getByLabel("Services", { exact: true });
  await expect(services.getByText("Document database", { exact: true })).toBeVisible();
  await expect(services.getByText("Memory engine", { exact: true })).toBeVisible();
  await expect(services).not.toContainText("knowledgeDb");
  await expect(settings.getByLabel("Features").getByText("Research", { exact: true })).toBeVisible();
  await expect(settings.getByLabel("Features")).toContainText("Not connected");
  // The memory engine is off in this fixture; the next action leads to model setup.
  await services.getByRole("button", { name: "Open Models" }).click();
  await expect(page).toHaveURL(/section=models/);
  await expect(page.getByRole("link", { name: /^Memory/ })).toContainText("Off");
});

test("settings deep links preserve a non-default scope through sections, reload, and history", async ({ page }) => {
  await page.goto("/?view=settings&section=developer&companyId=team-alpha");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=settings/);
  expect(new URL(page.url()).searchParams.get("companyId")).toBe("team-alpha");
  expect(new URL(page.url()).searchParams.get("section")).toBe("developer");
  await expect(page.getByRole("heading", { name: "API reference" })).toBeVisible();
  await expect(page.getByText("team-alpha", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Research", exact: true }).click();
  await expect(page).toHaveURL(/\?view=research&companyId=team-alpha/);
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page).toHaveURL(/\?view=settings&companyId=team-alpha&section=models/);
  // The sidebar Settings link and the settings button open the same section.
  await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute("href", /section=models/);
  await page.getByRole("button", { name: "Runtime" }).click();
  await expect(page).toHaveURL(/\?view=settings&companyId=team-alpha&section=runtime/);
  await page.reload();
  await expect(page.getByLabel("Workspace ID")).toHaveValue("team-alpha");
  await page.goBack();
  await expect(page).toHaveURL(/\?view=research&companyId=team-alpha/);
  await page.goForward();
  await expect(page).toHaveURL(/\?view=settings&companyId=team-alpha&section=runtime/);
  await expect(page.getByLabel("Workspace ID")).toHaveValue("team-alpha");
  await page.goto("/?view=settings&section=version-control&companyId=team-alpha");
  await expect(page.getByRole("heading", { name: "API reference" })).toBeVisible();
});

test("an explicit default scope is not replaced by discovered bootstrap scope", async ({ page }) => {
  await page.route("**/bootstrap.json", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, scope: { ...body.scope, defaultCompanyId: "team-discovered" } }),
    });
  });
  await page.goto("/?view=library&companyId=default");
  await expect(page).toHaveURL(/view=library&companyId=default/);
  await expect(page.locator(".topbar code")).toHaveText("default");
});

test("conflicting create remains in the editor and reports the Program response", async ({ page }) => {
  await page.route("**/api/knowledge/collections/*/documents", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Simulated canonical source conflict" }) });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create document" });
  await editor.getByLabel("Title").fill("Unsaved acceptance record");
  await editor.getByLabel("Markdown body").fill("This record must never be created.");
  await editor.getByRole("button", { name: "Create document" }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("alert")).toContainText("Simulated canonical source conflict");
  await expect(editor.getByRole("alert")).toContainText("Document was not saved");
});

for (const viewport of [
  { name: "laptop", width: 1152, height: 820 },
  { name: "iframe", width: 820, height: 760 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`${viewport.name} contains Settings and document actions without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expectNoDocumentOverflow(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Create document" });
    await expectContained(editor, editor.getByRole("button", { name: "Create document" }));
    await expectContained(editor, editor.getByRole("button", { name: "Cancel" }));
    await expectNoDocumentOverflow(page);
    await editor.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const existingEditor = page.getByRole("dialog", { name: "Edit document" });
    await expectContained(
      existingEditor,
      existingEditor.getByRole("button", { name: "Save changes" }),
    );
    await existingEditor.getByRole("button", { name: "Delete", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expectContained(
      confirmation,
      confirmation.getByRole("button", { name: "Delete document" }),
    );
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await existingEditor.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Ingest", exact: true }).click();
    const ingest = page.getByRole("dialog", { name: "Ingest documents" });
    await expectContained(ingest, ingest.getByRole("button", { name: "Done" }));
    await expectContained(
      ingest,
      ingest.getByRole("button", { name: "Run source ingest" }),
    );
    await ingest.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.locator(".dg-settings-page");
    await expect(settings.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expectContained(settings, settings.getByRole("button", { name: "← Library" }));
    await settings.getByRole("button", { name: "Developer" }).click();
    await expect(settings.getByRole("heading", { name: "API reference" })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
}

test("embed is a complete constrained Knowledge surface", async ({ page }) => {
  const baseUrl = process.env.KNOWLEDGE_E2E_BASE_URL || "http://127.0.0.1:5310";
  await page.goto(baseUrl);
  await page.setContent(`<iframe title="Knowledge embed" src="${baseUrl}/embed" style="width:820px;height:760px;border:0"></iframe>`);
  const knowledge = page.frameLocator('iframe[title="Knowledge embed"]');
  await expect(knowledge.getByText("Knowledge", { exact: true }).first()).toBeVisible();
  await expect(knowledge.getByRole("heading", { name: "Library" })).toBeVisible();
  await knowledge.getByRole("button", { name: "Open settings" }).click();
  await expect(knowledge.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  const embedFrame = page.frames().find((frame) => frame.url().includes("/embed"));
  expect(embedFrame).toBeDefined();
  await expect.poll(() => embedFrame!.url()).toMatch(/\/embed\?view=settings&companyId=default&section=models/);
});

test("extract-facts is denied cross-origin without exposing or inventing a bearer", async ({ request }) => {
  const response = await request.post("/api/brain/extract-facts", {
    headers: { origin: "https://hostile.example", host: "knowledge.example" },
    data: { text: "This must remain forbidden." },
  });
  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toEqual({ ok: false, error: "brain_write_forbidden" });
});
