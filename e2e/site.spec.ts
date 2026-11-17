import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { BASE } from "./base";

const pages = ["", "posts/", "pages/portfolio/", "pages/support/", "category/music/", "rss.xml"];

test.describe("static site", () => {
	test.beforeEach(async ({ page }) => {
		await page.route("https://use.typekit.net/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
		await page.route("https://www.youtube.com/embed/**", (route) => route.fulfill({ contentType: "text/html", body: "" }));
	});
	for (const path of pages) {
		test(`/${path} renders`, async ({ page }) => {
			const failed: string[] = [];
			page.on("requestfailed", (r) => {
				if (new URL(r.url()).hostname === "localhost") failed.push(r.url());
			});
			const res = await page.goto(path);
			expect(res?.status(), path).toBe(200);
			expect(failed).toEqual([]);
		});
	}

	test("internal links keep the base path", async ({ page }) => {
		await page.goto("");
		const hrefs = await page.locator("a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
		expect(hrefs.length).toBeGreaterThan(0);
		for (const h of hrefs) expect(h.startsWith(`${BASE}/`), h).toBe(true);
	});

	test("a post page shows its title", async ({ page }) => {
		await page.goto("posts/");
		const first = page.locator("main .post__link").first();
		const title = await first.getByRole("heading").innerText();
		await first.click();
		await expect(page.locator("h1").first()).toContainText(title);
	});

	test("a long archive is split into pages with plain links", async ({ page }) => {
		await page.goto("posts/");
		const next = page.getByRole("link", { name: /Older posts/ });
		test.skip((await next.count()) === 0, "built with a page size that fits every post on one page");
		await expect(page.getByText(/^Page 1 of \d+$/)).toBeVisible();
		await next.click();
		await expect(page).toHaveURL(/\/posts\/page\/2\/?$/);
		await expect(page.getByText(/^Page 2 of \d+$/)).toBeVisible();
		await page.getByRole("link", { name: /Newer posts/ }).click();
		await expect(page).toHaveURL(/\/posts\/?$/);
	});

	test("search finds a post and links to it under the base path", async ({ page }) => {
		await page.goto("search/");
		await page.locator("#search-query").fill("trolley");
		await page.locator("#search-form").getByRole("button", { name: "Search" }).click();
		const link = page.locator("#search-list a").first();
		await expect(link).toContainText(/the trolley problem/i);
		expect(await link.getAttribute("href")).toMatch(new RegExp(`^${BASE}/posts/.+`));
		await link.click();
		await expect(page.locator("h1").first()).toContainText(/the trolley problem/i);
	});

	test("search says so when nothing matches", async ({ page }) => {
		await page.goto("search/?q=zzzzqqqq");
		await expect(page.getByText(/No results for/)).toBeVisible();
	});

	test("sitemap, robots and the feed use absolute URLs under the base path", async ({ request, baseURL }) => {
		const origin = new URL(baseURL!).origin;
		const sitemap = await (await request.get("sitemap.xml")).text();
		const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
		expect(locs.length).toBeGreaterThan(3);
		for (const l of locs) expect(l.startsWith(`${origin}${BASE}/`), l).toBe(true);
		const robots = await (await request.get("robots.txt")).text();
		expect(robots).toContain(`Sitemap: ${origin}${BASE}/sitemap.xml`);
		expect(robots).toContain("Disallow: /studio/");
		const rss = await (await request.get("rss.xml")).text();
		expect(rss).toMatch(new RegExp(`<link>[^<]*${BASE}/posts/[^<]+</link>`));
	});

	test("legacy WordPress links resolve to the migrated content", async ({ page }) => {
		await page.goto("2026/08/25/hope/");
		await expect(page).toHaveURL(`${BASE}/posts/hope/`);
		await expect(page.getByRole("heading", { name: "Hope", exact: true })).toBeVisible();
		await expect(page.locator('iframe[src*="youtube.com/embed/"]')).toHaveCount(2);
		await expect.poll(() => page.locator(".record__artwork img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
		await page.goto("portfolio/");
		await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
	});

	test("a post shows the discussion thread only when giscus is configured", async ({ page }) => {
		await page.goto("posts/hope/");
		const script = page.locator('script[src="https://giscus.app/client.js"]');
		if (existsSync("giscus.json")) {
			await expect(script).toHaveAttribute("data-term", "hope");
			await expect(page.getByRole("heading", { name: "Discussion" })).toBeVisible();
		} else {
			await expect(script).toHaveCount(0);
			await expect(page.getByRole("heading", { name: "Discussion" })).toHaveCount(0);
		}
	});
});
