FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git

# Build shared pkg first
WORKDIR /build/pkg
COPY pkg/go.mod pkg/go.sum* ./
COPY pkg/ ./

# Build k8s-service-go
WORKDIR /build/k8s-service-go
COPY k8s-service-go/go.mod k8s-service-go/go.sum* ./

# Fix replace directive for container build
RUN sed -i 's|=> ../pkg|=> /build/pkg|' go.mod

RUN go mod download
COPY k8s-service-go/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server ./cmd/server

# Runtime — static binary, no shell/package manager, non-root uid 65532
# (ca-certificates + tzdata are included in distroless/static).
FROM gcr.io/distroless/static:nonroot
WORKDIR /app
COPY --from=builder /app/server ./server
USER 65532:65532
EXPOSE 8002
ENTRYPOINT ["/app/server"]
