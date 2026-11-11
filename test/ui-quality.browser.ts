/** Layout regression checks use real HTTP/DB fixtures; no production data or external actions. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { analyticsFixtures } from "./analytics.fixtures.ts";
import { repositories } from "../src/repos/service.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { pool } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";
const fixture = await analyticsFixtures();
await pool.query("UPDATE prod_error_scans SET preset='custom',namespaces=ARRAY['oms'],groups=34");
await pool.query(
  "UPDATE prod_error_groups SET last_scan_id=(SELECT max(id) FROM prod_error_scans)",
);
for (let i = 1; i <= 32; i++) {
  const fingerprint = i.toString(16).padStart(20, "0");
  const service =
    [
      "oms-background-company-havotek",
      "oms-background-company-hotosu",
      "hasaki-agentic-engineering-platform",
    ][i % 3] + `-${i % 12}`;
  await pool.query(
    `INSERT INTO prod_error_groups(fingerprint,namespace,service,level,signature,day,today_count,yesterday_count,severity,last_scan_id,first_seen_at)
    VALUES($1,'oms',$2,'ERROR','Long incident signature for layout and wrapping verification','2026-11-01',$3,4,'high',(SELECT max(id) FROM prod_error_scans),'2026-11-01T00:00:00Z')`,
    [fingerprint, service, i],
  );
  await pool.query(
    `INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,severity,hourly)
    VALUES((SELECT max(id) FROM prod_error_scans),$1,$2,4,'high',$3)`,
    [fingerprint, i, JSON.stringify([{ hour: "2026-11-01T01:00:00Z", count: i }])],
  );
}
await repositories.upsert("hasaki-agentic-engineering-platform", {
  projects: ["OMS"],
  description:
    "A deliberately long repository description for responsive layout verification. ".repeat(8),
});
await pool.query("UPDATE work_items SET title=$1 WHERE id=$2", [
  "Investigate oms-background-company-havotek and hasaki-agentic-engineering-platform integration behaviour ".repeat(
    3,
  ),
  fixture.claude.work_item_id,
]);
await pool.query("UPDATE workflow_runs SET title=$1 WHERE id=$2", [
  "Long-running investigation of oms-background-company-hotosu ".repeat(4),
  fixture.claude.id,
]);
await knowledge.create({
  key: "ui-quality-long-document",
  title: "Knowledge for hasaki-agentic-engineering-platform ".repeat(4),
  category: "business_rule",
  content: "Long content for scroll verification.\n\n".repeat(80),
  scope_type: "PROJECT",
  scope_ref: "OMS",
  ownerId: fixture.owner.id,
});
const phase = process.env.UI_QUALITY_PHASE || "after";
const out = resolve(`docs/validation/ui-quality/${phase}`);
mkdirSync(out, { recursive: true });
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const measurements: any[] = [];
const errors: string[] = [];
const query = "from=2026-11-01&to=2026-11-03&timezone=UTC&bucket=day";
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("hasaki.uiLocale", "en"));
  const go = async (path: string) => {
    await page.goto(`${base}/#${path}`);
    await page.locator("main").waitFor();
    await page.locator("main h1, main h2, main .rv, main .office").first().waitFor();
    await page.locator("main .loading-screen,main .skeleton").first().waitFor({ state: "hidden" });
  };
  const capture = async (name: string) => {
    await page.screenshot({ path: resolve(out, `${name}.png`) });
  };
  await page.goto(`${base}/#/prod-errors/overview?${query}`);
  await page.locator('[name="username"]').fill("analytics-a");
  await page.locator('[name="password"]').fill("analytics-password");
  await page.locator('button[type="submit"]').click();
  await page.locator(".an-health-bars button").first().waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, target] of [
      ["overview", ".an-health-bars"],
      ["services", ".an-panel .table-wrap"],
      ["incidents", ".pe-filters"],
    ]) {
      await go(`/prod-errors/${route}?${query}`);
      await page.locator(target).first().waitFor();
      await page
        .locator(target)
        .first()
        .evaluate((el) => (el.closest(".an-panel") ?? el).scrollIntoView({ block: "start" }));
      await capture(`production-${route}-${width}`);
      measurements.push({
        route,
        width,
        kind: "baseline",
        ...(await page.evaluate(() => {
          const main = document.querySelector("main")!;
          const box = (el: Element) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return {
              x: r.x,
              y: r.y,
              w: r.width,
              h: r.height,
              background: s.backgroundColor,
              display: s.display,
              overflow: s.overflow,
            };
          };
          return {
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: innerHeight,
            windowY: scrollY,
            main: box(main),
            mainScroll: main.scrollTop,
            mainOverflow: main.scrollWidth - main.clientWidth,
            controls: [
              ...document.querySelectorAll(
                '.pe-filters select,.pe-filters input[type="search"],.an-range-buttons button',
              ),
            ].map(box),
            bars: [...document.querySelectorAll(".an-health-bars button")].map((el) => ({
              row: box(el),
              children: [...el.children].map(box),
            })),
            serviceLink: document.querySelector(".an-panel .table-wrap button.link-button")
              ? box(document.querySelector(".an-panel .table-wrap button.link-button")!)
              : null,
          };
        })),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await go(`/prod-errors/overview?${query}`);
  await page.locator(".an-health-bars").waitFor();
  await page.evaluate(() => {
    document.querySelector("main")!.scrollTop = 700;
  });
  await capture("overview-scrolled");
  await page.evaluate(() => {
    document.querySelector("main")!.focus();
  });
  measurements.push({
    kind: "scroll-focus",
    ...(await page.evaluate(() => ({
      windowY: scrollY,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
      mainY: document.querySelector("main")!.getBoundingClientRect().y,
      mainScroll: document.querySelector("main")!.scrollTop,
    }))),
  });
  const routes: [string, string][] = [
    ["overview", "/overview"],
    ["work-items", "/work-items"],
    ["work-item-detail", `/work-items/${fixture.claude.work_item_id}`],
    ["runs", "/runs"],
    ["run-view", `/runs/${fixture.claude.id}`],
    ["workflows", "/workflows"],
    ["workflow-editor", "/workflows/analytics-fixture"],
    ["knowledge", "/knowledge"],
    ["knowledge-detail", "/knowledge/ui-quality-long-document"],
    ["repositories", "/repositories"],
    ["repository-detail", "/repositories/hasaki-agentic-engineering-platform"],
    ["integrations", "/integrations"],
    ["production", `/prod-errors/overview?${query}`],
    ["insights", `/insights/usage?${query}`],
    ["evaluation", "/insights/evaluation"],
    ["office", "/office"],
    ["account", "/account"],
  ];
  for (const [name, path] of process.env.UI_QUALITY_FAST ? [] : routes) {
    for (const width of phase === "before" ? [1440, 390] : [1920, 1440, 1280, 1024, 768, 390]) {
      await page.setViewportSize({
        width,
        height:
          width === 390
            ? 844
            : width === 768
              ? 1024
              : width === 1024
                ? 768
                : width === 1280
                  ? 800
                  : width === 1440
                    ? 900
                    : 1080,
      });
      await go(path);
      // Give cached API renders two animation frames; wait for pending initial skeletons below.
      await page.waitForTimeout(120);
      const result = await page.evaluate(() => {
        const m = document.querySelector("main")!;
        return {
          overflow: Math.max(
            document.documentElement.scrollWidth - innerWidth,
            m.scrollWidth - m.clientWidth,
          ),
          documentHeight: document.documentElement.scrollHeight,
          windowY: scrollY,
          mainY: m.getBoundingClientRect().y,
          mainH: m.clientHeight,
        };
      });
      measurements.push({ kind: "page", name, width, ...result });
      if (width === 1440 || width === 390) await capture(`${name}-${width}`);
      if (phase !== "before")
        assert.ok(result.overflow <= 1, `${name} overflows at ${width}: ${result.overflow}`);
    }
  }
  if (phase !== "before") {
    const overflow = async () =>
      page.evaluate(() => {
        const m = document.querySelector("main")!;
        return Math.max(
          document.documentElement.scrollWidth - innerWidth,
          m.scrollWidth - m.clientWidth,
        );
      });
    const sizes = [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ];
    for (const locale of process.env.UI_QUALITY_FAST ? [] : ["vi", "en"])
      for (const theme of ["dark", "light"]) {
        await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
        if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme)
          await page.locator(".tb-right > button").click();
        const contrast = await page.evaluate(() => {
          const luminance = (value: string) => {
            const rgb = (value.match(/[\d.]+/g) ?? [])
              .slice(0, 3)
              .map(Number)
              .map((v) => {
                v /= 255;
                return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
              });
            return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
          };
          return ["", "warn", "danger", "ok"].map((variant) => {
            const button = document.createElement("button");
            button.className = variant;
            button.textContent = "Kiểm tra";
            document.querySelector("main")!.append(button);
            const css = getComputedStyle(button),
              fg = luminance(css.color),
              bg = luminance(css.backgroundColor);
            const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
            button.remove();
            return { variant: variant || "primary", ratio };
          });
        });
        assert.ok(
          contrast.every((c) => c.ratio >= 4.5),
          `action contrast ${theme}: ${JSON.stringify(contrast)}`,
        );
        measurements.push({ kind: "contrast", theme, locale, contrast });
        for (const size of sizes)
          for (const [name, path] of routes) {
            await page.setViewportSize(size);
            await go(path);
            assert.ok((await overflow()) <= 1, `${name} ${locale} ${theme} ${size.width} overflow`);
            assert.ok(
              (await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)) <= 1,
              `${name} has a second document scrollbar`,
            );
            measurements.push({
              kind: "matrix",
              name,
              locale,
              theme,
              ...size,
              overflow: await overflow(),
            });
            if (
              (size.width === 1440 || size.width === 390) &&
              [
                "production",
                "insights",
                "work-item-detail",
                "run-view",
                "workflow-editor",
                "office",
              ].includes(name)
            )
              await capture(`${name}-${locale}-${theme}-${size.width}`);
          }
      }
    for (const size of sizes) {
      await page.setViewportSize(size);
      await go(`/prod-errors/services?${query}`);
      await page.locator(".service-volume-bar").first().waitFor();
      const geometry = await page.locator(".service-volume-bar").evaluateAll((rows) =>
        rows.map((el) => {
          const r = (e: Element) => {
            const b = e.getBoundingClientRect();
            return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, w: b.width, h: b.height };
          };
          return {
            row: r(el),
            cells: [...el.children].map(r),
            name: r(el.querySelector(".service-identity-name")!),
          };
        }),
      );
      assert.equal(geometry.length, 10);
      for (const row of geometry) {
        for (let i = 0; i < row.cells.length; i++)
          for (let j = i + 1; j < row.cells.length; j++) {
            const a = row.cells[i],
              b = row.cells[j];
            assert.ok(
              Math.min(a.right, b.right) - Math.max(a.x, b.x) <= 1 ||
                Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= 1,
              `overlapping chart cells at ${size.width}`,
            );
          }
        assert.ok(
          row.name.right <= row.row.right && row.name.x >= row.row.x,
          "long service name stays inside its row",
        );
        assert.ok(row.cells[3].w > 0, "share remains visible on mobile");
      }
      assert.ok(
        Math.max(...geometry.map((r) => r.cells[1].x)) -
          Math.min(...geometry.map((r) => r.cells[1].x)) <
          1,
        "bars share a common origin",
      );
      const table = page.locator(".data-table").filter({ has: page.locator(".prioritised-table") });
      const toggle = table.getByRole("button", { name: "Show all metrics", exact: true });
      if (await toggle.isVisible()) {
        await toggle.click();
        assert.ok(
          await table.locator('[data-priority="secondary"]').first().isVisible(),
          "all metrics can be revealed",
        );
        await table.getByRole("button", { name: "Show key metrics", exact: true }).click();
      }
      if (size.width <= 768) {
        const primaryWidth = await table.locator(".table-wrap").evaluate((el) => ({
          width: el.clientWidth,
          scrollWidth: el.scrollWidth,
          table: el.querySelector("table")!.getBoundingClientRect().width,
          cells: [...el.querySelectorAll("th")].map((c) => ({
            text: c.textContent,
            width: c.getBoundingClientRect().width,
            min: getComputedStyle(c).minWidth,
            display: getComputedStyle(c).display,
          })),
        }));
        measurements.push({ kind: "primary-table-width", ...size, ...primaryWidth });
        assert.ok(
          primaryWidth.scrollWidth - primaryWidth.width <= 1,
          `key metrics fit narrow table: ${JSON.stringify(primaryWidth)}`,
        );
      }
      const numeric = await table.locator("tbody tr td:nth-child(2)").evaluateAll((cells) =>
        cells.map((c) => ({
          right: c.getBoundingClientRect().right,
          align: getComputedStyle(c).textAlign,
          numbers: getComputedStyle(c).fontVariantNumeric,
        })),
      );
      assert.ok(
        numeric.every((c) => c.align === "right" && c.numbers.includes("tabular-nums")),
        "numeric cell typography",
      );
      assert.ok(
        Math.max(...numeric.map((c) => c.right)) - Math.min(...numeric.map((c) => c.right)) < 1,
        "numeric columns align",
      );
      const identity = table.locator(".service-identity-name").first();
      assert.equal(
        await identity.evaluate((el) => getComputedStyle(el).fontWeight),
        "600",
        "service text action is semibold",
      );
      assert.equal(
        await identity.evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      measurements.push({ kind: "chart-geometry", ...size, rows: geometry });
      await go(`/prod-errors/incidents?${query}`);
      await page.locator(".filter-toolbar select").first().waitFor();
      const controls = await page
        .locator('.filter-toolbar select,.filter-toolbar input[type="search"]')
        .evaluateAll((c) =>
          c.map((el) => {
            const b = el.getBoundingClientRect();
            return { height: b.height, y: b.y, x: b.x, right: b.right };
          }),
        );
      assert.ok(
        Math.max(...controls.map((c) => c.height)) - Math.min(...controls.map((c) => c.height)) <=
          1,
        "toolbar heights match",
      );
      if (size.width >= 1280)
        assert.ok(
          Math.max(...controls.slice(0, 4).map((c) => c.y)) -
            Math.min(...controls.slice(0, 4).map((c) => c.y)) <=
            1,
          "desktop filter baselines match",
        );
      assert.ok(
        controls.every((c) => c.x >= 0 && c.right <= size.width),
        "toolbar controls are not clipped",
      );
      measurements.push({ kind: "toolbar-geometry", ...size, controls });
    }
    // Initial loading, empty and recoverable error states use the same shared layout.
    await page.route("**/api/analytics/health?**", async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    await page.goto(`${base}/#/prod-errors/overview?from=2026-11-01&to=2026-11-02&severity=medium`);
    await page.locator("main .skeleton").first().waitFor();
    await capture("production-loading");
    await page.locator("main .skeleton").first().waitFor({ state: "hidden" });
    await page.unroute("**/api/analytics/health?**");
    await go(`/insights/usage?${query}&model=ui-quality-missing`);
    await page.locator(".an-refresh").waitFor();
    await capture("empty-table");
    await page.route("**/api/analytics/performance?**", (route) =>
      route.fulfill({ status: 503, json: { error: "UI audit injected outage" } }),
    );
    await page.goto(`${base}/#/insights/performance?${query}`);
    await page.getByText("UI audit injected outage", { exact: false }).waitFor();
    await capture("error-state");
    await page.unroute("**/api/analytics/performance?**");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator(".an-refresh").waitFor();
    // Measure all legacy-compatible size variants with icon + Vietnamese diacritics.
    const controlSizes = await page.evaluate(() => {
      const host = document.createElement("div");
      host.style.display = "flex";
      host.style.gap = "12px";
      document.querySelector("main")!.prepend(host);
      const result = ["xs", "sm", "md", "lg"].map((size) => {
        const el = document.createElement("button");
        el.className = `ui-button ghost ${size}`;
        el.textContent = "Làm mới dữ liệu";
        host.append(el);
        return {
          size,
          height: el.getBoundingClientRect().height,
          expected: parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(`--control-h-${size}`),
          ),
        };
      });
      host.remove();
      return result;
    });
    assert.ok(
      controlSizes.every((c) => Math.abs(c.height - c.expected) <= 1),
      "shared button size variants match tokens",
    );
    measurements.push({ kind: "control-sizes", sizes: controlSizes });
    // Query edits keep keyboard focus; history restores route positions; static tabs never cover range controls.
    await page.setViewportSize({ width: 1440, height: 900 });
    await go(`/prod-errors/incidents?${query}`);
    const search = page.locator('.pe-filters input[type="search"]');
    await search.fill("havotek");
    await search.press("End");
    await search.press("a");
    assert.equal(
      await search.evaluate((el) => document.activeElement === el),
      true,
      "query edit retains input focus",
    );
    assert.ok(page.url().includes("list_search=havoteka"));
    await go(`/prod-errors/overview?${query}`);
    await page.locator(".an-health-bars").waitFor();
    await page.evaluate(() => (document.querySelector("main")!.scrollTop = 650));
    await page.waitForTimeout(50);
    const prior = await page.locator("main").evaluate((el) => el.scrollTop);
    await go("/repositories");
    assert.equal(
      await page.locator("main").evaluate((el) => el.scrollTop),
      0,
      "new route starts at top",
    );
    await page.goBack();
    await page.locator(".an-health-bars").waitFor();
    const restored = await page.locator("main").evaluate((el) => el.scrollTop);
    measurements.push({ kind: "history", prior, restored });
    assert.ok(
      Math.abs(restored - prior) <= 1,
      `history restores page position: ${prior} -> ${restored}`,
    );
    assert.equal(
      await page.locator(".pe-workspace > .tabs").evaluate((el) => getComputedStyle(el).position),
      "static",
    );
    assert.equal(
      await page.evaluate(() => scrollY),
      0,
      "window does not own a second page scrollbar",
    );
    await capture("scroll-restored");
    const scrollChecks = [];
    for (const top of [0, 200, 450, 700, 1500]) {
      await page.locator("main").evaluate((el, top) => {
        el.scrollTop = top;
      }, top);
      await page.waitForTimeout(20);
      scrollChecks.push(
        await page.evaluate(() => ({
          top: document.querySelector("main")!.scrollTop,
          mainY: document.querySelector("main")!.getBoundingClientRect().y,
          windowY: scrollY,
          docHeight: document.documentElement.scrollHeight,
        })),
      );
    }
    assert.ok(
      scrollChecks.every((r) => r.mainY === 60 && r.windowY === 0 && r.docHeight === 900),
      "continuous scroll keeps shell boundaries stable",
    );
    measurements.push({ kind: "scroll-continuity", checks: scrollChecks });
    await page.locator(".an-range-buttons button").first().scrollIntoViewIfNeeded();
    assert.ok(
      await page
        .locator(".an-range-buttons button")
        .first()
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            el ===
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("button")
          );
        }),
      "range control is not obscured",
    );

    // Existing workflow creation drawer: no data submission, bounded viewport and trapped focus.
    await go("/workflows");
    await page.locator(".page-header .ph-actions button").click();
    await page.locator(".drawer").waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const box = await page.locator(".drawer").boundingBox();
      assert.ok(
        box &&
          box.x >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y >= 0 &&
          box.y + box.height <= 845,
        "drawer fits viewport",
      );
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        assert.ok(
          await page.locator(".drawer").evaluate((el) => el.contains(document.activeElement)),
          "drawer traps focus",
        );
      }
      await capture(`workflow-drawer-${width}`);
    }
    await page.keyboard.press("Escape");
    await page.locator(".drawer").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1440, height: 900 });
    // Collapsed sidebar, actual browser CSS zoom and keyboard text-link focus.
    for (const collapsed of [true, false]) {
      const isCollapsed = await page
        .locator(".app")
        .evaluate((el) => el.classList.contains("sidebar-collapsed"));
      if (isCollapsed !== collapsed) await page.locator(".sb-toggle").click();
      for (const zoom of [1.25, 1.5]) {
        await page.evaluate((zoom) => (document.documentElement.style.zoom = String(zoom)), zoom);
        for (const [name, path] of routes) {
          await go(path);
          assert.ok((await overflow()) <= 1, `${name} zoom ${zoom} sidebar ${collapsed}`);
          measurements.push({
            kind: "zoom",
            name,
            zoom,
            collapsed,
            overflow: await overflow(),
            canvasWidth:
              name === "workflow-editor"
                ? await page
                    .locator(".wfe-canvas")
                    .evaluate((el) => el.getBoundingClientRect().width)
                : undefined,
          });
        }
        await go("/workflows/analytics-fixture");
        assert.ok(
          (await page.locator(".wfe-canvas").evaluate((el) => el.getBoundingClientRect().width)) >=
            240,
          "workflow canvas remains usable at zoom",
        );
        await capture(`zoom-${zoom}-sidebar-${collapsed}`);
      }
    }
    await page.evaluate(() => (document.documentElement.style.zoom = ""));
    const cdp = await page.context().newCDPSession(page);
    for (const zoom of [1.25, 1.5]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: Math.round(1440 / zoom),
        height: Math.round(900 / zoom),
        deviceScaleFactor: zoom,
        mobile: false,
      });
      for (const [name, path] of routes) {
        await go(path);
        assert.ok((await overflow()) <= 1, `${name} viewport/DPR zoom ${zoom}`);
        measurements.push({ kind: "viewport-zoom", name, zoom, overflow: await overflow() });
      }
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
    await page.setViewportSize({ width: 1440, height: 900 });

    await go(`/prod-errors/services?${query}`);
    await page.keyboard.press("Tab");
    await page.locator(".service-identity-name.link-button").first().focus();
    assert.notEqual(
      await page
        .locator(".service-identity-name.link-button")
        .first()
        .evaluate((el) => getComputedStyle(el).outlineStyle),
      "none",
    );
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.hash.startsWith("#/prod-errors/service?"));
    await page.locator(".an-service-details").waitFor();
    await capture("service-link-keyboard");
  }
  writeFileSync(
    resolve(out, "measurements.json"),
    JSON.stringify({ phase, errors, measurements }, null, 2),
  );
  assert.deepEqual(
    errors.filter((e) => e !== "UI audit injected outage"),
    [],
  );
  console.log(`${phase}: audited ${routes.length} pages; ${measurements.length} measurements`);
} finally {
  writeFileSync(
    resolve(out, "measurements.json"),
    JSON.stringify({ phase, errors, measurements }, null, 2),
  );
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
