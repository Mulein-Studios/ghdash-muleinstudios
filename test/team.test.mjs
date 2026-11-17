import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("the team page renders without the sample team members", () => {
	const html = readFileSync("dist/client/team/index.html", "utf8");
	assert.match(html, /<h1[^>]*>Team<\/h1>/);
	for (const name of ["Ada Rivera", "Ben Okafor", "Chen Wu"]) assert.ok(!html.includes(name), name);
	assert.equal(existsSync("dist/client/team/ben-okafor/index.html"), false);
});
