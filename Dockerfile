# Kanbini web edition: the app served to a browser (apps/web). See apps/web/README.md.
# Node, not Bun: the database driver (better-sqlite3) doesn't load in Bun.
FROM node:22-bookworm AS build
WORKDIR /app
RUN npm install -g pnpm@11.0.9
# The desktop-only Electron and Playwright binaries aren't needed here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Every workspace package's manifest (apps/web/repo-guards.test.ts checks the list).
COPY apps/desktop/package.json apps/desktop/
COPY apps/desktop-e2e/package.json apps/desktop-e2e/
COPY apps/mcp/package.json apps/mcp/
COPY apps/renderer/package.json apps/renderer/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
# Hoisted here (the repo itself is isolated, see pnpm-workspace.yaml): the
# runtime stage copies the SQLite binding from the root node_modules.
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted
COPY . .
# The account menu must follow the app's design system (apps/web/.oxlintrc.json).
RUN pnpm --filter @kanbini/web run lint \
 && pnpm --filter @kanbini/mcp run build \
 && pnpm --filter @kanbini/desktop exec vite build -c ../web/vite.config.ts \
 && pnpm --filter @kanbini/desktop exec vite build -c ../web/vite.config.ts --ssr ../web/gateway.ts \
 && pnpm --filter @kanbini/desktop exec vite build -c ../web/vite.config.ts --ssr ../web/server.ts

FROM node:22-bookworm-slim
WORKDIR /app
# Accounts in /data/accounts.json, each account's boards in /data/users/<id>.
ENV KANBINI_DATA=/data PORT=8080
COPY --from=build /app/apps/web/out apps/web/out
COPY --from=build /app/packages/db/drizzle packages/db/drizzle
COPY --from=build /app/apps/mcp/dist apps/mcp/dist
# The one module the server bundle leaves out: the native SQLite binding.
COPY --from=build /app/node_modules/better-sqlite3 node_modules/better-sqlite3
COPY --from=build /app/node_modules/bindings node_modules/bindings
COPY --from=build /app/node_modules/file-uri-to-path node_modules/file-uri-to-path
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "apps/web/out/server/gateway.cjs"]
