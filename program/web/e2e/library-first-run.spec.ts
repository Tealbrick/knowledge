import { expect, test } from "@playwright/test";

import { startFreshProgram } from "./fresh-program";

let program: Awaited<ReturnType<typeof startFreshProgram>>;

// The tests share one fresh instance and build on each other's records.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  program = await startFreshProgram();
});
test.afterAll(async () => {
  await program?.close();
});

test("a fresh instance creates its first collection and document from the UI", async ({ page }) => {
  await page.goto(`${program.baseUrl}/`);
  const empty = page.locator(".workspace-state");
  await expect(empty.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
  await expect(empty.getByRole("button", { name: "Write a document" })).toBeVisible();
  await expect(empty.getByRole("button", { name: "Import files" })).toBeVisible();

  await empty.getByRole("button", { name: "New collection" }).click();
  const dialog = page.getByRole("dialog", { name: "New collection" });
  await expect(dialog.getByRole("button", { name: "Create collection" })).toBeDisabled();
  await dialog.getByLabel("Name").fill("Team handbook");
  await dialog.getByLabel("Description (optional)").fill("How we work.");
  await dialog.getByRole("button", { name: "Create collection" }).click();
  await expect(dialog).toBeHidden();

  const strip = page.getByLabel("Collections");
  await expect(strip.getByRole("button", { name: /Team handbook/ })).toHaveClass(/is-active/);
  await expect(page.locator(".collection-actions")).toContainText("How we work.");
  await expect(page.getByText("This collection has no documents yet.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create document" });
  await expect(editor.getByLabel("Collection")).toHaveValue(/.+/);
  await editor.getByLabel("Title").fill("Onboarding checklist");
  await editor.getByLabel("Markdown body").fill("# Onboarding\n\nRead the handbook first.");
  await editor.getByRole("button", { name: "Create document" }).click();
  await expect(editor).toBeHidden();

  await expect(page.locator(".document-workspace h2")).toHaveText("Onboarding checklist");
  await expect(page.getByLabel("Knowledge documents").getByRole("button", { name: /Onboarding checklist/ })).toBeVisible();
  await expect(strip.getByRole("button", { name: /Team handbook/ })).toContainText("1");

  // The record survives a reload because it was written through the API, not held in page state.
  await page.reload();
  await expect(page.locator(".document-workspace h2")).toHaveText("Onboarding checklist");
});

test("deleting the populated collection returns the library to its first-run state", async ({ page }) => {
  await page.goto(`${program.baseUrl}/`);
  const strip = page.getByLabel("Collections");
  await strip.getByRole("button", { name: /Team handbook/ }).click();
  await page.getByRole("button", { name: "Delete collection" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Team handbook?" });
  await expect(confirm).toContainText("its 1 document");
  await confirm.getByRole("button", { name: "Delete collection" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
  await expect(strip.getByRole("button", { name: /Team handbook/ })).toHaveCount(0);
});

test("an instance with no collections in scope offers a collection first", async ({ page }) => {
  await page.route("**/knowledge/collections", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      : route.continue(),
  );
  await page.goto(`${program.baseUrl}/`);
  await expect(page.getByText("Start with a collection")).toBeVisible();
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  const empty = page.locator(".workspace-state");
  await expect(empty.getByRole("button", { name: "Write a document" })).toHaveCount(0);
  await expect(empty.getByRole("button", { name: "New collection" })).toBeVisible();
});

test("a collections failure is shown instead of an empty library", async ({ page }) => {
  await page.route("**/knowledge/collections", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "knowledge_unavailable" }) })
      : route.continue(),
  );
  await page.goto(`${program.baseUrl}/`);
  const alert = page.getByRole("alert").filter({ hasText: "Service unavailable" });
  await expect(alert).toContainText("Knowledge is restarting or unavailable");
  await expect(page.getByRole("heading", { name: "Your library is empty" })).toHaveCount(0);
});
