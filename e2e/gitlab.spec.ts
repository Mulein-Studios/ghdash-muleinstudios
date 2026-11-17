// The studio of a site whose repository is on GitLab: the same build, with the studio data and page saying so.
import { existsSync, readdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

test.skip(!existsSync("dist/client/studio-api/entry.js"), "browser API bundle not built into dist/client/studio-api");

const API = "https://gitlab.com/api/v4";
const PROJECT = "group/sub/site";

type Action = { action: string; file_path: string; content?: string; encoding?: string };
type Fake = { head: string; canPush: boolean; commits: Array<{ branch: string; message: string; actions: Action[] }>; existing: string[] };

async function asGitLabSite(page: Page, fake: Fake) {
	await page.route("**/studio-data/content.json", async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		fake.head = body.meta.head;
		body.meta = { ...body.meta, provider: "gitlab", repo: PROJECT, branch: "main", apiUrl: API, webUrl: "https://gitlab.com" };
		await route.fulfill({ response: res, json: body });
	});
	await page.route(/\/studio\/(\?.*)?$/, async (route) => {
		const res = await route.fetch();
		const html = (await res.text())
			.replace(/<meta name="studio-oauth"[^>]*>/, "")
			.replace("https://api.github.com", "https://gitlab.com");
		await route.fulfill({ response: res, body: html });
	});
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.slice("/api/v4".length);
		const proj = `/projects/${encodeURIComponent(PROJECT)}`;
		const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
			route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
		if (req.headers()["authorization"] !== "Bearer glpat-fake") return json({ message: "401 Unauthorized" }, 401);
		if (path === proj) return json({ default_branch: "main" });
		if (path.startsWith(`${proj}/repository/branches/`)) return json({ can_push: fake.canPush, commit: { id: fake.head } });
		if (path === `${proj}/repository/tree`) {
			const dir = url.searchParams.get("path")!;
			const items = fake.existing.filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ type: "blob", path: p, id: p }));
			return items.length ? json(items, 200, { "x-next-page": "" }) : json({ message: "404 Tree Not Found" }, 404);
		}
		if (path.startsWith(`${proj}/repository/files/`) && req.method() === "HEAD") {
			const file = decodeURIComponent(path.slice(`${proj}/repository/files/`.length));
			return fake.existing.includes(file)
				? route.fulfill({
						status: 200,
						// As gitlab.com does: the header is readable from the page only because GitLab exposes it to CORS.
						headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "X-Gitlab-Last-Commit-Id", "x-gitlab-last-commit-id": "last-of-" + file },
					})
				: route.fulfill({ status: 404 });
		}
		if (path === `${proj}/repository/commits` && req.method() === "POST") {
			const body = req.postDataJSON();
			fake.commits.push({ branch: body.branch, message: body.commit_message, actions: body.actions });
			fake.head = `gl-commit-${fake.commits.length}`;
			return json({ id: fake.head }, 201);
		}
		return json({ message: `unhandled ${req.method()} ${path}` }, 500);
	});
}

async function editDraftPage(page: Page, title: string) {
	await page.getByRole("link", { name: "Pages" }).first().click();
	await page.getByText(/Capabilities|Tray edit/).first().click();
	await page.getByLabel("Title").first().fill(title);
	await page.getByRole("button", { name: /^Save/ }).first().click();
	await expect(page.getByText("Saved")).toBeVisible();
}

test("on GitLab the studio asks for a GitLab token and commits through the GitLab API", async ({ page }) => {
	const fake: Fake = { head: "", canPush: true, commits: [], existing: [] };
	await asGitLabSite(page, fake);
	await page.goto("studio/");
	await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
	await editDraftPage(page, "Edited on GitLab");
	const parent = fake.head;
	await page.getByTestId("tray-button").click();
	await expect(page.getByTestId("tray-github-signin")).toHaveCount(0);
	await page.getByText("What token do I need?").click();
	await expect(page.getByRole("link", { name: "Create a personal access token" })).toHaveAttribute("href", /gitlab\.com\/-\/user_settings\/personal_access_tokens\?.*scopes=api/);
	fake.existing = readdirSync("content/ec_pages").map((f) => `content/ec_pages/${f}`);
	await page.getByLabel(/GitLab token/).fill("glpat-fake");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.getByLabel("Commit message").fill("Edit from GitLab");
	await page.getByRole("button", { name: /^Commit/ }).click();
	await expect(page.getByTestId("tray-done")).toBeVisible();
	await expect(page.getByTestId("tray-done").getByRole("link").first()).toHaveAttribute("href", `https://gitlab.com/${PROJECT}/-/commit/gl-commit-1`);
	await expect(page.getByRole("link", { name: "watch the build" })).toHaveAttribute("href", `https://gitlab.com/${PROJECT}/-/pipelines`);
	expect(fake.commits).toHaveLength(1);
	expect(fake.commits[0]!.message).toBe("Edit from GitLab");
	expect(fake.commits[0]!.branch).toBe("main");
	const [action] = fake.commits[0]!.actions;
	expect(fake.commits[0]!.actions).toHaveLength(1);
	expect(action!.file_path).toMatch(/^content\/ec_pages\/.+\.json$/);
	expect(action!.action).toBe("update");
	expect((action as Action & { last_commit_id?: string }).last_commit_id).toBe(`last-of-${action!.file_path}`);
	expect(JSON.parse(action!.content!).title).toBe("Edited on GitLab");
	expect(parent).not.toBe("");
	await expect(page.getByTestId("tray-count")).toHaveText("0");
});

test("a GitLab token that can't push to the branch is refused at sign-in", async ({ page }) => {
	await asGitLabSite(page, { head: "", canPush: false, commits: [], existing: [] });
	await page.goto("studio/");
	await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
	await page.getByTestId("tray-button").click();
	await page.getByLabel(/GitLab token/).fill("glpat-fake");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("can read the repository but not push");
});

test("Sign in with GitLab goes to GitLab and trades the code at GitLab's own token endpoint", async ({ page }) => {
	await asGitLabSite(page, { head: "", canPush: true, commits: [], existing: [] });
	await page.addInitScript(() => {
		(globalThis as any).__STUDIO_OAUTH__ = { clientId: "gl-app" };
	});
	let authorize: URL | undefined;
	await page.route("https://gitlab.com/oauth/authorize**", (route) => {
		authorize = new URL(route.request().url());
		return route.fulfill({ status: 200, contentType: "text/html", body: "<p>GitLab</p>" });
	});
	let traded: URLSearchParams | undefined;
	await page.route("https://gitlab.com/oauth/token", (route) => {
		const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
		if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
		traded = new URLSearchParams(route.request().postData() ?? "");
		return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify({ access_token: "glpat-fake", token_type: "Bearer" }) });
	});
	await page.goto("studio/");
	await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
	await page.getByTestId("tray-button").click();
	await expect(page.getByTestId("tray-github-signin")).toHaveText("Sign in with GitLab");
	await page.getByTestId("tray-github-signin").click();
	await expect.poll(() => authorize?.searchParams.get("client_id")).toBe("gl-app");
	expect(authorize!.searchParams.get("scope")).toBe("api");
	expect(authorize!.searchParams.get("code_challenge_method")).toBe("S256");
	const redirect = authorize!.searchParams.get("redirect_uri")!;
	await page.goto(`${redirect}?code=c123&state=${authorize!.searchParams.get("state")}`);
	await expect(page.getByTestId("tray-button")).toBeVisible({ timeout: 30_000 });
	await page.getByTestId("tray-button").click();
	await expect(page.getByLabel("Commit message")).toBeVisible();
	expect(traded?.get("code")).toBe("c123");
	expect(traded?.get("client_id")).toBe("gl-app");
	expect(traded?.get("grant_type")).toBe("authorization_code");
	expect(traded?.get("code_verifier")).toBeTruthy();
});
