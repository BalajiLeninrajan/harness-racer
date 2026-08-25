# harness-racer landing page

A single static page served by a Cloudflare Worker with an assets binding. No
build step — everything in `public/` ships as-is.

```console
pnpm install
pnpm dev      # wrangler dev on http://127.0.0.1:8787
pnpm deploy   # wrangler deploy
```

The page is one screen: brand bar, headline, the harnesses it drives, the
install command, and an animated field of accent streaks behind them. The
field is pure CSS (`.streak` / `@keyframes race` in `public/styles.css`) and
purely decorative — it settles to a finished state under
`prefers-reduced-motion`.

It deliberately mirrors **no part of the app UI**. An earlier version replayed
a simulated race using a copy of the client's lane markup and styling, which
duplicated ~100 lines from `src/client/styles.css` and silently went stale as
soon as the app's lane was redesigned. Keep it that way: if the page ever needs
to show real app chrome again, share a source with `src/client` rather than
copying one.

`public/tokens.css`, `utilities.css`, `recipes.css`, and `index.css` are
generated from the `catppuccin-neu` package by `pnpm sync` and are not
committed — run it after bumping the package rather than editing them here.
