# --------------------------------------------------------------------------
# Mastermind Automation Studio — frontend image.
#
# Multi-stage build:
#   1. node — install deps, run `vite build` into /app/dist.
#      VITE_API_BASE + VITE_AUTH_API are baked into the bundle at this
#      step (Vite inlines `import.meta.env.*` literals). They're passed
#      in via --build-arg from docker-compose.
#   2. nginx — serve the static dist + SPA fallback. nginx.conf below
#      rewrites every unknown path to /index.html so React Router can
#      handle /login, /dashboard, /delivery, etc.
# --------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Build-time vars baked into the bundle. Compose passes them via args.
ARG VITE_API_BASE
ARG VITE_AUTH_API
ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_AUTH_API=${VITE_AUTH_API}

# Install deps first so the layer caches independently of src edits.
COPY frontend/package.json frontend/package-lock.json* /app/
RUN npm install --no-audit --no-fund

# Source + build.
COPY frontend/ /app/
RUN npm run build

# --------------------------------------------------------------------------
# Stage 2 — nginx serving the static SPA.
# --------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA fallback + asset cache headers + gzip.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Static bundle.
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
