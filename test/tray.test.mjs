// node --test test/   (needs `npm run db && gitdash-pages studio-assets` first)
import init from "@sqlite.org/sqlite-wasm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { openDb } from "@digitaldefiance/gitdash-pages/studio/load-db.js";
import { applyDdl, applyFile, diffFiles, expandLegacyRevisions, filesFromContent, mergeRemote, revisionPathsFor, snapshot, visibleChanges } from "@digitaldefiance/gitdash-pages/studio/tray.js";

let sqlite, content, empty;
before(async () => {
	sqlite = await init({ print() {}, printErr() {} });
	content = JSON.parse(readFileSync("public/studio-data/content.json", "utf8"));
	empty = readFileSync("public/studio-data/empty.db");
});
const open = () => openDb(sqlite, empty, content);

test("a freshly loaded database has no pending changes", () => {
	const { db, freshNames } = open();
	assert.deepEqual(diffFiles(filesFromContent(content), snapshot(db, freshNames)), []);
});

test("the snapshot is byte-identical to the files in content/", () => {
	const { db, freshNames } = open();
	for (const [path, text] of snapshot(db, freshNames)) assert.equal(readFileSync(`content/${path}`, "utf8"), text, path);
});

test("an edit shows as modified and discarding it restores the baseline", () => {
	const { db, freshNames } = open();
	const base = snapshot(db, freshNames);
	db.exec("update ec_posts set title = 'Changed' where slug = 'hope'");
	const diff = diffFiles(base, snapshot(db, freshNames));
	assert.equal(diff.length, 1);
	assert.equal(diff[0].kind, "modified");
	assert.equal(diff[0].label, "Changed");
	applyFile(db, diff[0].path, base.get(diff[0].path));
	assert.deepEqual(diffFiles(base, snapshot(db, freshNames)), []);
});

test("a new row is added, and deleting a row is a deletion", () => {
	const { db, freshNames } = open();
	const base = snapshot(db, freshNames);
	db.exec("delete from ec_posts where slug = 'hope'");
	const diff = diffFiles(base, snapshot(db, freshNames));
	assert.deepEqual(diff.map((d) => d.kind), ["deleted"]);
	applyFile(db, diff[0].path, base.get(diff[0].path));
	assert.deepEqual(diffFiles(base, snapshot(db, freshNames)), []);
});

test("entry locks and other transient tables never show up", () => {
	const { db, freshNames } = open();
	const base = snapshot(db, freshNames);
	const lock = "_emdash_entry_locks";
	assert.ok(db.selectValue("select count(*) from sqlite_master where name = ?", [lock]), "expected the entry lock table");
	const cols = db.selectObjects(`pragma table_info("${lock}")`);
	const values = cols.map((c) => (c.type.toUpperCase().includes("INT") ? 1 : "x"));
	db.exec({ sql: `insert into "${lock}" (${cols.map((c) => `"${c.name}"`)}) values (${cols.map(() => "?")})`, bind: values });
	assert.equal(db.selectValue(`select count(*) from "${lock}"`), 1);
	assert.deepEqual(diffFiles(base, snapshot(db, freshNames)), []);
});

test("mergeRemote takes remote-only changes and keeps clashing local ones", () => {
	const { db, freshNames } = open();
	const oldBase = snapshot(db, freshNames);
	const remote = new Map(oldBase);
	const [a, b] = [...oldBase.keys()].filter((p) => p.startsWith("ec_posts/"));
	const edit = (text, title) => JSON.stringify({ ...JSON.parse(text), title }, null, "\t") + "\n";
	remote.set(a, edit(oldBase.get(a), "Remote A"));
	remote.set(b, edit(oldBase.get(b), "Remote B"));
	const idB = b.split("/")[1].replace(".json", "");
	db.exec({ sql: "update ec_posts set title = 'Local B' where id = ?", bind: [idB] });
	const clashes = mergeRemote(db, oldBase, remote, snapshot(db, freshNames));
	assert.deepEqual(clashes, [b]);
	const idA = a.split("/")[1].replace(".json", "");
	assert.equal(db.selectValue("select title from ec_posts where id = ?", [idA]), "Remote A");
	assert.equal(db.selectValue("select title from ec_posts where id = ?", [idB]), "Local B");
});

test("revisions are one file per row, so saving one post changes one revision file", () => {
	const { db, freshNames } = open();
	const paths = [...snapshot(db, freshNames).keys()];
	assert.ok(paths.some((p) => p.startsWith("revisions/")));
	assert.ok(!paths.includes("revisions.json"));
});

test("a revision of a changed post is folded into the post's change, and discard restores both", () => {
	const { db, freshNames } = open();
	const base = snapshot(db, freshNames);
	const post = db.selectObject("select id from ec_posts where slug = 'hope'");
	db.exec({ sql: "update ec_posts set title = 'Changed' where id = ?", bind: [post.id] });
	db.exec({ sql: "insert into revisions (id, collection, entry_id, data, created_at) values ('rev-test', 'posts', ?, '{\"title\":\"Changed\"}', '2026-01-01 00:00:00')", bind: [post.id] });
	const cur = snapshot(db, freshNames);
	assert.equal(diffFiles(base, cur).length, 2);
	assert.equal(visibleChanges(base, cur).length, 1);
	for (const p of revisionPathsFor(base, cur, `ec_posts/${post.id}.json`)) applyFile(db, p, base.get(p) ?? null);
	applyFile(db, `ec_posts/${post.id}.json`, base.get(`ec_posts/${post.id}.json`));
	assert.deepEqual(diffFiles(base, snapshot(db, freshNames)), []);
});

test("an older revisions.json from the repo expands into per-row files", () => {
	const files = new Map([["revisions.json", JSON.stringify([{ id: "a", entry_id: "e" }, { id: "b", entry_id: "e" }])]]);
	expandLegacyRevisions(files);
	assert.deepEqual([...files.keys()].sort(), ["revisions/a.json", "revisions/b.json"]);
});

test("a column added by a schema change can be restored into a freshly loaded database", () => {
	const first = open();
	const base = snapshot(first.db, first.freshNames);
	first.db.exec("alter table ec_posts add column accent_color TEXT");
	first.db.exec("update ec_posts set accent_color = '#ff0000' where slug = 'hope'");
	const saved = snapshot(first.db, first.freshNames);
	const changed = diffFiles(base, saved).map((c) => c.path);

	const second = open();
	assert.throws(() => applyFile(second.db, changed.find((p) => p.startsWith("ec_posts/")), saved.get(changed.find((p) => p.startsWith("ec_posts/")))));
	applyDdl(second.db, saved.get("_ddl.json"));
	for (const path of changed) applyFile(second.db, path, saved.get(path));
	assert.deepEqual(diffFiles(saved, snapshot(second.db, second.freshNames)).filter((c) => c.path !== "_ddl.json"), []);
	assert.equal(second.db.selectValue("select accent_color from ec_posts where slug = 'hope'"), "#ff0000");
});

test("encrypted plugin secret settings never show up as a change", () => {
	const { db, freshNames } = open();
	const base = snapshot(db, freshNames);
	const envelope = JSON.stringify({ $emdash: "plugin-setting", v: 1, kid: "k", iv: "aa", ciphertext: "bb" });
	db.exec(`insert into options (name, value) values ('plugin:webhook-notifier:settings:secretToken', '${envelope}')`);
	db.exec(`insert into options (name, value) values ('plugin:webhook-notifier:settings:events', '"content"')`);
	const diff = diffFiles(base, snapshot(db, freshNames));
	assert.deepEqual(diff.map((d) => d.path), ["options.json"]);
	assert.ok(!snapshot(db, freshNames).get("options.json").includes("secretToken"));
	assert.ok(snapshot(db, freshNames).get("options.json").includes("settings:events"));
});
