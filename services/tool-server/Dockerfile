ARG KUBECTL_VERSION=1.35.9
ARG AWS_IAM_AUTHENTICATOR_VERSION=0.7.20

# kubectl release binary (pinned) for the target architecture, fetched on the
# build host and checked against the published sha256. The EKS IAM credential
# plugin it runs for `exec: aws-iam-authenticator` kubeconfigs is built from
# source in the Go stage below.
FROM --platform=$BUILDPLATFORM cgr.dev/chainguard/wolfi-base:latest AS tools
ARG KUBECTL_VERSION
ARG TARGETARCH
WORKDIR /downloads
RUN apk add --no-cache curl ca-certificates \
    && curl -Lo kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && curl -Lo kubectl.sha256 "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" \
    && echo "$(cat kubectl.sha256)  kubectl" | sha256sum -c - \
    && chmod +x kubectl

# Build context is services/ (shared pkg module is pulled in via replace),
# same layout as the other Go services. Runs on the build host and
# cross-compiles for the target.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS builder
ARG TARGETARCH
ARG AWS_IAM_AUTHENTICATOR_VERSION
RUN apk add --no-cache git
WORKDIR /build/pkg
COPY pkg/go.mod pkg/go.sum* ./
COPY pkg/ ./
WORKDIR /build/tool-server
COPY tool-server/go.mod tool-server/go.sum* ./
RUN sed -i 's|=> ../pkg|=> /build/pkg|' go.mod
RUN go mod download
COPY tool-server/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -o /out/tool-server .

# EKS IAM credential plugin, built from the pinned tag with this toolchain: the
# project's release binary is built with an older Go whose standard library has
# published CVEs, and the release image scan gate would flag them.
# (its go.mod carries replace directives, so it is built inside its own module
# checkout rather than with `go install pkg@version`.)
RUN git clone --quiet --depth 1 --branch "v${AWS_IAM_AUTHENTICATOR_VERSION}" \
      https://github.com/kubernetes-sigs/aws-iam-authenticator /build/aws-iam-authenticator \
    && cd /build/aws-iam-authenticator \
    && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
         -ldflags="-w -s -X sigs.k8s.io/aws-iam-authenticator/pkg.Version=v${AWS_IAM_AUTHENTICATOR_VERSION}" \
         -o /out/aws-iam-authenticator ./cmd/aws-iam-authenticator

FROM gcr.io/distroless/static:nonroot
WORKDIR /
ENV PATH=$PATH:/bin
COPY --from=tools --chown=65532:65532 /downloads/kubectl /bin/kubectl
COPY --from=builder --chown=65532:65532 /out/aws-iam-authenticator /usr/local/bin/aws-iam-authenticator
COPY --from=builder /out/tool-server /tool-server
USER 65532:65532
ENTRYPOINT ["/tool-server"]
