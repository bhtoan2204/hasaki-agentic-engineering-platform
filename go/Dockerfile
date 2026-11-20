# CGO is required by the tree-sitter grammars (code intelligence indexing). Build and run on the same Debian
# release so the binary's glibc requirements match the runtime image.
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/platform-go ./cmd/platform-go

# git: indexing reads repository objects and worktree changes with the git CLI.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* && useradd --uid 65532 --no-create-home nonroot
COPY --from=build /out/platform-go /platform-go
ENV GOMEMLIMIT=256MiB \
    PLATFORM_GO_ADDR=0.0.0.0:4646 \
    PLATFORM_GO_ALLOW_NONLOOPBACK=true
EXPOSE 4646
USER nonroot:nonroot
ENTRYPOINT ["/platform-go"]
