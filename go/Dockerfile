FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/platform-go ./cmd/platform-go

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/platform-go /platform-go
ENV GOMEMLIMIT=128MiB \
    PLATFORM_GO_ADDR=0.0.0.0:4646 \
    PLATFORM_GO_ALLOW_NONLOOPBACK=true
EXPOSE 4646
USER nonroot:nonroot
ENTRYPOINT ["/platform-go"]
