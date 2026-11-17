import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

test.skip(!existsSync("dist/client/studio-api/entry.js"), "browser API bundle not built into dist/client/studio-api");

type Fake = { head: string; commits: Array<{ message: string; tree: Array<{ path: string; content?: string | null; sha?: string | null }>; parent: string }>; remoteFiles?: Record<string, string>; uploaded?: Buffer[] };

/** A just-enough GitHub API: access check, ref, commit, tree, blob, and fast-forward or conflict on update. */
async function fakeGitHub(page: import("@playwright/test").Page, fake: Fake) {
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

async function headOfSite(page: import("@playwright/test").Page) {
	const res = await page.request.get("studio-data/content.json");
	return (await res.json()).meta.head as string;
}

async function openStudio(page: import("@playwright/test").Page) {
	await page.goto("studio/");
	await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
}


test("a team member's photo is picked from the media library and committed with the image bytes", async ({ page }) => {
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
	const fake: Fake = { head: await headOfSite(page), commits: [] };
	await fakeGitHub(page, fake);
	await openStudio(page);
	await page.getByRole("link", { name: "Media" }).first().click();
	await page.getByRole("button", { name: "Upload Files" }).first().click();
	await page.getByLabel("Browse files to upload").setInputFiles({ name: "ada.png", mimeType: "image/png", buffer: png });
	await expect(page.getByTestId("tray-count")).toHaveText("1");
	await page.keyboard.press("Escape");

	await page.getByRole("link", { name: "Team" }).first().click();
	await page.getByRole("link", { name: /Add New/ }).first().click();
	await page.getByLabel("Name", { exact: true }).fill("Ada Rivera");
	await page.getByRole("button", { name: "Select image" }).first().click();
	await page.getByRole("dialog").getByRole("button", { name: "ada.png", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Select", exact: true }).click();
	await page.getByRole("button", { name: /^Save/ }).first().click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();

	await page.getByTestId("tray-button").click();
	await page.getByLabel(/GitHub token/).fill("ghp_faketoken");
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.getByRole("button", { name: /^Commit/ }).click();
	await expect(page.getByTestId("tray-done")).toBeVisible();

	const tree = fake.commits[0]!.tree;
	expect(tree.some((t) => /^media\/.+\.png$/.test(t.path))).toBe(true);
	const row = tree.find((t) => /^content\/ec_team\//.test(t.path) && t.content?.includes('"slug": "ada-rivera"'));
	expect(row, "the team member file is in the commit").toBeTruthy();
	const photo = JSON.parse(row!.content!).photo;
	expect(photo).toBeTruthy();
});
