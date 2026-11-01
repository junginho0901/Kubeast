package buildlog

import (
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/base64"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// S3Config is storage "s3": AWS S3 or any S3-compatible store (MinIO,
// Ceph RGW, versitygw) reached through the client's endpoint and path
// style, with the same fields as sessionRecording.s3.
type S3Config struct {
	Bucket string
	// Prefix comes before <build>/<step>.log.gz; "" or ending with "/".
	Prefix string
	// SSE is "", "AES256" or "aws:kms" (with KMSKeyID, or the bucket's key).
	SSE      string
	KMSKeyID string
	// SpoolDir holds a log while it is written; it is uploaded whole when
	// the writer closes, so an object is a whole log or none.
	SpoolDir string
}

// S3 keeps logs as gzip objects: <prefix><build>/<step>.log.gz. The client
// comes from the caller (credentials from IRSA or mounted files, endpoint
// and path style for S3-compatible stores). Safe for concurrent use.
type S3 struct {
	c   *s3.Client
	cfg S3Config
}

var _ Store = (*S3)(nil)

// ClientOptions are the s3.Options the store expects: the endpoint and
// path style of an S3-compatible store, and checksums only where the API
// requires them, as session recordings set it — the SDK's trailing
// checksums are not understood by every S3-compatible store.
func ClientOptions(endpoint string, pathStyle bool) func(*s3.Options) {
	return func(o *s3.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
		o.UsePathStyle = pathStyle
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	}
}

// NewS3 checks the settings and the spool folder.
func NewS3(c *s3.Client, cfg S3Config) (*S3, error) {
	var errs []error
	if cfg.Bucket == "" {
		errs = append(errs, errors.New("s3: no bucket"))
	}
	if cfg.Prefix != "" && (!strings.HasSuffix(cfg.Prefix, "/") || strings.HasPrefix(cfg.Prefix, "/") || strings.Contains(cfg.Prefix, "..")) {
		errs = append(errs, fmt.Errorf("s3: prefix %q must end with / and not start with / or hold ..", cfg.Prefix))
	}
	switch cfg.SSE {
	case "", string(types.ServerSideEncryptionAes256):
		if cfg.KMSKeyID != "" {
			errs = append(errs, errors.New("s3: a KMS key needs sse aws:kms"))
		}
	case string(types.ServerSideEncryptionAwsKms):
	default:
		errs = append(errs, fmt.Errorf("s3: sse %q is not AES256 or aws:kms", cfg.SSE))
	}
	if cfg.SpoolDir == "" {
		errs = append(errs, errors.New("s3: no spool folder"))
	} else if err := os.MkdirAll(cfg.SpoolDir, 0o750); err != nil {
		errs = append(errs, err)
	}
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return &S3{c: c, cfg: cfg}, nil
}

func (s *S3) key(build, step string) string { return s.cfg.Prefix + build + "/" + step + suffix }

func (s *S3) Create(ctx context.Context, build, step string) (Writer, error) {
	if err := checkNames(build, step); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(s.cfg.SpoolDir, build+"-"+step+"-*"+suffix)
	if err != nil {
		return nil, err
	}
	sum := md5.New()
	return &s3Writer{s: s, ctx: ctx, key: s.key(build, step), tmp: tmp, sum: sum, gz: gzip.NewWriter(io.MultiWriter(tmp, sum))}, nil
}

type s3Writer struct {
	s    *S3
	ctx  context.Context
	key  string
	tmp  *os.File
	sum  hash.Hash // MD5 of what is uploaded: Object Lock buckets need Content-MD5
	gz   *gzip.Writer
	done bool
}

func (w *s3Writer) Write(p []byte) (int, error) {
	if w.done {
		return 0, errClosed
	}
	return w.gz.Write(p)
}

// Close uploads the whole log in one PutObject, which S3 makes visible at
// once or not at all.
func (w *s3Writer) Close() error {
	if w.done {
		return nil
	}
	w.done = true
	defer os.Remove(w.tmp.Name())
	defer w.tmp.Close()
	if err := w.gz.Close(); err != nil {
		return err
	}
	size, err := w.tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err := w.tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	in := &s3.PutObjectInput{
		Bucket:        aws.String(w.s.cfg.Bucket),
		Key:           aws.String(w.key),
		Body:          w.tmp,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String("application/gzip"),
		ContentMD5:    aws.String(base64.StdEncoding.EncodeToString(w.sum.Sum(nil))),
	}
	if sse := w.s.cfg.SSE; sse != "" {
		in.ServerSideEncryption = types.ServerSideEncryption(sse)
		if w.s.cfg.KMSKeyID != "" {
			in.SSEKMSKeyId = aws.String(w.s.cfg.KMSKeyID)
		}
	}
	if _, err := w.s.c.PutObject(w.ctx, in); err != nil {
		return fmt.Errorf("s3: put %s: %w", w.key, err)
	}
	return nil
}

func (w *s3Writer) Abort() error {
	if w.done {
		return nil
	}
	w.done = true
	return errors.Join(w.tmp.Close(), os.Remove(w.tmp.Name()))
}

func (s *S3) Open(ctx context.Context, build, step string) (io.ReadCloser, error) {
	if err := checkNames(build, step); err != nil {
		return nil, err
	}
	out, err := s.c.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(s.key(build, step))})
	if notFound(err) {
		return nil, fmt.Errorf("%s/%s: %w", build, step, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("s3: get %s/%s: %w", build, step, err)
	}
	gz, err := gzip.NewReader(out.Body)
	if err != nil {
		out.Body.Close()
		return nil, fmt.Errorf("%s/%s: %w", build, step, err)
	}
	return &s3Reader{gz: gz, body: out.Body}, nil
}

type s3Reader struct {
	gz   *gzip.Reader
	body io.ReadCloser
}

func (r *s3Reader) Read(p []byte) (int, error) { return r.gz.Read(p) }
func (r *s3Reader) Close() error               { return errors.Join(r.gz.Close(), r.body.Close()) }

func notFound(err error) bool {
	var nsk *types.NoSuchKey
	var api smithy.APIError
	return errors.As(err, &nsk) || (errors.As(err, &api) && (api.ErrorCode() == "NoSuchKey" || api.ErrorCode() == "NotFound"))
}

// list calls fn for every object under prefix, page by page.
func (s *S3) list(ctx context.Context, prefix string, fn func(types.Object)) error {
	p := s3.NewListObjectsV2Paginator(s.c, &s3.ListObjectsV2Input{Bucket: aws.String(s.cfg.Bucket), Prefix: aws.String(prefix)})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("s3: list %s: %w", prefix, err)
		}
		for _, o := range page.Contents {
			fn(o)
		}
	}
	return nil
}

func (s *S3) Steps(ctx context.Context, build string) ([]Step, error) {
	if err := checkBuild(build); err != nil {
		return nil, err
	}
	prefix := s.cfg.Prefix + build + "/"
	var out []Step
	err := s.list(ctx, prefix, func(o types.Object) {
		name, ok := strings.CutSuffix(strings.TrimPrefix(aws.ToString(o.Key), prefix), suffix)
		if !ok || checkStep(name) != nil {
			return
		}
		out = append(out, Step{Name: name, Size: aws.ToInt64(o.Size), Written: aws.ToTime(o.LastModified)})
	})
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("build %s: %w", build, ErrNotFound)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// DeleteBefore removes a build when every object under it was written
// before t. Keys that are not <build>/<…> are left alone. A bucket
// lifecycle rule can expire objects too, but leaves no list of builds for
// the audit record.
func (s *S3) DeleteBefore(ctx context.Context, t time.Time) ([]string, error) {
	newest := map[string]time.Time{}
	keys := map[string][]string{}
	err := s.list(ctx, s.cfg.Prefix, func(o types.Object) {
		rest := strings.TrimPrefix(aws.ToString(o.Key), s.cfg.Prefix)
		build, _, ok := strings.Cut(rest, "/")
		if !ok || checkBuild(build) != nil {
			return
		}
		if m := aws.ToTime(o.LastModified); m.After(newest[build]) {
			newest[build] = m
		}
		keys[build] = append(keys[build], aws.ToString(o.Key))
	})
	if err != nil {
		return nil, err
	}
	var gone []string
	for build, m := range newest {
		if m.Before(t) {
			gone = append(gone, build)
		}
	}
	sort.Strings(gone)
	for i, build := range gone {
		if err := s.delete(ctx, keys[build]); err != nil {
			return gone[:i], err
		}
	}
	return gone, nil
}

// delete removes keys, 1,000 to a request (DeleteObjects' limit).
func (s *S3) delete(ctx context.Context, keys []string) error {
	for len(keys) > 0 {
		n := min(len(keys), 1000)
		ids := make([]types.ObjectIdentifier, n)
		for i, k := range keys[:n] {
			ids[i] = types.ObjectIdentifier{Key: aws.String(k)}
		}
		out, err := s.c.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(s.cfg.Bucket),
			Delete: &types.Delete{Objects: ids, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return fmt.Errorf("s3: delete: %w", err)
		}
		if len(out.Errors) > 0 {
			e := out.Errors[0]
			return fmt.Errorf("s3: delete %s: %s %s", aws.ToString(e.Key), aws.ToString(e.Code), aws.ToString(e.Message))
		}
		keys = keys[n:]
	}
	return nil
}
