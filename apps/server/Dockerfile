# syntax=docker/dockerfile:1
#
# Open-core sync API server (apps/server). Build context is the REPO ROOT so the Go
# workspace (go.work) can resolve core + packages/syncserver:
#   docker build -f apps/server/Dockerfile -t companion-server .
#
# The store driver is pure Go (modernc.org/sqlite) so CGO_ENABLED=0 gives a fully
# static binary that cross-compiles for any GOOS/GOARCH without a C toolchain and
# runs on a distroless static base. buildx injects TARGETOS/TARGETARCH per platform.

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
WORKDIR /src
COPY . .
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -C apps/server -trimpath -ldflags="-s -w" -o /out/companion-server .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/companion-server /companion-server
EXPOSE 8080
ENTRYPOINT ["/companion-server"]
