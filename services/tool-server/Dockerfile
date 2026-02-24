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

FROM golang:1.21 as builder
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -o /out/tool-server ./main.go

FROM gcr.io/distroless/static:nonroot
WORKDIR /
ENV PATH=$PATH:/bin
COPY --from=tools --chown=65532:65532 /downloads/kubectl /bin/kubectl
COPY --from=builder /out/tool-server /tool-server
USER 65532:65532
ENTRYPOINT ["/tool-server"]
