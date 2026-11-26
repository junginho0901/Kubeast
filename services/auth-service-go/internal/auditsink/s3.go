package auditsink

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3Config: any S3-compatible store (AWS S3, MinIO, GCS interoperability,
// Cloudflare R2). Credentials come from the sink's Secret (accessKeyId,
// secretAccessKey) or, without one, from the default AWS chain — IRSA on EKS.
// Object Lock (or GCS retention, an R2 bucket lock) is left to the bucket:
// Kubeast needs s3:PutObject, and s3:GetObject to read back the anchor digests
// and a resent batch that the bucket refuses to replace.
type S3Config struct {
	Bucket         string `yaml:"bucket"`
	Prefix         string `yaml:"prefix"`
	Region         string `yaml:"region"`
	Endpoint       string `yaml:"endpoint"`
	ForcePathStyle bool   `yaml:"forcePathStyle"`
	SSE            string `yaml:"sse"` // "" (bucket default) | AES256 | aws:kms
	KMSKeyID       string `yaml:"kmsKeyId"`
}

type s3Sink struct {
	cfg    S3Config
	client *s3.Client
}

func newS3Sink(s SinkConfig) (Sink, error) {
	c := s.S3
	if strings.TrimSpace(c.Bucket) == "" {
		return nil, errors.New("s3.bucket is required")
	}
	if c.SSE != "" && c.SSE != "AES256" && c.SSE != "aws:kms" {
		return nil, fmt.Errorf("s3.sse must be empty, AES256 or aws:kms (got %q)", c.SSE)
	}
	opts := []func(*awsconfig.LoadOptions) error{
		// Integrity: Content-MD5 is set on every PUT (what Object Lock buckets
		// require); the SDK's own trailing checksums are not understood by
		// every S3-compatible store.
		awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	}
	if c.Region != "" {
		opts = append(opts, awsconfig.WithRegion(c.Region))
	} else if c.Endpoint != "" {
		opts = append(opts, awsconfig.WithRegion("us-east-1"))
	}
	if id, key := s.secret("accessKeyId"), s.secret("secretAccessKey"); id != "" || key != "" {
		if id == "" || key == "" {
			return nil, errors.New("the sink Secret needs both accessKeyId and secretAccessKey (or neither, for IRSA)")
		}
		opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(id, key, "")))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(), opts...)
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
		}
		o.UsePathStyle = c.ForcePathStyle
		if isGCSEndpoint(c.Endpoint) {
			o.APIOptions = append(o.APIOptions, gcsRequestSteps)
		}
	})
	return &s3Sink{cfg: c, client: client}, nil
}

// objectKey: prefix/YYYY/MM/DD/HH/<first id>-<last id>.ndjson.gz, hour of the
// first event (UTC). A resent batch lands on the same key.
func (s *s3Sink) objectKey(events []Event) string {
	first, last := events[0], events[len(events)-1]
	return s.fullKey(fmt.Sprintf("%s/%012d-%012d.ndjson.gz", first.Time.UTC().Format("2006/01/02/15"), first.ID, last.ID))
}

// fullKey puts key under the sink's prefix.
func (s *s3Sink) fullKey(key string) string {
	prefix := strings.Trim(s.cfg.Prefix, "/")
	if prefix != "" {
		prefix += "/"
	}
	return prefix + strings.TrimLeft(key, "/")
}

func (s *s3Sink) applySSE(in *s3.PutObjectInput) {
	switch s.cfg.SSE {
	case "AES256":
		in.ServerSideEncryption = types.ServerSideEncryptionAes256
	case "aws:kms":
		in.ServerSideEncryption = types.ServerSideEncryptionAwsKms
		if s.cfg.KMSKeyID != "" {
			in.SSEKMSKeyId = aws.String(s.cfg.KMSKeyID)
		}
	}
}

// ObjectStore is an s3 sink used as a plain object store: the audit chain
// writes its digests under the sink's prefix (keys are relative to it).
type ObjectStore interface {
	PutObject(ctx context.Context, key string, body []byte, contentType string, meta map[string]string) error
	GetObject(ctx context.Context, key string) ([]byte, error)
}

func (s *s3Sink) PutObject(ctx context.Context, key string, body []byte, contentType string, meta map[string]string) error {
	sum := md5.Sum(body)
	in := &s3.PutObjectInput{
		Bucket:      aws.String(s.cfg.Bucket),
		Key:         aws.String(s.fullKey(key)),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
		ContentMD5:  aws.String(base64.StdEncoding.EncodeToString(sum[:])),
		Metadata:    meta,
	}
	s.applySSE(in)
	if _, err := s.client.PutObject(ctx, in); err != nil {
		return fmt.Errorf("s3 put %s: %w", aws.ToString(in.Key), err)
	}
	return nil
}

func (s *s3Sink) GetObject(ctx context.Context, key string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(s.fullKey(key))})
	if err != nil {
		return nil, fmt.Errorf("s3 get %s: %w", s.fullKey(key), err)
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

func ndjsonGzip(events []Event) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	enc := json.NewEncoder(zw)
	for _, e := range events {
		if err := enc.Encode(e); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (s *s3Sink) Send(ctx context.Context, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	body, err := ndjsonGzip(events)
	if err != nil {
		return err
	}
	sum := md5.Sum(body)
	in := &s3.PutObjectInput{
		Bucket:      aws.String(s.cfg.Bucket),
		Key:         aws.String(s.objectKey(events)),
		Body:        bytes.NewReader(body),
		ContentType: aws.String("application/gzip"),
		ContentMD5:  aws.String(base64.StdEncoding.EncodeToString(sum[:])),
	}
	s.applySSE(in)
	if _, err := s.client.PutObject(ctx, in); err != nil {
		key := aws.ToString(in.Key)
		if !refusedRewrite(err) {
			return fmt.Errorf("s3 put %s: %w", key, err)
		}
		// A batch is sent again when the cursor did not move after a write that
		// went through. A bucket that keeps objects from being replaced refuses
		// that second write; the batch is sent if the key already holds it.
		same, gerr := s.holds(ctx, key, body)
		if gerr != nil {
			return fmt.Errorf("s3 put %s: %w; reading the key back: %v", key, err, gerr)
		}
		if !same {
			return fmt.Errorf("s3 put %s: %w; the object already under this key differs", key, err)
		}
		slog.Info("audit sink: the bucket refused to replace a resent batch that it already holds; counted as sent", "bucket", s.cfg.Bucket, "key", key)
	}
	return nil
}

// refusedRewrite: GCS answers 403 (retentionPolicyNotMet) to a write of a key
// under a retention policy, and an R2 bucket lock answers 409.
func refusedRewrite(err error) bool {
	var re interface{ HTTPStatusCode() int }
	if !errors.As(err, &re) {
		return false
	}
	code := re.HTTPStatusCode()
	return code == http.StatusForbidden || code == http.StatusConflict
}

// holds reports whether key already holds exactly body.
func (s *s3Sink) holds(ctx context.Context, key string, body []byte) (bool, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key)})
	if err != nil {
		return false, err
	}
	defer out.Body.Close()
	if out.ContentLength != nil && *out.ContentLength != int64(len(body)) {
		return false, nil
	}
	got, err := io.ReadAll(io.LimitReader(out.Body, int64(len(body))+1))
	if err != nil {
		return false, err
	}
	return bytes.Equal(got, body), nil
}
