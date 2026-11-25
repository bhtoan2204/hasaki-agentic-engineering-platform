import type { Page } from "playwright-core";
import { config } from "./config.ts";

/** Let Work generate state and PKCE verifier/challenge in this same browser profile. */
export async function startWorkSso(page: Page, active: () => boolean) {
  await page.goto(`${config.hasakiWork.webUrl}/auth/login`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  const button = page.getByRole("button", {
    name: /^(Đăng nhập với Hasaki SSO|Sign in with Hasaki SSO)$/,
  });
  try {
    await button.waitFor({ state: "visible", timeout: 10000 });
  } catch {
    // Work may have already restored a session or redirected to the identity provider.
    if (
      !active() ||
      new URL(page.url()).pathname !== "/auth/login" ||
      new URL(page.url()).origin !== new URL(config.hasakiWork.webUrl).origin
    )
      return;
    throw new Error("chrome_sso_start");
  }
  if (!active()) return;
  await button.click({ timeout: 10000 });
}
