ARG KUBECTL_VERSION=1.35.1
ARG AWS_IAM_AUTHENTICATOR_VERSION=0.7.20
ARG TARGETARCH=amd64

# kubectl + the EKS IAM credential plugin (kubernetes-sigs/aws-iam-authenticator
# release binary, pinned and checksum-verified) that kubectl runs when a
# registered kubeconfig uses `exec: aws-iam-authenticator`.
FROM cgr.dev/chainguard/wolfi-base:latest AS tools
ARG KUBECTL_VERSION
ARG AWS_IAM_AUTHENTICATOR_VERSION
ARG TARGETARCH
WORKDIR /downloads
RUN apk add --no-cache curl ca-certificates \
    && curl -Lo kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && chmod +x kubectl \
    && /downloads/kubectl version --client \
    && curl -fsSLo aws-iam-authenticator "https://github.com/kubernetes-sigs/aws-iam-authenticator/releases/download/v${AWS_IAM_AUTHENTICATOR_VERSION}/aws-iam-authenticator_${AWS_IAM_AUTHENTICATOR_VERSION}_linux_${TARGETARCH}" \
    && case "${TARGETARCH}" in \
         amd64) sha="a60921d38d2b51bc998f37eb1eba81c92aed21d9315a35a01b283ac398c43f87" ;; \
         arm64) sha="8afd45da2ba288ee515e31215ab5a7247d92449c179281e0610522226c5e21a5" ;; \
         *) echo "unsupported TARGETARCH ${TARGETARCH}" && exit 1 ;; \
       esac \
    && echo "${sha}  aws-iam-authenticator" | sha256sum -c - \
    && chmod +x aws-iam-authenticator

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
COPY --from=tools --chown=65532:65532 /downloads/aws-iam-authenticator /usr/local/bin/aws-iam-authenticator
COPY --from=builder /out/tool-server /tool-server
USER 65532:65532
ENTRYPOINT ["/tool-server"]
