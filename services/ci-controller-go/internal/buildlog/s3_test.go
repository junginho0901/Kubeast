package buildlog

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
)

// The S3 store is tested against gofakes3 (in process) and, when
// KUBEAST_S3_TEST_ENDPOINT is set, the same tests run against a real
// S3-compatible store: versitygw, as deploy/kind/devtools.yaml runs it
// (KUBEAST_S3_TEST_ACCESS_KEY, KUBEAST_S3_TEST_SECRET_KEY).

// recorder keeps every request's method, path and headers.
type recorder struct {
	mu   sync.Mutex
	reqs []*http.Request
	next http.RoundTripper
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	r.mu.Lock()
	r.reqs = append(r.reqs, req.Clone(req.Context()))
	r.mu.Unlock()
	return r.next.RoundTrip(req)
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.reqs)
}

// deletes counts DeleteObjects requests (POST ?delete).
func (r *recorder) deletes() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, q := range r.reqs {
		if q.Method == http.MethodPost && q.URL.Query().Has("delete") {
			n++
		}
	}
	return n
}

func (r *recorder) last(method string) *http.Request {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.reqs) - 1; i >= 0; i-- {
		if r.reqs[i].Method == method {
			return r.reqs[i]
		}
	}
	return nil
}

type s3Env struct {
	name   string
	client *s3.Client
	bucket string
	rec    *recorder
	clock  gofakes3.TimeSourceAdvancer // nil on a real store
}

func s3Envs(t *testing.T) []*s3Env {
	t.Helper()
	envs := []*s3Env{fakeEnv(t)}
	if ep := os.Getenv("KUBEAST_S3_TEST_ENDPOINT"); ep != "" {
		envs = append(envs, realEnv(t, ep))
	}
	return envs
}

func client(t *testing.T, endpoint, id, secret string) (*s3.Client, *recorder) {
	t.Helper()
	rec := &recorder{next: http.DefaultTransport}
	c := s3.New(s3.Options{
		Region: "us-east-1",
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: id, SecretAccessKey: secret}, nil
		}),
		HTTPClient: &http.Client{Transport: rec},
	}, ClientOptions(endpoint, true))
	return c, rec
}

func fakeEnv(t *testing.T) *s3Env {
	t.Helper()
	clock := gofakes3.FixedTimeSource(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	backend := s3mem.New(s3mem.WithTimeSource(clock))
	srv := httptest.NewServer(gofakes3.New(backend, gofakes3.WithTimeSource(clock), gofakes3.WithTimeSkewLimit(0)).Server())
	t.Cleanup(srv.Close)
	if err := backend.CreateBucket("ci-logs"); err != nil {
		t.Fatal(err)
	}
	c, rec := client(t, srv.URL, "test", "test")
	return &s3Env{name: "gofakes3", client: c, bucket: "ci-logs", rec: rec, clock: clock}
}

func realEnv(t *testing.T, endpoint string) *s3Env {
	t.Helper()
	c, rec := client(t, endpoint, os.Getenv("KUBEAST_S3_TEST_ACCESS_KEY"), os.Getenv("KUBEAST_S3_TEST_SECRET_KEY"))
	bucket := fmt.Sprintf("kubeast-buildlog-%d", time.Now().UnixNano())
	if _, err := c.CreateBucket(context.Background(), &s3.CreateBucketInput{Bucket: aws.String(bucket)}); err != nil {
		t.Fatalf("create bucket on %s: %v", endpoint, err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		p := s3.NewListObjectsV2Paginator(c, &s3.ListObjectsV2Input{Bucket: aws.String(bucket)})
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				break
			}
			for _, o := range page.Contents {
				c.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: o.Key})
			}
		}
		c.DeleteBucket(ctx, &s3.DeleteBucketInput{Bucket: aws.String(bucket)})
	})
	return &s3Env{name: "real store", client: c, bucket: bucket, rec: rec}
}

func (e *s3Env) store(t *testing.T, cfg S3Config) *S3 {
	t.Helper()
	cfg.Bucket = e.bucket
	if cfg.SpoolDir == "" {
		cfg.SpoolDir = t.TempDir()
	}
	s, err := NewS3(e.client, cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (e *s3Env) raw(t *testing.T, key string) []byte {
	t.Helper()
	out, err := e.client.GetObject(context.Background(), &s3.GetObjectInput{Bucket: aws.String(e.bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("get %s: %v", key, err)
	}
	defer out.Body.Close()
	b, err := io.ReadAll(out.Body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestS3SaveAndRead(t *testing.T) {
	for _, e := range s3Envs(t) {
		t.Run(e.name, func(t *testing.T) {
			s := e.store(t, S3Config{Prefix: "ci/"})
			ctx := context.Background()
			b := NewBudget(Limit{MaxBytes: 64 << 10, Tail: 4 << 10})
			small := []byte("cloning\ncloned\n")
			var big bytes.Buffer
			for i := range 20000 {
				fmt.Fprintf(&big, "compiling package %d\n", i)
			}
			big.WriteString("error: build failed\n")
			if _, err := Save(ctx, s, b, "b-0001", "checkout", bytes.NewReader(small)); err != nil {
				t.Fatal(err)
			}
			r, err := Save(ctx, s, b, "b-0001", "build", bytes.NewReader(big.Bytes()))
			if err != nil || r.Read != int64(big.Len()) || r.Kept >= r.Read {
				t.Fatalf("save build: %+v %v", r, err)
			}
			if got := readAll(t, s, "b-0001", "checkout"); !bytes.Equal(got, small) {
				t.Errorf("checkout read back %q", got)
			}
			want := cutAll(t, NewBudget(Limit{MaxBytes: 64<<10 - int64(len(small)), Tail: 4 << 10}), big.Bytes())
			got := readAll(t, s, "b-0001", "build")
			if !bytes.Equal(got, want) || !bytes.HasSuffix(got, []byte("error: build failed\n")) {
				t.Errorf("build read back %d bytes, want %d", len(got), len(want))
			}
			// The object is gzip the real gzip reads, under <prefix><build>/<step>.log.gz.
			obj := e.raw(t, "ci/b-0001/build.log.gz")
			cmd := exec.Command("gzip", "-dc")
			cmd.Stdin = bytes.NewReader(obj)
			if out, err := cmd.Output(); err != nil || !bytes.Equal(out, got) {
				t.Errorf("gzip -dc of the object: %v (%d bytes)", err, len(out))
			}
			// Content-MD5 sent and right (Object Lock buckets need it); no
			// trailing checksum that S3-compatible stores may refuse.
			put := e.rec.last(http.MethodPut)
			sum := md5.Sum(obj)
			if put.Header.Get("Content-MD5") != base64.StdEncoding.EncodeToString(sum[:]) || put.Header.Get("X-Amz-Trailer") != "" || strings.Contains(put.Header.Get("Content-Encoding"), "aws-chunked") {
				t.Errorf("put headers: md5 %q trailer %q encoding %q", put.Header.Get("Content-MD5"), put.Header.Get("X-Amz-Trailer"), put.Header.Get("Content-Encoding"))
			}
			for h := range put.Header {
				if strings.HasPrefix(strings.ToLower(h), "x-amz-checksum-") || strings.EqualFold(h, "X-Amz-Sdk-Checksum-Algorithm") {
					t.Errorf("put sends %s: the SDK's checksums, which not every S3-compatible store reads", h)
				}
			}
			steps, err := s.Steps(ctx, "b-0001")
			if err != nil || len(steps) != 2 || steps[0].Name != "build" || steps[1].Name != "checkout" || steps[0].Size != int64(len(obj)) {
				t.Errorf("steps %+v %v", steps, err)
			}
			if _, err := s.Open(ctx, "b-0001", "scan"); !errors.Is(err, ErrNotFound) {
				t.Errorf("open a missing step: %v", err)
			}
			if _, err := s.Steps(ctx, "b-0002"); !errors.Is(err, ErrNotFound) {
				t.Errorf("steps of a missing build: %v", err)
			}
		})
	}
}

// TestS3NothingHalfWritten: an object appears only on Close, and the spool
// folder ends empty.
func TestS3NothingHalfWritten(t *testing.T) {
	for _, e := range s3Envs(t) {
		t.Run(e.name, func(t *testing.T) {
			spool := t.TempDir()
			s := e.store(t, S3Config{SpoolDir: spool})
			ctx := context.Background()
			w, err := s.Create(ctx, "b-2", "build")
			if err != nil {
				t.Fatal(err)
			}
			w.Write([]byte("half"))
			if _, err := s.Open(ctx, "b-2", "build"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("open while writing: %v", err)
			}
			if err := w.Abort(); err != nil {
				t.Fatal(err)
			}
			failing := io.MultiReader(strings.NewReader("some\n"), errReader{})
			if _, err := Save(ctx, s, NewBudget(DefaultLimit()), "b-2", "scan", failing); err == nil {
				t.Fatal("a failed read was saved")
			}
			cctx, cancel := context.WithCancel(ctx)
			cancel()
			if _, err := Save(cctx, s, NewBudget(DefaultLimit()), "b-2", "test", strings.NewReader("x")); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled save: %v", err)
			}
			if _, err := s.Steps(ctx, "b-2"); !errors.Is(err, ErrNotFound) {
				t.Errorf("failed saves left objects: %v", err)
			}
			if left, _ := os.ReadDir(spool); len(left) != 0 {
				t.Errorf("spool left %v", left)
			}
			if _, err := Save(ctx, s, NewBudget(DefaultLimit()), "b-2", "ok", strings.NewReader("x\n")); err != nil {
				t.Fatal(err)
			}
			if left, _ := os.ReadDir(spool); len(left) != 0 {
				t.Errorf("a finished save left %v in the spool", left)
			}
		})
	}
}

func TestS3NamesAreCheckedBeforeAnyRequest(t *testing.T) {
	e := fakeEnv(t)
	s := e.store(t, S3Config{})
	ctx := context.Background()
	before := e.rec.count()
	for _, n := range [][2]string{{"../x", "s"}, {"b", "../../etc"}, {"B", "s"}, {"", "s"}, {"b", ""}, {"b", "s/t"}, {strings.Repeat("a", 64), "s"}} {
		if _, err := s.Create(ctx, n[0], n[1]); err == nil {
			t.Errorf("create %q accepted", n)
		}
		if _, err := s.Open(ctx, n[0], n[1]); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("open %q: %v", n, err)
		}
	}
	if _, err := s.Steps(ctx, "../x"); err == nil {
		t.Error("steps of a path accepted")
	}
	if n := e.rec.count() - before; n != 0 {
		t.Errorf("refused names sent %d requests", n)
	}
}

func TestS3Encryption(t *testing.T) {
	e := fakeEnv(t)
	s := e.store(t, S3Config{SSE: "aws:kms", KMSKeyID: "alias/ci-logs"})
	if _, err := Save(context.Background(), s, NewBudget(DefaultLimit()), "b-1", "build", strings.NewReader("x\n")); err != nil {
		t.Fatal(err)
	}
	put := e.rec.last(http.MethodPut)
	if put.Header.Get("X-Amz-Server-Side-Encryption") != "aws:kms" || put.Header.Get("X-Amz-Server-Side-Encryption-Aws-Kms-Key-Id") != "alias/ci-logs" {
		t.Errorf("sse headers %q %q", put.Header.Get("X-Amz-Server-Side-Encryption"), put.Header.Get("X-Amz-Server-Side-Encryption-Aws-Kms-Key-Id"))
	}
	for _, bad := range []S3Config{
		{SpoolDir: t.TempDir()},
		{Bucket: "b", SpoolDir: t.TempDir(), Prefix: "ci"},
		{Bucket: "b", SpoolDir: t.TempDir(), Prefix: "/ci/"},
		{Bucket: "b", SpoolDir: t.TempDir(), Prefix: "a/../b/"},
		{Bucket: "b", SpoolDir: t.TempDir(), SSE: "aes256"},
		{Bucket: "b", SpoolDir: t.TempDir(), KMSKeyID: "k"},
		{Bucket: "b"},
	} {
		if _, err := NewS3(e.client, bad); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
}

// TestClientOptions: a client made with ClientOptions adds no SDK checksum
// to a PUT that has no Content-MD5 (the SDK's default adds CRC32 there;
// measured, raw/…/ci-buildlog-s3/checksum-probe.txt). DeleteObjects
// carries CRC32 either way: the API requires a checksum.
func TestClientOptions(t *testing.T) {
	e := fakeEnv(t)
	// Start from what config.LoadDefaultConfig hands s3.NewFromConfig — the
	// SDK's default "when supported" — as the server will; an s3.New with
	// these fields unset already behaves as "when required".
	base := e.client.Options()
	base.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenSupported
	base.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenSupported
	c := s3.New(base, ClientOptions(aws.ToString(base.BaseEndpoint), true))
	if _, err := c.PutObject(context.Background(), &s3.PutObjectInput{Bucket: aws.String(e.bucket), Key: aws.String("k"), Body: strings.NewReader("x")}); err != nil {
		t.Fatal(err)
	}
	for h := range e.rec.last(http.MethodPut).Header {
		if strings.HasPrefix(strings.ToLower(h), "x-amz-checksum-") || strings.EqualFold(h, "X-Amz-Trailer") {
			t.Errorf("a PUT without Content-MD5 sends %s", h)
		}
	}
	o := s3.Options{RequestChecksumCalculation: aws.RequestChecksumCalculationWhenSupported, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenSupported}
	ClientOptions("https://s3.internal:9000", true)(&o)
	if aws.ToString(o.BaseEndpoint) != "https://s3.internal:9000" || !o.UsePathStyle || o.ResponseChecksumValidation != aws.ResponseChecksumValidationWhenRequired {
		t.Errorf("options %+v", o)
	}
}

func TestS3DeleteBefore(t *testing.T) {
	for _, e := range s3Envs(t) {
		t.Run(e.name, func(t *testing.T) {
			s := e.store(t, S3Config{Prefix: "ci/"})
			ctx := context.Background()
			save := func(build, step string) {
				if _, err := Save(ctx, s, NewBudget(DefaultLimit()), build, step, strings.NewReader("log\n")); err != nil {
					t.Fatal(err)
				}
			}
			put := func(key string) {
				if _, err := e.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(e.bucket), Key: aws.String(key), Body: strings.NewReader("x")}); err != nil {
					t.Fatal(err)
				}
			}
			if e.clock == nil { // a real store: no clock to move, so only "before now" and "before then"
				save("old", "build")
				save("old", "scan")
				then := time.Now().Add(-time.Hour)
				if gone, err := s.DeleteBefore(ctx, then); err != nil || len(gone) != 0 {
					t.Fatalf("deleted %q %v before an hour ago", gone, err)
				}
				gone, err := s.DeleteBefore(ctx, time.Now().Add(time.Minute))
				if err != nil || strings.Join(gone, ",") != "old" {
					t.Fatalf("deleted %q %v", gone, err)
				}
				if _, err := s.Steps(ctx, "old"); !errors.Is(err, ErrNotFound) {
					t.Errorf("old: %v", err)
				}
				return
			}
			save("old", "build")
			save("old", "scan")
			save("mixed", "build")
			put("ci/Not-A-Build/x.log.gz")
			put("elsewhere/old2/build.log.gz")
			for i := range 1001 { // more than one DeleteObjects request
				put(fmt.Sprintf("ci/many/step-%04d.log.gz", i))
			}
			e.clock.Advance(100 * 24 * time.Hour)
			save("mixed", "scan")
			save("new", "build")
			cutoff := e.clock.Now().Add(-90 * 24 * time.Hour)
			before := e.rec.deletes()
			gone, err := s.DeleteBefore(ctx, cutoff)
			// S3 takes at most 1,000 keys to a DeleteObjects request (gofakes3
			// takes more): 1,001 keys are two requests, the old build one.
			if n := e.rec.deletes() - before; n != 3 {
				t.Errorf("%d DeleteObjects requests, want 3", n)
			}
			if err != nil || strings.Join(gone, ",") != "many,old" {
				t.Fatalf("deleted %q %v", gone, err)
			}
			for _, kept := range []string{"mixed", "new"} {
				if _, err := s.Steps(ctx, kept); err != nil {
					t.Errorf("%s: %v", kept, err)
				}
			}
			for _, key := range []string{"ci/Not-A-Build/x.log.gz", "elsewhere/old2/build.log.gz"} {
				e.raw(t, key)
			}
			n := 0
			p := s3.NewListObjectsV2Paginator(e.client, &s3.ListObjectsV2Input{Bucket: aws.String(e.bucket), Prefix: aws.String("ci/many/")})
			for p.HasMorePages() {
				page, err := p.NextPage(ctx)
				if err != nil {
					t.Fatal(err)
				}
				n += len(page.Contents)
			}
			if n != 0 {
				t.Errorf("%d objects of the 1,001 left", n)
			}
		})
	}
}

func TestS3ConcurrentSaves(t *testing.T) {
	for _, e := range s3Envs(t) {
		t.Run(e.name, func(t *testing.T) {
			s := e.store(t, S3Config{SpoolDir: filepath.Join(t.TempDir(), "spool")})
			ctx := context.Background()
			var wg sync.WaitGroup
			for i := range 6 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					build := fmt.Sprintf("b-%d", i)
					b := NewBudget(Limit{MaxBytes: 8192, Tail: 1024})
					for _, step := range []string{"checkout", "build", "scan"} {
						if _, err := Save(ctx, s, b, build, step, bytes.NewReader(bytes.Repeat([]byte(step+" line\n"), 1000))); err != nil {
							t.Error(err)
						}
					}
				}()
			}
			wg.Wait()
			for i := range 6 {
				if steps, err := s.Steps(ctx, fmt.Sprintf("b-%d", i)); err != nil || len(steps) != 3 {
					t.Errorf("b-%d steps %+v %v", i, steps, err)
				}
			}
		})
	}
}
