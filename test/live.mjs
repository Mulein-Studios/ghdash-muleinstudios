// Real-GitHub check of the tray's commit and update flows, on a throwaway branch that is deleted afterwards.
// node test/live.mjs   (needs public/studio-data built, and either GH_TOKEN set to a token with Contents read/write
// on this repo, or a sandbox proxy that attaches one; .github/workflows/live.yml runs it with the GITDASH_LIVE_TOKEN secret)
import init from "@sqlite.org/sqlite-wasm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createController } from "@digitaldefiance/gitdash-pages/studio/controller.js";
import { commitFiles } from "@digitaldefiance/gitdash-pages/studio/github-commit.js";
import { openDb } from "@digitaldefiance/gitdash-pages/studio/load-db.js";
import { snapshot } from "@digitaldefiance/gitdash-pages/studio/tray.js";

const content = JSON.parse(readFileSync("public/studio-data/content.json", "utf8"));
const [owner, repo] = content.meta.repo.split("/");
const realToken = process.env.GH_TOKEN || "";
const auth = realToken ? { Authorization: `Bearer ${realToken}` } : {};
const api = async (method, path, body) => {
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
		method, headers: { Accept: "application/vnd.github+json", ...auth, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body),
	});
	if (res.status === 204) return null;
	const json = await res.json();
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.message}`);
	return json;
};
// The controller only holds a placeholder token: swap in the real one, or drop it when a proxy attaches the token.
const fetchImpl = (url, init = {}) => {
	const headers = { ...init.headers, ...auth }; if (!realToken) delete headers.Authorization;
	return fetch(url, { ...init, headers });
};

const branch = `studio-live-test-${Date.now()}`;
const main = (await api("GET", "/git/ref/heads/main")).object.sha;
await api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: main });
console.log(`scratch branch ${branch} from ${main.slice(0, 7)}`);
try {
	const sqlite = await init({ print() {}, printErr() {} });
	const { db, freshNames } = openDb(sqlite, readFileSync("public/studio-data/empty.db"), content);
	const store = { get: async () => null, set: async () => {}, del: async () => {} };
	const storage = { _v: "placeholder", getItem() { return this._v; }, setItem(k, v) { this._v = v; }, removeItem() { this._v = null; } };
	const c = createController({ db, freshNames, baseFiles: snapshot(db, freshNames), meta: { ...content.meta, branch, head: main }, fetchImpl, storage, store });

	db.exec("update ec_pages set title = 'Live test edit' where slug = 'capabilities'");
	c.refresh();
	assert.equal(c.getState().changes.length, 1);
	await c.commit("Live test: edit a draft");
	const done = c.getState().status;
	assert.equal(done.kind, "done", JSON.stringify(done));
	const after = await api("GET", `/git/commits/${done.sha}`);
	assert.equal(after.parents[0].sha, main);
	assert.equal(after.message, "Live test: edit a draft");
	const changed = await api("GET", `/commits/${done.sha}`);
	assert.deepEqual(changed.files.map((f) => f.filename.replace(/ec_pages\/[^/]+\.json$/, "ec_pages/<id>.json")), ["content/ec_pages/<id>.json"]);
	console.log("PASS commit: one parent, one file, message kept");

	// Someone else pushes to the branch; our next commit must not overwrite it silently.
	const other = content.tables.ec_posts[0];
	const otherPath = `content/ec_posts/${other.id}.json`;
	const text = JSON.stringify({ ...Object.fromEntries(Object.keys(other).sort().map((k) => [k, other[k]])), title: "Changed upstream (live test)" }, null, "\t") + "\n";
	const token = "placeholder";
	await commitFiles({ token, owner, repo, branch, files: { [otherPath]: text }, message: "Live test: upstream change", fetchImpl });
	db.exec("update ec_pages set title = 'Live test edit 2' where slug = 'capabilities'");
	c.refresh();
	await c.commit("Live test: should conflict");
	assert.equal(c.getState().status.kind, "conflict");
	console.log("PASS conflict detected on a moved branch");
	await c.updateFromRemote();
	assert.equal(c.getState().status.kind, "idle", JSON.stringify(c.getState().status));
	assert.equal(db.selectValue("select title from ec_posts where id = ?", [other.id]), "Changed upstream (live test)");
	assert.equal(c.getState().changes.length, 1);
	await c.commit("Live test: after update");
	assert.equal(c.getState().status.kind, "done");
	console.log("PASS update from remote keeps my change, takes theirs, then commits");
} finally {
	await api("DELETE", `/git/refs/heads/${branch}`);
	console.log(`deleted ${branch}`);
}
