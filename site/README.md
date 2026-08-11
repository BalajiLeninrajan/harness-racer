# harness-racer landing page

A single static page served by a Cloudflare Worker with an assets binding. No
build step — everything in `public/` ships as-is.

```console
pnpm install
pnpm dev      # wrangler dev on http://127.0.0.1:8787
pnpm deploy   # wrangler deploy
```

`public/race.js` replays a **simulated** heat — plausible fixture timings on a
`requestAnimationFrame` clock, not a real benchmark run. It pauses when the
section scrolls out of view or the tab is hidden, and settles to a finished
state under `prefers-reduced-motion`.

`public/tokens.css` is the shared Catppuccin Mocha + neumorphic token layer;
keep it in sync with the dashboard rather than editing it here.
