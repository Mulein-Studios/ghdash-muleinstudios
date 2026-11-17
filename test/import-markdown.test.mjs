// Needs network (or BROWSER_API_DIR) for the browser API that `import-markdown` downloads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("import-markdown turns a Jekyll site into posts and pages in content/, with tags, dates and images", { timeout: 180_000 }, () => {
	const work = mkdtempSync(join(tmpdir(), "import-"));
	cpSync("content", join(work, "content"), { recursive: true });
	cpSync("package.json", join(work, "package.json"));
	symlinkSync(resolve("node_modules"), join(work, "node_modules"));
	const bin = resolve("node_modules/@digitaldefiance/gitdash-pages/bin/gitdash-pages.mjs");
	const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: work, encoding: "utf8" });

	const first = run("import-markdown", resolve("test/fixtures/jekyll"));
	assert.equal(first.status, 0, first.stdout + first.stderr);
	assert.match(first.stdout, /imported 4 entries, skipped 0/);

	const rows = (c) => readdirSync(join(work, "content", c)).map((f) => JSON.parse(readFileSync(join(work, "content", c, f), "utf8")));
	const post = rows("ec_posts").find((r) => r.slug === "first-post");
	assert.equal(post.title, "First: a post");
	assert.equal(post.status, "published");
	assert.equal(post.published_at, "2024-03-05T00:00:00.000Z");
	assert.equal(post.excerpt, "A short summary");
	assert.match(post.content, /\/_emdash\/api\/media\/file\/[0-9a-f]{8}-pic\.png/);
	assert.equal(rows("ec_posts").find((r) => r.slug === "wip").status, "draft");
	assert.equal(rows("ec_posts").find((r) => r.slug === "second").title, "Second heading title");
	assert.equal(rows("ec_pages").find((r) => r.slug === "uses").title, "Uses");
	const terms = JSON.parse(readFileSync(join(work, "content/taxonomies.json"), "utf8"));
	for (const slug of ["alpha", "beta", "news"]) assert.ok(terms.some((t) => t.slug === slug), slug);
	assert.equal(readdirSync(join(work, "media")).length, 1);
	const library = JSON.parse(readFileSync(join(work, "content/media.json"), "utf8"));
	const imported = library.find((item) => item.filename === "pic.png");
	assert.ok(imported);
	assert.equal(imported.storage_key, readdirSync(join(work, "media"))[0]);
	assert.equal(imported.status, "ready");
	assert.ok(existsSync(join(work, "content/revisions")));

	const again = run("import-markdown", resolve("test/fixtures/jekyll"));
	assert.equal(again.status, 0, again.stdout + again.stderr);
	assert.match(again.stdout, /imported 0 entries, skipped 4/);
});
