package auditsink

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/aws/smithy-go/middleware"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// Google Cloud Storage's XML API takes SigV4 requests made for S3, but two
// things aws-sdk-go-v2 does make GCS answer SignatureDoesNotMatch
// (aws/aws-sdk-go-v2#1816): the SDK signs Accept-Encoding, which Google's front
// end changes on the way, and it adds an x-id query parameter. For a GCS
// endpoint only, Accept-Encoding is left out of the signature (and still sent)
// and x-id is dropped before signing, as rclone's GCS provider does. A client
// for any other endpoint does not get these steps.

// isGCSEndpoint reports whether endpoint is Google Cloud Storage's XML API
// (https://storage.googleapis.com, or a bucket's virtual host under it).
func isGCSEndpoint(endpoint string) bool {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "storage.googleapis.com" || strings.HasSuffix(host, ".storage.googleapis.com")
}

type gcsUnsignedHeaderKey struct{}

const gcsUnsignedHeader = "Accept-Encoding"

// gcsRequestSteps goes into s3.Options.APIOptions for a GCS endpoint.
func gcsRequestSteps(stack *middleware.Stack) error {
	if err := stack.Finalize.Insert(middleware.FinalizeMiddlewareFunc("GCSBeforeSigning", gcsBeforeSigning), "Signing", middleware.Before); err != nil {
		return err
	}
	return stack.Finalize.Insert(middleware.FinalizeMiddlewareFunc("GCSAfterSigning", gcsAfterSigning), "Signing", middleware.After)
}

func gcsBeforeSigning(ctx context.Context, in middleware.FinalizeInput, next middleware.FinalizeHandler) (middleware.FinalizeOutput, middleware.Metadata, error) {
	req, ok := in.Request.(*smithyhttp.Request)
	if !ok {
		return middleware.FinalizeOutput{}, middleware.Metadata{}, fmt.Errorf("gcs request: unexpected request type %T", in.Request)
	}
	if v := req.Header.Values(gcsUnsignedHeader); len(v) > 0 {
		ctx = middleware.WithStackValue(ctx, gcsUnsignedHeaderKey{}, append([]string(nil), v...))
		req.Header.Del(gcsUnsignedHeader)
	}
	req.URL.RawQuery = withoutQueryParam(req.URL.RawQuery, "x-id")
	return next.HandleFinalize(ctx, in)
}

func gcsAfterSigning(ctx context.Context, in middleware.FinalizeInput, next middleware.FinalizeHandler) (middleware.FinalizeOutput, middleware.Metadata, error) {
	req, ok := in.Request.(*smithyhttp.Request)
	if !ok {
		return middleware.FinalizeOutput{}, middleware.Metadata{}, fmt.Errorf("gcs request: unexpected request type %T", in.Request)
	}
	if v, ok := middleware.GetStackValue(ctx, gcsUnsignedHeaderKey{}).([]string); ok {
		req.Header[gcsUnsignedHeader] = v
	}
	return next.HandleFinalize(ctx, in)
}

// withoutQueryParam drops name from a raw query and leaves the other
// parameters as they were written.
func withoutQueryParam(raw, name string) string {
	if raw == "" {
		return raw
	}
	parts := strings.Split(raw, "&")
	kept := parts[:0]
	for _, p := range parts {
		key, _, _ := strings.Cut(p, "=")
		if key != name {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "&")
}
