ARG AWS_IAM_AUTHENTICATOR_VERSION=0.7.20
ARG TARGETARCH=amd64

FROM golang:1.26-alpine AS builder
ARG TARGETARCH
ARG AWS_IAM_AUTHENTICATOR_VERSION

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

# EKS IAM credential plugin (runs when a registered kubeconfig uses
# `exec: aws-iam-authenticator`), built from the pinned tag with this toolchain:
# the project's release binary is built with an older Go whose standard library
# has published CVEs, and the release image scan gate would flag them.
# (its go.mod carries replace directives, so it is built inside its own module
# checkout rather than with `go install pkg@version`.)
RUN git clone --quiet --depth 1 --branch "v${AWS_IAM_AUTHENTICATOR_VERSION}" \
      https://github.com/kubernetes-sigs/aws-iam-authenticator /build/aws-iam-authenticator \
    && cd /build/aws-iam-authenticator \
    && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
         -ldflags="-w -s -X sigs.k8s.io/aws-iam-authenticator/pkg.Version=v${AWS_IAM_AUTHENTICATOR_VERSION}" \
         -o /out/aws-iam-authenticator ./cmd/aws-iam-authenticator

# Runtime — static binary, no shell/package manager, non-root uid 65532
# (ca-certificates + tzdata are included in distroless/static).
FROM gcr.io/distroless/static:nonroot
WORKDIR /app
COPY --from=builder --chown=65532:65532 /out/aws-iam-authenticator /usr/local/bin/aws-iam-authenticator
COPY --from=builder /app/server ./server
USER 65532:65532
EXPOSE 8002
ENTRYPOINT ["/app/server"]
