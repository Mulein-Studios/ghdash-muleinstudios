// Needs the browser API in public/studio-api (any `npm run build` puts it there).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const cli = (...args) => execFileSync("npx", ["gitdash-pages", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

test("a scheduled post that is due gets published at its scheduled time and one in the future does not", { skip: !existsSync("public/studio-api/entry.js") }, () => {
	const dir = mkdtempSync(join(tmpdir(), "publish-due-"));
	const db = join(dir, "x.db");
	cli("build-db", db);
	const raw = new DatabaseSync(db);
	const [due, later] = raw.prepare("select id from ec_posts order by id limit 2").all().map((r) => r.id);
	assert.ok(due && later, "the fixture needs two posts");
	raw.prepare("update ec_posts set status = 'scheduled', scheduled_at = ?, published_at = null, draft_revision_id = live_revision_id, live_revision_id = null where id = ?").run("2026-01-02T03:04:05.000Z", due);
	raw.prepare("update ec_posts set status = 'scheduled', scheduled_at = ?, published_at = null, draft_revision_id = live_revision_id, live_revision_id = null where id = ?").run("2099-01-01T00:00:00.000Z", later);
	raw.close();

	const out = join(dir, "content");
	const log = cli("publish-due", db, out);
	assert.match(log, /published 1/);
	const post = (id) => JSON.parse(readFileSync(join(out, "ec_posts", `${id}.json`), "utf8"));
	assert.equal(post(due).status, "published");
	assert.equal(post(due).published_at, "2026-01-02T03:04:05.000Z");
	assert.equal(post(due).scheduled_at, null);
	assert.equal(post(later).status, "scheduled");
	assert.ok(readdirSync(out).includes("_ddl.json"));
});
