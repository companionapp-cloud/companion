# syntax=docker/dockerfile:1
#
# Cloud binary (apps/cloud): open-core sync API + Stripe billing + admin. Build
# context is the REPO ROOT so the Go workspace (go.work) resolves core +
# packages/syncserver, and the npm workspaces resolve @companion/design-system:
#   docker build -f apps/cloud/Dockerfile -t companion-cloud .
#
# The binary embeds two build artifacts via go:embed — the account/billing portal
# (apps/cloud/frontend/dist) and the rendered React Email templates
# (apps/cloud/emails/dist) — so those must be built by Node BEFORE the Go build.

# 1. Build the embedded web assets. JS output is platform-independent, so pin this
#    stage to the build platform to avoid running Node under qemu on multi-arch builds.
FROM --platform=$BUILDPLATFORM node:20-alpine AS web
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build -w @companion/cloud-frontend \
 && npm run build -w @companion/cloud-emails

# 2. Build the static Go binary, pulling in the freshly built embed dirs.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
WORKDIR /src
COPY . .
COPY --from=web /src/apps/cloud/frontend/dist ./apps/cloud/frontend/dist
COPY --from=web /src/apps/cloud/emails/dist ./apps/cloud/emails/dist
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -C apps/cloud -trimpath -ldflags="-s -w" -o /out/companion-cloud .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/companion-cloud /companion-cloud
EXPOSE 8080
ENTRYPOINT ["/companion-cloud"]
