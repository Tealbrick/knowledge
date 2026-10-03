import { expect, test } from "@playwright/test";

const documentRoute = "**/api/knowledge/collections/*/documents";

test("document dialog keeps a failed draft and reports the Program error", async ({ page }) => {
  await page.route(documentRoute, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Simulated canonical source conflict" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/?view=library&companyId=default");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create document" });
  await editor.getByLabel("Title").fill("Draft survives the failed request");
  await editor.getByLabel("Summary").fill("Keep this summary when the server rejects the write.");
  await editor.getByLabel("Markdown body").fill("The body remains available for correction.");
  await editor.getByRole("button", { name: "Create document" }).click();

  await expect(editor).toBeVisible();
  await expect(editor.getByRole("alert")).toContainText("Simulated canonical source conflict");
  await expect(editor.getByLabel("Title")).toHaveValue("Draft survives the failed request");
  await expect(editor.getByLabel("Summary")).toHaveValue("Keep this summary when the server rejects the write.");
  await expect(editor.getByLabel("Markdown body")).toHaveValue("The body remains available for correction.");

  await editor.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog", { name: "Discard unsaved changes?" }).getByRole("button", { name: "Discard draft" }).click();
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create document" }).getByRole("alert")).toBeHidden();
});

test("document dialog protects dirty drafts on cancel and Escape", async ({ page }) => {
  await page.goto("/?view=library&companyId=default");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create document" });
  await editor.getByLabel("Title").fill("Unsaved document");

  await editor.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
  await expect(discard).toBeVisible();
  await expect(discard.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(editor.getByLabel("Title")).toHaveValue("Unsaved document");

  await editor.press("Escape");
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard draft" }).click();
  await expect(editor).toBeHidden();
});

test("document dialog disables its draft and prevents double submission while pending", async ({ page }) => {
  let requests = 0;
  let releaseRequest!: () => void;
  const requestReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await page.route(documentRoute, async (route) => {
    if (route.request().method() === "POST") {
      requests += 1;
      await requestReleased;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "kdoc_disposable_pending" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/?view=library&companyId=default");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create document" });
  await editor.getByLabel("Title").fill("Pending document");
  const submit = editor.getByRole("button", { name: "Create document" });
  const submitControl = editor.locator('button[type="submit"]');
  await submit.click();
  await page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>("#document-dialog-form");
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  await expect(submitControl).toBeDisabled();
  await expect(editor.getByLabel("Title")).toBeDisabled();
  await expect(editor.getByLabel("Markdown body")).toBeDisabled();
  await expect.poll(() => requests).toBe(1);
  releaseRequest();
  await expect(editor).toBeHidden();
});

test("document dialog keeps delete confirmation reachable and retains it after a failed delete", async ({ page }) => {
  await page.goto("/?view=library&companyId=default");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit document" });

  await editor.getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: /Delete Knowledge Browser Acceptance Fixture/ });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Delete document" })).toBeVisible();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(editor.getByRole("button", { name: "Delete", exact: true })).toBeVisible();

  await page.route("**/api/knowledge/documents/*", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Simulated source deletion conflict" }),
      });
      return;
    }
    await route.continue();
  });
  await editor.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmation.getByRole("button", { name: "Delete document" }).click();
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("alert")).toContainText("Simulated source deletion conflict");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeVisible();
});
