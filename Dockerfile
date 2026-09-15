# pgboss-scheduler
#
# PINNED BY DIGEST, not by tag. `node:22-alpine` is a moving pointer: the image
# it names changes under you, so two builds a week apart are not the same build
# and "it worked yesterday" stops being evidence. pg-boss 12 also requires
# node >= 22.12.0, so the runtime version here is a real constraint rather than
# a preference. Bump this digest deliberately, not by rebuilding.
#
# Multi-stage: TypeScript is compiled in the builder and only the JavaScript and
# production dependencies reach the runtime image. `npm ci --omit=dev` in the
# final stage rather than copying node_modules across, so the runtime carries no
# typescript compiler and no @types.

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Runs as the image's own non-root `node` user. Nothing here writes to disk —
# all state is in Postgres — so there is no volume to align ownership with.
USER node

EXPOSE 8020

# The image's own healthcheck, so `docker ps` tells the truth without anything
# external having to probe it. Node's fetch rather than curl or wget: the alpine
# image ships neither by default and adding one for a healthcheck is a package
# to keep patched forever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8020/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
