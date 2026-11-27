package auditsink

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go/middleware"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

func TestIsGCSEndpoint(t *testing.T) {
	for endpoint, want := range map[string]bool{
		"https://storage.googleapis.com":             true,
		"https://storage.googleapis.com/":            true,
		"HTTPS://Storage.GoogleAPIs.com:443":         true,
		"https://audit.storage.googleapis.com":       true,
		"":                                           false,
		"https://s3.us-west-2.amazonaws.com":         false,
		"https://0123abcd.r2.cloudflarestorage.com":  false,
		"http://minio.kubeast.svc:9000":              false,
		"https://storage.googleapis.com.example.com": false,
		"https://mystorage.googleapis.com":           false,
		"https://example.com/storage.googleapis.com": false,
	} {
		if got := isGCSEndpoint(endpoint); got != want {
			t.Errorf("isGCSEndpoint(%q) = %v, want %v", endpoint, got, want)
		}
	}
}

func TestWithoutQueryParam(t *testing.T) {
	for raw, want := range map[string]string{
		"":                           "",
		"x-id=PutObject":             "",
		"tagging&x-id=GetObject":     "tagging",
		"a=1%202&x-id=Get&b=c+d":     "a=1%202&b=c+d",
		"x-idx=1&x-id=Put&prefix=x-": "x-idx=1&prefix=x-",
	} {
		if got := withoutQueryParam(raw, "x-id"); got != want {
			t.Errorf("withoutQueryParam(%q) = %q, want %q", raw, got, want)
		}
	}
}

// The requests a sink sends to any endpoint other than Google Cloud Storage are
// the bytes the client made before GCS endpoints got their own steps.
func TestS3RequestsOutsideGCSAreUnchanged(t *testing.T) {
	isolateAWSConfig(t)
	for _, tc := range []struct {
		name string
		cfg  S3Config
	}{
		{"aws s3", S3Config{Bucket: "audit", Prefix: "kubeast", Region: "us-west-2"}},
		{"aws s3 with sse-kms", S3Config{Bucket: "audit", Region: "us-west-2", SSE: "aws:kms", KMSKeyID: "alias/audit"}},
		{"aws s3 endpoint", S3Config{Bucket: "audit", Region: "eu-central-1", Endpoint: "https://s3.eu-central-1.amazonaws.com"}},
		{"cloudflare r2", S3Config{Bucket: "audit", Region: "auto", Endpoint: "https://0123abcd.r2.cloudflarestorage.com"}},
		{"minio", S3Config{Bucket: "audit", Endpoint: "http://minio.kubeast.svc:9000", ForcePathStyle: true}},
		{"other store", S3Config{Bucket: "audit", Prefix: "/k/", Endpoint: "https://objects.example.internal", ForcePathStyle: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sc := SinkConfig{Name: "s3", Type: "s3", S3: tc.cfg, secrets: map[string]string{"accessKeyId": "AK", "secretAccessKey": "SK"}}
			now := wireRequests(t, sc, false)
			before := wireRequests(t, sc, true)
			if len(now) != 3 || len(before) != 3 {
				t.Fatalf("want 3 requests each, got %d and %d", len(now), len(before))
			}
			for i := range now {
				if !bytes.Equal(now[i], before[i]) {
					t.Errorf("request %d differs\nnow:    %q\nbefore: %q", i, now[i], before[i])
				}
				req := parseWire(t, now[i], tc.cfg.Endpoint)
				if !req.URL.Query().Has("x-id") || !strings.Contains(signedHeaders(req), "accept-encoding") {
					t.Errorf("request %d lost x-id or the signed Accept-Encoding: %q", i, now[i])
				}
			}
		})
	}
}

// For Google Cloud Storage, Accept-Encoding is sent but not signed and x-id is
// gone before signing, so the signature covers the request as GCS reads it.
func TestGCSRequestsLeaveAcceptEncodingUnsignedAndDropXID(t *testing.T) {
	isolateAWSConfig(t)
	for _, pathStyle := range []bool{false, true} {
		t.Run(fmt.Sprintf("path style %v", pathStyle), func(t *testing.T) {
			cfg := S3Config{Bucket: "audit", Prefix: "kubeast", Endpoint: "https://storage.googleapis.com", ForcePathStyle: pathStyle}
			sc := SinkConfig{Name: "gcs", Type: "s3", S3: cfg, secrets: map[string]string{"accessKeyId": "GOOG1EXAMPLE", "secretAccessKey": "SK"}}
			now := wireRequests(t, sc, false)
			before := wireRequests(t, sc, true)
			if len(now) != 3 || len(before) != 3 {
				t.Fatalf("want 3 requests each, got %d and %d", len(now), len(before))
			}
			for i := range now {
				old := parseWire(t, before[i], cfg.Endpoint)
				if !old.URL.Query().Has("x-id") || !strings.Contains(signedHeaders(old), "accept-encoding") {
					t.Fatalf("request %d: the client without the GCS steps no longer shows what GCS refuses: %q", i, before[i])
				}
				req := parseWire(t, now[i], cfg.Endpoint)
				if req.URL.Query().Has("x-id") {
					t.Errorf("request %d still has x-id: %s", i, req.URL)
				}
				if got := req.Header.Get("Accept-Encoding"); got != "identity" {
					t.Errorf("request %d Accept-Encoding = %q, want it still sent as identity", i, got)
				}
				if strings.Contains(signedHeaders(req), "accept-encoding") {
					t.Errorf("request %d signs Accept-Encoding: %s", i, req.Header.Get("Authorization"))
				}
				if want := resign(t, req, "GOOG1EXAMPLE", "SK"); req.Header.Get("Authorization") != want {
					t.Errorf("request %d signature does not cover the request as sent without Accept-Encoding\ngot:  %s\nwant: %s", i, req.Header.Get("Authorization"), want)
				}
			}
		})
	}
}

// isolateAWSConfig keeps the laptop's or runner's AWS settings out of the client.
func isolateAWSConfig(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(dir, "config"))
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", filepath.Join(dir, "credentials"))
	for _, k := range []string{"AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3",
		"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REQUEST_CHECKSUM_CALCULATION", "AWS_RESPONSE_CHECKSUM_VALIDATION"} {
		t.Setenv(k, "")
	}
}

// legacyS3Client is the client newS3Sink made before GCS endpoints got their own steps.
func legacyS3Client(t *testing.T, s SinkConfig) *s3.Client {
	t.Helper()
	c := s.S3
	opts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	}
	if c.Region != "" {
		opts = append(opts, awsconfig.WithRegion(c.Region))
	} else if c.Endpoint != "" {
		opts = append(opts, awsconfig.WithRegion("us-east-1"))
	}
	opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s.secret("accessKeyId"), s.secret("secretAccessKey"), "")))
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(), opts...)
	if err != nil {
		t.Fatal(err)
	}
	return s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
		}
		o.UsePathStyle = c.ForcePathStyle
	})
}

var fixedSigningTime = time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)

type fixedTimeSigner struct{ next s3.HTTPSignerV4 }

func (f fixedTimeSigner) SignHTTP(ctx context.Context, creds aws.Credentials, r *http.Request, payloadHash, service, region string, _ time.Time, optFns ...func(*v4.SignerOptions)) error {
	return f.next.SignHTTP(ctx, creds, r, payloadHash, service, region, fixedSigningTime, optFns...)
}

// wireCapture answers every request with 200 and keeps the bytes the client
// would have written to the connection.
type wireCapture struct {
	reqs [][]byte
	body []byte
}

func (c *wireCapture) Do(r *http.Request) (*http.Response, error) {
	dump, err := httputil.DumpRequestOut(r, true)
	if err != nil {
		return nil, err
	}
	c.reqs = append(c.reqs, dump)
	return &http.Response{StatusCode: 200, Status: "200 OK", Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: http.Header{"Content-Length": {fmt.Sprint(len(c.body))}}, ContentLength: int64(len(c.body)),
		Body: io.NopCloser(bytes.NewReader(c.body)), Request: r}, nil
}

// wireRequests runs a batch Send, an anchor PutObject and a GetObject through
// the sink sc builds (legacy: through the client it made before) and returns
// the requests as written. Only the clock, the invocation id and the
// connection are fixed, the same for both clients.
func wireRequests(t *testing.T, sc SinkConfig, legacy bool) [][]byte {
	t.Helper()
	built, err := sc.build()
	if err != nil {
		t.Fatal(err)
	}
	sink := built.(*s3Sink)
	client := sink.client
	if legacy {
		client = legacyS3Client(t, sc)
	}
	capture := &wireCapture{body: []byte(`{"anchor":true}`)}
	sink.client = s3.New(client.Options(), func(o *s3.Options) {
		o.HTTPClient = capture
		o.HTTPSignerV4 = fixedTimeSigner{o.HTTPSignerV4}
		o.AuthSchemes = nil // made again around the signer above
		o.APIOptions = append(o.APIOptions, func(stack *middleware.Stack) error {
			return stack.Build.Insert(middleware.BuildMiddlewareFunc("FixedInvocationID", func(ctx context.Context, in middleware.BuildInput, next middleware.BuildHandler) (middleware.BuildOutput, middleware.Metadata, error) {
				if req, ok := in.Request.(*smithyhttp.Request); ok {
					req.Header.Set("Amz-Sdk-Invocation-Id", "00000000-0000-4000-8000-000000000000")
				}
				return next.HandleBuild(ctx, in)
			}), "ClientRequestID", middleware.After)
		})
	})
	ctx := context.Background()
	if err := sink.Send(ctx, sampleEvents()); err != nil {
		t.Fatal(err)
	}
	if err := sink.PutObject(ctx, "digests/2026/11/26/120000Z-1-2-abcd.json", []byte(`{"anchor":true}`), "application/json", map[string]string{"anchor-hash": "ab"}); err != nil {
		t.Fatal(err)
	}
	if _, err := sink.GetObject(ctx, "digests/2026/11/26/120000Z-1-2-abcd.json"); err != nil {
		t.Fatal(err)
	}
	return capture.reqs
}

func parseWire(t *testing.T, wire []byte, endpoint string) *http.Request {
	t.Helper()
	req, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(wire)))
	if err != nil {
		t.Fatal(err)
	}
	scheme := "https"
	if strings.HasPrefix(endpoint, "http://") {
		scheme = "http"
	}
	if req.URL, err = url.Parse(scheme + "://" + req.Host + req.RequestURI); err != nil {
		t.Fatal(err)
	}
	return req
}

func signedHeaders(req *http.Request) string {
	_, after, _ := strings.Cut(req.Header.Get("Authorization"), "SignedHeaders=")
	list, _, _ := strings.Cut(after, ",")
	return list
}

// resign signs req again, without Accept-Encoding, at the fixed time.
func resign(t *testing.T, sent *http.Request, id, key string) string {
	t.Helper()
	body, err := io.ReadAll(sent.Body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(sent.Method, sent.URL.String(), bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header = sent.Header.Clone()
	req.Header.Del("Authorization")
	req.Header.Del("Accept-Encoding")
	req.ContentLength = sent.ContentLength
	signer := v4.NewSigner(func(o *v4.SignerOptions) { o.DisableURIPathEscaping = true })
	creds := aws.Credentials{AccessKeyID: id, SecretAccessKey: key}
	if err := signer.SignHTTP(context.Background(), creds, req, sent.Header.Get("X-Amz-Content-Sha256"), "s3", "us-east-1", fixedSigningTime); err != nil {
		t.Fatal(err)
	}
	return req.Header.Get("Authorization")
}
