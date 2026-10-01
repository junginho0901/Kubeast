# ---- build stage ----
# The bundle is architecture-independent: build it once on the build host
# instead of once per target platform under emulation.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Bundling monaco-editor exceeds Node's default heap.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

# ---- serve stage ----
# nginx-unprivileged: uid 101, pid/temp under /tmp, non-privileged port.
FROM nginxinc/nginx-unprivileged:1.31-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 5173
