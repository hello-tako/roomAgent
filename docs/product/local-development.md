# Local development

Requirements: Node 22 and pnpm 10.33.2. Work from a checkout of `hello-tako/roomAgent`. Do not deploy these commands.

```bash
pnpm install --frozen-lockfile
pnpm --filter @ai-company/api types
pnpm --filter @ai-company/api exec wrangler dev --config wrangler.local.jsonc --port 8787 --ip 127.0.0.1 --local
```

In a second shell:

```bash
VITE_LOCAL_FIXTURE=true pnpm --filter @ai-company/web dev
```

Open `http://127.0.0.1:5173`. Choose the local company. That posts to `/local/product-fixture` and creates Northwind Studio: owner Avery Chen, departments Studio and Review, employees Mina Cho, Wes Adler, Nia Patel, Omar Shah, Quinn Blake, and Sam Ibarra, and rooms Studio Floor and Review Bay. No join code is pre-issued.

`wrangler.local.jsonc` sets `LOCAL_PRODUCT_FIXTURE=enabled` and `WEB_ORIGIN=http://127.0.0.1:5173`. It uses a placeholder D1 id. It is not a deploy target. `wrangler.jsonc` and `wrangler.staging.jsonc` do not enable the fixture.

The local human session lasts 900 seconds and disappears on reload. Sign out revokes it. Join codes last at most 600 seconds and work once.

Checks:

```bash
pnpm --filter @ai-company/web test
pnpm --filter @ai-company/web typecheck
pnpm --filter @ai-company/api exec vitest run test/control-plane.test.ts
pnpm test:e2e
```
