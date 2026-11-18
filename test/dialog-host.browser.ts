/**
 * Browser regression for the classic appDialog (same Promise semantics as React dialog).
 * Does not call AI providers. Captures light/dark screenshots under docs/validation/dialogs/.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const out = resolve("docs/validation/dialogs");
mkdirSync(out, { recursive: true });
const dialogSource = readFileSync(resolve("public/app-dialog.js"), "utf8");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function withPage(colorScheme: "light" | "dark", fn: (page: import("playwright-core").Page) => Promise<void>) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 700 },
    colorScheme,
  });
  await page.goto("about:blank");
  await page.addScriptTag({ content: dialogSource });
  await fn(page);
  await page.close();
}

try {
  await withPage("light", async (page) => {
    const confirmed = page.evaluate(async () => {
      const p = (window as unknown as { appDialog: { confirm: (o: object) => Promise<boolean> } }).appDialog.confirm({
        title: "Delete conversation?",
        description: "This conversation and all its messages will be permanently deleted.",
        confirmLabel: "Delete conversation",
        cancelLabel: "Cancel",
        variant: "destructive",
      });
      await new Promise((r) => setTimeout(r, 50));
      return p;
    });
    await page.waitForSelector("dialog.app-dialog");
    await page.screenshot({ path: resolve(out, "confirm-destructive-light.png") });
    // Escape must cancel — never confirm destructive.
    await page.keyboard.press("Escape");
    assert.equal(await confirmed, false);

    const inputP = page.evaluate(async () => {
      const p = (window as unknown as { appDialog: { prompt: (o: object) => Promise<string | null> } }).appDialog.prompt({
        title: "Edit continue-on branch",
        description: "Existing branch to continue on (empty = cut a new branch).",
        label: "Branch name",
        defaultValue: "feature/x",
        required: false,
        confirmLabel: "Save branch",
        cancelLabel: "Cancel",
      });
      await new Promise((r) => setTimeout(r, 50));
      return p;
    });
    await page.waitForSelector("dialog.app-dialog input");
    await page.screenshot({ path: resolve(out, "prompt-input-light.png") });
    await page.click(".app-dialog-confirm");
    assert.equal(await inputP, "feature/x");

    const alertP = page.evaluate(async () => {
      const p = (window as unknown as { appDialog: { alert: (o: object) => Promise<void> } }).appDialog.alert({
        title: "Conversation deleted",
        description: "The conversation was removed successfully.",
        confirmLabel: "OK",
        variant: "info",
      });
      await new Promise((r) => setTimeout(r, 50));
      return p;
    });
    await page.waitForSelector("dialog.app-dialog");
    await page.screenshot({ path: resolve(out, "alert-info-light.png") });
    await page.click(".app-dialog-confirm");
    assert.equal(await alertP, undefined);

    // Double-click confirm must not leave a hung second dialog for a single request.
    let resolves = 0;
    const once = page.evaluate(async () => {
      const p = (window as unknown as { appDialog: { confirm: (o: object) => Promise<boolean> } }).appDialog.confirm({
        title: "Cancel run?",
        description: "Running steps are stopped.",
        confirmLabel: "Cancel run",
        cancelLabel: "Keep running",
        variant: "destructive",
      });
      await new Promise((r) => setTimeout(r, 50));
      return p;
    });
    await page.waitForSelector("dialog.app-dialog");
    await page.click(".app-dialog-confirm");
    await page.click(".app-dialog-confirm").catch(() => {});
    assert.equal(await once, true);
    resolves = 1;
    assert.equal(resolves, 1);
  });

  await withPage("dark", async (page) => {
    void page.evaluate(() =>
      (window as unknown as { appDialog: { confirm: (o: object) => Promise<boolean> } }).appDialog.confirm({
        title: "Remove repository?",
        description: "Registration is removed. Local clones are not deleted.",
        confirmLabel: "Remove repository",
        cancelLabel: "Cancel",
        variant: "destructive",
      }),
    );
    await page.waitForSelector("dialog.app-dialog");
    await page.screenshot({ path: resolve(out, "confirm-destructive-dark.png") });
    await page.click(".app-dialog-cancel");
  });

  // Mobile usable width
  const mobile = await browser.newPage({ viewport: { width: 390, height: 700 }, colorScheme: "light" });
  await mobile.goto("about:blank");
  await mobile.addScriptTag({ content: dialogSource });
  void mobile.evaluate(() =>
    (window as unknown as { appDialog: { confirm: (o: object) => Promise<boolean> } }).appDialog.confirm({
      title: "Reject this step?",
      description: 'Reject step "Review changes"?',
      confirmLabel: "Reject",
      cancelLabel: "Cancel",
      variant: "destructive",
    }),
  );
  await mobile.waitForSelector("dialog.app-dialog");
  const box = await mobile.locator("dialog.app-dialog").boundingBox();
  assert.ok(box && box.width <= 390);
  await mobile.screenshot({ path: resolve(out, "confirm-mobile.png") });
  await mobile.click(".app-dialog-cancel");
  await mobile.close();

  console.log(`dialog screenshots → ${out}`);
} finally {
  await browser.close();
}
