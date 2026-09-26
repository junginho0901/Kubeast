## Build stage
FROM golang:1.26-alpine AS builder

RUN apk add --no-cache git

# Copy shared pkg first (for layer caching)
WORKDIR /build/pkg
COPY pkg/go.mod pkg/go.sum* ./
COPY pkg/ ./

# Copy auth-service-go
WORKDIR /build/auth-service-go
COPY auth-service-go/go.mod auth-service-go/go.sum* ./

# Fix replace directive for Docker build context
RUN sed -i 's|=> ../pkg|=> /build/pkg|' go.mod

RUN go mod download

COPY auth-service-go/ ./

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server ./cmd/server

## Runtime stage — static binary, no shell/package manager, non-root uid 65532
## (ca-certificates + tzdata are included in distroless/static).
FROM gcr.io/distroless/static:nonroot

WORKDIR /app
COPY --from=builder /app/server ./server
USER 65532:65532

EXPOSE 8004

ENTRYPOINT ["/app/server"]
