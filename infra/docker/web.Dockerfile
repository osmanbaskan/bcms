# ── Development ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS development
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspaces --if-present
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 4200
CMD ["npm", "run", "start", "--", "--host", "0.0.0.0", "--poll", "2000"]

# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspaces --if-present
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY tsconfig.base.json ./
RUN npm run build -w packages/shared
WORKDIR /app/apps/web
RUN npm run build

# ── Production (nginx) ────────────────────────────────────────────────────────
FROM nginx:alpine AS production
RUN apk add --no-cache gettext curl
COPY --from=builder /app/apps/web/dist/web/browser /usr/share/nginx/html
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/docker/runtime-config.js.template /etc/nginx/runtime-config.js.template
COPY infra/docker/docker-entrypoint-web.sh /docker-entrypoint-web.sh
RUN chmod +x /docker-entrypoint-web.sh && mkdir -p /usr/share/nginx/html/assets
EXPOSE 80
CMD ["/docker-entrypoint-web.sh"]
