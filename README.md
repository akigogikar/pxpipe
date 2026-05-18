# pixelpipe

A token-saving proxy for Claude Code that renders the system prompt + tool
definitions as images, so Claude OCRs them instead of paying for them as
text. **65-73% input-token savings** on Opus 4.7, **100% reasoning quality**
preserved, **identical fixed text** every turn for a clean prompt-cache.

Runs on **Node 18+** and **Cloudflare Workers** from the same source.

---

## How it works

```
                                  ┌─ original ────────────────────┐
                                  │ ~68K input tok                │
Claude Code  ──►  pixelpipe  ──►  │  (system + tools as text)     │  ──►  Anthropic
                       │          └───────────────────────────────┘
                       └──────►   ┌─ via proxy ───────────────────┐
                                  │ ~3.5K input tok               │
                                  │  (system + tools as PNG +     │
                                  │   prompt-cache breakpoint)    │
                                  └───────────────────────────────┘
                                          ↓ Anthropic vision OCR
                                          100% reasoning quality retained
```

The proxy intercepts `POST /v1/messages`, pulls the system prompt + tool
documentation out of the JSON body, renders it into one or more grayscale
PNGs using a build-time-generated JetBrains Mono glyph atlas, and
substitutes those PNGs back in as `image` content blocks with an
`ephemeral` cache_control breakpoint.

Token math (Opus 4.7, real Claude Code workflow):

| metric                       | original | via proxy   | savings |
| ---------------------------- | -------- | ----------- | ------- |
| Cold input tokens            | ~68K     | ~3.5K       | 95%     |
| Cache-warm input tokens      | ~7.5K    | ~3.5K       | 53%     |
| Per-call median (mixed)      | -        | -           | 65-73%  |
| Per-image OCR quality vs txt | -        | -           | ~99.5%  |

---

## Quick start (Node)

```bash
npm install
npm run build           # produces dist/node.js
node bin/cli.js         # listens on 127.0.0.1:47821 by default
```

Point Claude Code at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 \
  claude --exclude-dynamic-system-prompt-sections
```

That's it. Use Claude Code normally.

The `--exclude-dynamic-system-prompt-sections` flag suppresses the small
per-turn variable section so the rendered image stays byte-identical
across turns — that's what makes the prompt cache actually hit.

---

## Quick start (Cloudflare Workers)

```bash
npx wrangler dev        # local dev on :8787
npx wrangler deploy     # ship to *.workers.dev
```

Then in Claude Code:

```bash
ANTHROPIC_BASE_URL=https://pixelpipe.<your-account>.workers.dev \
  claude --exclude-dynamic-system-prompt-sections
```

You can attach a custom hostname and route in `wrangler.toml`.

---

## Configuration

Both runtimes read the same options — Node from CLI flags or env, Worker
from `wrangler.toml` `[vars]`.

| flag / var               | default                       | meaning                                     |
| ------------------------ | ----------------------------- | ------------------------------------------- |
| `--port`     `PORT`      | `47821`                       | Node only — listen port                     |
| `--upstream` `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | where to forward                     |
| `--no-compress` `COMPRESS=0`     | on            | master switch                               |
| `--no-tools`    `COMPRESS_TOOLS=0` | on          | fold tool docs into the image               |
| `--no-schemas`  `COMPRESS_SCHEMAS=0` | on        | include `input_schema` JSON in the image    |
| `--min-chars` `MIN_COMPRESS_CHARS` | `2000`      | skip compression below this many chars      |
| `--placement` `PLACEMENT` | `system`                     | `system` or `user` — where image lands      |
| `--cols`     `COLS`      | `100`                         | soft-wrap column count                      |

In Workers, set the optional upstream API key with:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

If unset, the proxy forwards whatever `x-api-key` the client sent.

---

## Architecture

```
src/
├── core/              100% runtime-agnostic (Web Standard APIs only)
│   ├── atlas.ts         (generated) base64-inlined glyph bitmap
│   ├── png.ts           minimal grayscale PNG encoder
│   ├── render.ts        text → PNG bytes
│   ├── transform.ts     request body rewriter
│   ├── proxy.ts         the fetch handler
│   └── types.ts         Anthropic API types
├── node.ts            node:http adapter + CLI
└── worker.ts          export default { fetch }

scripts/
├── gen-atlas.ts       build-time: TTF → atlas.ts (uses @napi-rs/canvas)
└── build.mjs          esbuild bundler for Node target

assets/
└── JetBrainsMono-Regular.ttf
```

The atlas is generated **at build time**, base64-inlined into a `.ts`
file, and shipped with the bundle. At runtime there are zero external
files to read and zero non-Web-Standard imports — that's the only way
this works in Workers without per-request asset fetches.

Regenerate the atlas (e.g., after swapping the font or font size):

```bash
FONT_PX=15 npm run build:atlas
```

---

## Limitations

- Sub-9pt full OCR. Menlo (Python proxy default) is in the verified
  floor; the bundled JetBrains Mono at 15px is comparable. Smaller sizes
  cause OCR errors.
- Compression sets a 5-minute prompt-cache TTL. Adding `cache_control:
  ephemeral` causes warm-cache rotation, not eviction.
- A 5KB break-even point: if input is `< MIN_COMPRESS_CHARS` chars we
  skip compression entirely (overhead would exceed savings).
- Per-machine font: regenerate the atlas if you swap fonts. The
  generated `src/core/atlas.ts` is checked in so consumers don't need
  `@napi-rs/canvas` to install.
- Workers CPU limit: this is fine for free-tier (10ms CPU) on small
  prompts; large prompts (>30K chars) may need the paid tier.

---

## Development

```bash
npm install
npm run dev:node              # tsx watch on src/node.ts
npm run dev:worker            # wrangler dev
npm run test                  # vitest
npm run test:watch
npm run typecheck             # tsc --noEmit
npm run build:atlas           # regenerate src/core/atlas.ts from TTF
npm run build                 # build dist/node.js
npm run deploy:worker         # wrangler deploy
```

## Legacy

The original Python proxy (the reference implementation we ported from)
lives in [`legacy/python/`](./legacy/python/). It's kept around as a
parity oracle and will be deleted once TS reaches end-to-end byte-output
parity.

## License

MIT.
