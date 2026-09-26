ARG AWS_IAM_AUTHENTICATOR_VERSION=0.7.20
ARG TARGETARCH=amd64

# EKS IAM credential plugin: the kubernetes-sigs/aws-iam-authenticator release
# binary, pinned and checksum-verified. It runs inside this image when a
# registered kubeconfig uses `exec: aws-iam-authenticator`.
FROM cgr.dev/chainguard/wolfi-base:latest AS tools
ARG AWS_IAM_AUTHENTICATOR_VERSION
ARG TARGETARCH
WORKDIR /downloads
RUN apk add --no-cache curl ca-certificates \
    && curl -fsSLo aws-iam-authenticator "https://github.com/kubernetes-sigs/aws-iam-authenticator/releases/download/v${AWS_IAM_AUTHENTICATOR_VERSION}/aws-iam-authenticator_${AWS_IAM_AUTHENTICATOR_VERSION}_linux_${TARGETARCH}" \
    && case "${TARGETARCH}" in \
         amd64) sha="a60921d38d2b51bc998f37eb1eba81c92aed21d9315a35a01b283ac398c43f87" ;; \
         arm64) sha="8afd45da2ba288ee515e31215ab5a7247d92449c179281e0610522226c5e21a5" ;; \
         *) echo "unsupported TARGETARCH ${TARGETARCH}" && exit 1 ;; \
       esac \
    && echo "${sha}  aws-iam-authenticator" | sha256sum -c - \
    && chmod +x aws-iam-authenticator

FROM golang:1.26-alpine AS builder
ARG TARGETARCH

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
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -ldflags="-w -s" -o /app/server ./cmd/server

# Runtime — static binary, no shell/package manager, non-root uid 65532
# (ca-certificates + tzdata are included in distroless/static).
FROM gcr.io/distroless/static:nonroot
WORKDIR /app
COPY --from=tools --chown=65532:65532 /downloads/aws-iam-authenticator /usr/local/bin/aws-iam-authenticator
COPY --from=builder /app/server ./server
USER 65532:65532
EXPOSE 8002
ENTRYPOINT ["/app/server"]
