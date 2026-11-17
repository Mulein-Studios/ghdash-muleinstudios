import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { embedsPlugin } from "@emdash-cms/plugin-embeds";
import { basePath, siteUrl } from "@digitaldefiance/gitdash-pages/host";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { Features } from "lightningcss";

// The address and base path come from the host: GitHub Pages (the workflow passes SITE_URL and BASE_PATH),
// GitLab Pages (CI_PAGES_URL) or Netlify (always the root). SITE_URL and BASE_PATH override them anywhere.
const site = siteUrl();
const base = basePath();

export default defineConfig({
	site,
	base,
	output: "static",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	vite: {
		css: {
			// Keep light-dark() native so the footer theme switcher works in
			// production. For older browsers, Lightning CSS otherwise rewrites
			// it into variables that follow only prefers-color-scheme, which the
			// :root.light / :root.dark color-scheme rules in Base.astro can't
			// reach. Browsers without light-dark() get the light fallback in
			// tokens.css.
			lightningcss: { exclude: Features.LightDark },
		},
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				// GitDash copies repository media to public/media before prerendering.
				baseUrl: "/media",
			}),
			plugins: [embedsPlugin()],
		}),
	],
	devToolbar: { enabled: false },
});
