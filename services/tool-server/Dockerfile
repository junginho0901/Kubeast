ARG AWS_IAM_AUTHENTICATOR_VERSION=0.7.23

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

# kubectl and the EKS IAM credential plugin it runs for `exec: aws-iam-authenticator`
# kubeconfigs are built with this toolchain: the projects' release binaries are built
# with an older Go (and x/net, x/text) whose published CVEs the release image scan gate
# flags. kubectl is its upstream entrypoint (kubectl/main.go) at the module versions in
# kubectl/go.mod; its version string follows k8s.io/kubectl there (v0.X.Y = kubectl v1.X.Y).
RUN cd kubectl \
    && v="$(awk '$1 == "k8s.io/kubectl" {sub(/^v0/, "v1", $2); print $2}' go.mod)" \
    && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath \
         -ldflags="-s -w -X k8s.io/client-go/pkg/version.gitVersion=${v} -X k8s.io/component-base/version.gitVersion=${v}" \
         -o /out/kubectl .

# (the plugin's go.mod carries replace directives, so it is built inside its own
# module checkout rather than with `go install pkg@version`.)
RUN git clone --quiet --depth 1 --branch "v${AWS_IAM_AUTHENTICATOR_VERSION}" \
      https://github.com/kubernetes-sigs/aws-iam-authenticator /build/aws-iam-authenticator \
    && cd /build/aws-iam-authenticator \
    && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
         -ldflags="-w -s -X sigs.k8s.io/aws-iam-authenticator/pkg.Version=v${AWS_IAM_AUTHENTICATOR_VERSION}" \
         -o /out/aws-iam-authenticator ./cmd/aws-iam-authenticator

FROM gcr.io/distroless/static:nonroot
WORKDIR /
ENV PATH=$PATH:/bin
COPY --from=builder --chown=65532:65532 /out/kubectl /bin/kubectl
COPY --from=builder --chown=65532:65532 /out/aws-iam-authenticator /usr/local/bin/aws-iam-authenticator
COPY --from=builder /out/tool-server /tool-server
USER 65532:65532
ENTRYPOINT ["/tool-server"]
