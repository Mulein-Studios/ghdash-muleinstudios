import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function tree(dir, prefix = "") {
	const out = new Map();
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) for (const [k, v] of tree(p, `${prefix}${name}/`)) out.set(k, v);
		else out.set(prefix + name, readFileSync(p, "utf8"));
	}
	return out;
}

test("content/ -> data.db -> content/ gives back the same files", () => {
	const work = mkdtempSync(join(tmpdir(), "roundtrip-"));
	const db = join(work, "data.db");
	const out = join(work, "content");
	// Prerendering can populate EmDash's redirect cache in the production build database.
	execFileSync("npx", ["gitdash-pages", "build-db", db], { stdio: "pipe" });
	execFileSync("npx", ["gitdash-pages", "export-content", db, out], { stdio: "pipe" });
	const before = tree("content");
	const after = tree(out);
	assert.deepEqual([...after.keys()], [...before.keys()]);
	for (const [path, text] of before) assert.equal(after.get(path), text, path);
});
