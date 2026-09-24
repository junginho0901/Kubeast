ARG KUBECTL_VERSION=1.35.1
ARG TARGETARCH=amd64

FROM cgr.dev/chainguard/wolfi-base:latest AS tools
ARG KUBECTL_VERSION
ARG TARGETARCH
WORKDIR /downloads
RUN apk add --no-cache curl ca-certificates \
    && curl -Lo kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && chmod +x kubectl \
    && /downloads/kubectl version --client

# Build context is services/ (shared pkg module is pulled in via replace),
# same layout as the other Go services.
FROM golang:1.22-alpine AS builder
ARG TARGETARCH
WORKDIR /build/pkg
COPY pkg/go.mod pkg/go.sum* ./
COPY pkg/ ./
WORKDIR /build/tool-server
COPY tool-server/go.mod tool-server/go.sum* ./
RUN sed -i 's|=> ../pkg|=> /build/pkg|' go.mod
RUN go mod download
COPY tool-server/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -o /out/tool-server .

FROM gcr.io/distroless/static:nonroot
WORKDIR /
ENV PATH=$PATH:/bin
COPY --from=tools --chown=65532:65532 /downloads/kubectl /bin/kubectl
COPY --from=builder /out/tool-server /tool-server
USER 65532:65532
ENTRYPOINT ["/tool-server"]
