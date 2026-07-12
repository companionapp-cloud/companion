# syntax=docker/dockerfile:1
#
# Marketing + docs site (apps/website): an Expo Router static web export served by Caddy
# on Railway. Build context is the REPO ROOT so the npm workspaces resolve @companion/*:
#   docker build -f apps/website/Dockerfile -t companion-website .
#
# Two stages: (1) install the workspace and run `expo export --platform web` into dist/,
# (2) serve the static dist with Caddy (SPA-style routing, see Caddyfile).

# 1. Expo static web export. Pinned to the build platform; the output is static HTML/JS,
#    so there's no need to run this under qemu on multi-arch.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /src
# The PostHog project token is a PUBLIC client key that Expo inlines into the bundle at
# build time (EXPO_PUBLIC_*). CI passes it as a build arg sourced from a GitHub secret;
# when unset, analytics is simply disabled at runtime.
ARG POSTHOG_PROJECT_TOKEN=""
ARG POSTHOG_HOST="https://us.i.posthog.com"
ENV EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN=$POSTHOG_PROJECT_TOKEN \
    EXPO_PUBLIC_POSTHOG_HOST=$POSTHOG_HOST
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build -w @companion/website

# 2. Static file server. Caddy binds Railway's $PORT (falling back to 3000), which is
#    the port EXPOSE advertises and Railway's networking targets.
FROM caddy:2-alpine
WORKDIR /srv
COPY apps/website/Caddyfile ./Caddyfile
RUN caddy fmt --overwrite Caddyfile
COPY --from=build /src/apps/website/dist ./dist
EXPOSE 3000
CMD ["caddy", "run", "--config", "Caddyfile", "--adapter", "caddyfile"]
