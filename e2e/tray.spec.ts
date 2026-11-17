import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

test.skip(!existsSync("dist/client/studio-api/entry.js"), "browser API bundle not built into dist/client/studio-api");

const contentFiles = (dir = "content", prefix = ""): Record<string, string> =>
	Object.fromEntries(
		readdirSync(dir).flatMap((n) => {
			const p = join(dir, n);
			return statSync(p).isDirectory() ? Object.entries(contentFiles(p, `${prefix}${n}/`)) : [[`${prefix}${n}`, readFileSync(p, "utf8")]];
		}),
	);

type Fake = { head: string; commits: Array<{ message: string; tree: Array<{ path: string; content?: string | null; sha?: string | null }>; parent: string }>; remoteFiles?: Record<string, string>; uploaded?: Buffer[] };

/** A just-enough GitHub API: access check, ref, commit, tree, blob, and fast-forward or conflict on update. */
async function fakeGitHub(page: Page, fake: Fake) {
	const blobs = new Map<string, string>();
	await page.route("https://api.github.com/**", async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
		const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (req.method() === "GET" && path === "") return json({ permissions: { push: true }, default_branch: "main" });
		if (req.method() === "GET" && path.startsWith("/git/ref/heads/")) return json({ object: { sha: fake.head } });
		if (req.method() === "GET" && path.startsWith("/git/commits/")) return json({ tree: { sha: "tree0" } });
		if (req.method() === "GET" && path.startsWith("/git/trees/")) {
			const files = fake.remoteFiles ?? {};
			return json({ tree: Object.keys(files).map((p) => { const sha = `blob-${p}`; blobs.set(sha, files[p]!); return { type: "blob", path: `content/${p}`, sha }; }) });
		}
		if (req.method() === "GET" && path.startsWith("/git/blobs/")) {
			const text = blobs.get(decodeURIComponent(path.slice("/git/blobs/".length)))!;
			return json({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
		}
		if (req.method() === "POST" && path === "/git/blobs") {
			const sha = `blob-new-${fake.uploaded?.length ?? 0}`;
			(fake.uploaded ??= []).push(Buffer.from(req.postDataJSON().content, "base64"));
			return json({ sha });
		}
		if (req.method() === "POST" && path === "/git/trees") { (fake as any)._tree = req.postDataJSON().tree; return json({ sha: "tree1" }); }
		if (req.method() === "POST" && path === "/git/commits") {
			const body = req.postDataJSON();
			fake.commits.push({ message: body.message, tree: (fake as any)._tree, parent: body.parents[0] });
			return json({ sha: `commit${fake.commits.length}` });
		}
		if (req.method() === "PATCH" && path.startsWith("/git/refs/heads/")) { fake.head = req.postDataJSON().sha; return json({}); }
		return json({ message: `unhandled ${req.method()} ${path}` }, 500);
	});
}

async function headOfSite(page: Page) {
	const res = await page.request.get("studio-data/content.json");
	return (await res.json()).meta.head as string;
}

async function openStudio(page: Page) {
	await page.goto("studio/");
	await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
}

async function editDraftPage(page: Page, title: string) {
	await page.getByRole("link", { name: "Pages" }).first().click();
	await page.getByText(/Capabilities|Tray edit/).first().click();
	await page.getByLabel("Title").first().fill(title);
	await page.getByRole("button", { name: /^Save/ }).first().click();
	await expect(page.getByText("Saved")).toBeVisible();
}

async function upload(page: Page, name: string, buffer: Buffer) {
	await page.getByRole("button", { name: "Upload Files" }).first().click();
	await page.getByLabel("Browse files to upload").setInputFiles({ name, mimeType: "image/png", buffer });
	await expect(page.getByTestId("tray-count")).toHaveText("1");
	await page.keyboard.press("Escape");
}

test.describe("pending-changes tray", () => {
	test("starts empty, counts an edit, and discard puts it back", async ({ page }) => {
		await openStudio(page);
		await expect(page.getByTestId("tray-count")).toHaveText("0");
		await editDraftPage(page, "Tray edit");
		await expect(page.getByTestId("tray-count")).toHaveText("1");
		await page.getByTestId("tray-button").click();
		await expect(page.getByTestId("tray-list")).toContainText("Edited");
		await expect(page.getByTestId("tray-list")).toContainText("Tray edit");
		await page.getByRole("button", { name: "Discard Tray edit" }).click();
		await expect(page.getByTestId("tray-count")).toHaveText("0");
	});

	test("the token prompt explains which token to create", async ({ page }) => {
		await openStudio(page);
		await editDraftPage(page, "Tray edit");
		await page.getByTestId("tray-button").click();
		await page.getByText("What token do I need?").click();
		const link = page.getByRole("link", { name: "Create a fine-grained token" });
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute("href", /github\.com\/settings\/personal-access-tokens\/new/);
	});

	test("pending changes survive a reload", async ({ page }) => {
		await openStudio(page);
		await editDraftPage(page, "Tray edit");
		await expect(page.getByTestId("tray-count")).toHaveText("1");
		await page.reload();
		await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("tray-count")).toHaveText("1");
	});

	test("commit sends the changed rows as one commit", async ({ page }) => {
		const fake: Fake = { head: await headOfSite(page), commits: [] };
		await fakeGitHub(page, fake);
		const parent = fake.head;
		await openStudio(page);
		await editDraftPage(page, "Tray edit");
		await page.getByTestId("tray-button").click();
		await page.getByLabel(/GitHub token/).fill("ghp_faketoken");
		await page.getByRole("button", { name: "Sign in" }).click();
		await page.getByLabel("Commit message").fill("Edit the draft");
		await page.getByRole("button", { name: /^Commit/ }).click();
		await expect(page.getByTestId("tray-done")).toBeVisible();
		expect(fake.commits).toHaveLength(1);
		expect(fake.commits[0]!.message).toBe("Edit the draft");
		expect(fake.commits[0]!.parent).toBe(parent);
		expect(fake.commits[0]!.tree).toHaveLength(1);
		expect(fake.commits[0]!.tree[0]!.path).toMatch(/^content\/ec_pages\/.+\.json$/);
		expect(JSON.parse(fake.commits[0]!.tree[0]!.content!).title).toBe("Tray edit");
		await expect(page.getByTestId("tray-count")).toHaveText("0");
	});

	test("a moved branch keeps my changes and merges the upstream ones", async ({ page }) => {
		const files = contentFiles();
		const others = Object.keys(files).filter((p) => p.startsWith("ec_posts/") && files[p]!.includes("The Ecstasy of Gold"));
		const theirs = JSON.parse(files[others[0]!]!);
		const remoteFiles = { ...files, [others[0]!]: JSON.stringify({ ...theirs, title: "Changed upstream" }, null, "\t") + "\n" };
		const fake: Fake = { head: "someone-else-pushed", commits: [], remoteFiles };
		await fakeGitHub(page, fake);
		await openStudio(page);
		await editDraftPage(page, "Tray edit");
		await page.getByTestId("tray-button").click();
		await page.getByLabel(/GitHub token/).fill("ghp_faketoken");
		await page.getByRole("button", { name: "Sign in" }).click();
		await page.getByRole("button", { name: /^Commit/ }).click();
		await expect(page.getByRole("alert")).toContainText("Someone changed");
		expect(fake.commits).toHaveLength(0);
		await page.getByRole("button", { name: /Update my copy/ }).click();
		await expect(page.getByTestId("tray-list")).toContainText("Tray edit");
		await expect(page.getByTestId("tray-list")).not.toContainText("Changed upstream");
		await page.getByRole("link", { name: "Posts" }).first().click();
		await expect(page.getByText("Changed upstream")).toBeVisible();
		await page.getByTestId("tray-button").click();
		await page.getByRole("button", { name: /^Commit/ }).click();
		await expect(page.getByTestId("tray-done")).toBeVisible();
		expect(fake.commits).toHaveLength(1);
		expect(fake.commits[0]!.parent).toBe("someone-else-pushed");
		expect(fake.commits[0]!.tree).toHaveLength(1);
	});

	test("an uploaded image is listed as a pending file, kept across a reload, and committed as bytes", async ({ page }) => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
		const fake: Fake = { head: await headOfSite(page), commits: [] };
		await fakeGitHub(page, fake);
		await openStudio(page);
		await page.getByRole("link", { name: "Media" }).first().click();
		await upload(page, "pixel.png", png);
		await expect(page.getByTestId("tray-count")).toHaveText("1");
		await page.getByTestId("tray-button").click();
		await expect(page.getByTestId("tray-list")).toContainText("pixel.png");
		await expect(page.getByTestId("tray-list")).toContainText("New");
		await page.reload();
		await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("tray-count")).toHaveText("1");
		await page.getByTestId("tray-button").click();
		await page.getByLabel(/GitHub token/).fill("ghp_faketoken");
		await page.getByRole("button", { name: "Sign in" }).click();
		await page.getByRole("button", { name: /^Commit/ }).click();
		await expect(page.getByTestId("tray-done")).toBeVisible();
		const paths = fake.commits[0]!.tree.map((t) => t.path);
		expect(paths.some((p) => /^media\/.+\.png$/.test(p))).toBe(true);
		expect(paths).toContain("content/media.json");
		expect(fake.uploaded).toHaveLength(1);
		expect(fake.uploaded![0]!.equals(png)).toBe(true);
	});

	test("discarding a pending upload removes the file and its media entry", async ({ page }) => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
		await openStudio(page);
		await page.getByRole("link", { name: "Media" }).first().click();
		await upload(page, "gone.png", png);
		await expect(page.getByTestId("tray-count")).toHaveText("1");
		await page.getByTestId("tray-button").click();
		await page.getByRole("button", { name: "Discard gone.png" }).click();
		await expect(page.getByTestId("tray-count")).toHaveText("0");
	});

	test("scheduling a draft page shows up as a pending change", async ({ page }) => {
		await openStudio(page);
		const result = await page.evaluate(async () => {
			const { fetch: f, apiBase } = (globalThis as any).__EMDASH_PATHS__;
			const h = { "X-EmDash-Request": "1", "Content-Type": "application/json" };
			const list = await (await f(`${apiBase}/content/pages?status=draft&limit=5`, { headers: h })).json();
			const id = list.data.items[0].id;
			const res = await f(`${apiBase}/content/pages/${id}/schedule`, { method: "POST", headers: h, body: JSON.stringify({ scheduledAt: "2099-01-01T00:00:00.000Z" }) });
			return { status: res.status, item: (await res.json()).data?.item };
		});
		expect(result.status).toBe(200);
		expect(result.item.status).toBe("scheduled");
		await expect(page.getByTestId("tray-count")).toHaveText("1");
		await page.getByTestId("tray-button").click();
		await expect(page.getByTestId("tray-list")).toContainText("Edited");
	});
});

test("an uploaded image that is not committed yet loads from the CMS media URL inside the studio", async ({ page }) => {
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
	await openStudio(page);
	await page.getByRole("link", { name: "Media" }).first().click();
	await upload(page, "inline.png", png);
	await page.evaluate(() => navigator.serviceWorker.ready);
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
	const width = await page.evaluate(async () => {
		const { fetch: f, apiBase } = (globalThis as any).__EMDASH_PATHS__;
		const list = await (await f(`${apiBase}/media`, { headers: { "X-EmDash-Request": "1" } })).json();
		const key = list.data.items[0].storageKey;
		const img = new Image();
		img.src = `/_emdash/api/media/file/${key}`;
		await img.decode();
		return img.naturalWidth;
	});
	expect(width).toBe(1);
});

test.describe("sign in with GitHub", () => {
	test("the button starts the GitHub flow and the redirect back signs the editor in", async ({ page }) => {
		const fake: Fake = { head: await headOfSite(page), commits: [] };
		await fakeGitHub(page, fake);
		await page.addInitScript(() => {
			(globalThis as any).__STUDIO_OAUTH__ = { clientId: "Iv1.test", exchangeUrl: "https://signin.test/exchange" };
		});
		// A real site lists its Worker in connect-src when it is built with github-oauth.json; this build has none.
		await page.route("**/studio/**", async (route) => {
			if (route.request().resourceType() !== "document") return route.fallback();
			const res = await route.fetch();
			const body = (await res.text())
				.replace(/<meta name="studio-oauth"[^>]*>/, "")
				.replace("connect-src 'self'", "connect-src 'self' https://signin.test");
			return route.fulfill({ response: res, body });
		});
		let authorize: URL | undefined;
		await page.route("https://github.com/login/oauth/authorize**", (route) => {
			authorize = new URL(route.request().url());
			return route.fulfill({ status: 200, contentType: "text/html", body: "<p>GitHub</p>" });
		});
		let exchanged: Record<string, string> | undefined;
		await page.route("https://signin.test/exchange", (route) => {
			const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
			if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
			exchanged = route.request().postDataJSON();
			return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify({ access_token: "ghu_faketoken" }) });
		});

		await openStudio(page);
		await editDraftPage(page, "Tray edit");
		await page.getByTestId("tray-button").click();
		await page.getByTestId("tray-github-signin").click();
		await expect.poll(() => authorize?.searchParams.get("client_id")).toBe("Iv1.test");
		expect(authorize!.searchParams.get("code_challenge_method")).toBe("S256");
		const state = authorize!.searchParams.get("state")!;
		const redirect = authorize!.searchParams.get("redirect_uri")!;
		expect(redirect).toMatch(/\/studio\/$/);

		await page.goto(`${redirect}?code=abc123&state=${state}`);
		await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
		await page.getByTestId("tray-button").click();
		await expect(page.getByLabel("Commit message")).toBeVisible();
		expect(exchanged?.code).toBe("abc123");
		expect(exchanged?.redirect_uri).toBe(redirect);
		expect(page.url()).not.toContain("code=");
	});

	test("without a configured sign-in there is only the token form", async ({ page }) => {
		await openStudio(page);
		await editDraftPage(page, "Tray edit");
		await page.getByTestId("tray-button").click();
		await expect(page.getByLabel(/GitHub token/)).toBeVisible();
		await expect(page.getByTestId("tray-github-signin")).toHaveCount(0);
	});
});
