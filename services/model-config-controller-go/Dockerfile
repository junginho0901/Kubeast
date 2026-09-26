FROM golang:1.26-alpine AS builder
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/controller ./main.go

FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /out/controller /controller
USER 65532:65532
ENTRYPOINT ["/controller"]
