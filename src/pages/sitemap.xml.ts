import type { APIRoute } from "astro";
import { getEmDashCollection, getTaxonomyTerms } from "emdash";

import { siteUrl } from "../utils/site-url";

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const GET: APIRoute = async ({ site, url }) => {
	const origin = site ?? new URL(url.origin);
	const [{ entries: posts }, { entries: pages }, tags, categories] = await Promise.all([
		getEmDashCollection("posts", { orderBy: { published_at: "desc" }, limit: 1000 }),
		getEmDashCollection("pages", { limit: 1000 }),
		getTaxonomyTerms("tag"),
		getTaxonomyTerms("category"),
	]);
	const entry = (path: string, lastmod?: Date | null) =>
		`  <url><loc>${escapeXml(siteUrl(origin, path))}</loc>${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ""}</url>`;

	const urls = [
		entry("/"),
		entry("/posts/"),
		...posts.map((p) => entry(`/posts/${p.id}/`, p.data.updatedAt ?? p.data.publishedAt)),
		...pages.filter((p) => p.id !== "home").map((p) => entry(`/pages/${p.id}/`, p.data.updatedAt)),
		...tags.map((t) => entry(`/tag/${t.slug}/`)),
		...categories.map((t) => entry(`/category/${t.slug}/`)),
	];
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
		{ headers: { "Content-Type": "application/xml; charset=utf-8" } },
	);
};
