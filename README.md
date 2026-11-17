# Mulein Studios

The Mulein Studios site runs on GitDash, a fork of EmDash. GitDash builds the JSON in `content/` into a static Astro site and serves the browser editor at `/studio/`.

```sh
npm ci
npm run build
npm run preview
```

GitDash expects JSON files inside `content/`. If macOS Finder creates `content/.DS_Store`, move it out before building or build from a clean checkout.

Edit Home, Portfolio and Support under **Pages**, the music catalog under **Posts**, and navigation under **Menus**. The **Fonts** collection controls typography through GitDash Fonts. It loads Inter from `custom-fonts/` and uses the original Adobe Fonts web project for the Baskerville URW headings and navigation. The Smithland palette and layout are ported in `src/styles/theme.css` and the Astro templates.

The November 16, 2026 WordPress migration preserved post dates, the Music category, Jessica Mulein's byline, cover art and YouTube embeds. The Capabilities page is a draft. GitDash includes draft data in its Studio snapshot, so anyone who can read that snapshot or the repository can read the draft. The public build does not render a page for it.

The GitDash redirect table retains the dated WordPress post URLs, `/portfolio/`, `/support/` and `/feed/`. The Media Library uses optimized WebP copies from the Jetpack backup. Full-resolution files and the original WordPress site backup are kept locally outside version control.

See [SETUP.md](SETUP.md) for hosting, Studio sign-in and optional integrations.
