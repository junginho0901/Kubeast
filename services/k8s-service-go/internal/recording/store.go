package recording

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store keeps the parts of recordings. location is what the store chose for
// a recording (an S3 key prefix, a directory, or the id for the database);
// parts are numbered from 0 and read back in order.
type Store interface {
	Location(r Meta) string
	PutPart(ctx context.Context, location string, part int, data []byte) error
	GetPart(ctx context.Context, location string, part int) ([]byte, error)
}

func partName(part int) string { return fmt.Sprintf("part-%05d.cast", part) }

// datedLocation: <prefix>YYYY/MM/DD/<cluster>/<id>/
func datedLocation(prefix string, r Meta) string {
	p := strings.Trim(prefix, "/")
	if p != "" {
		p += "/"
	}
	return fmt.Sprintf("%s%s/%s/%s/", p, r.StartedAt.UTC().Format("2006/01/02"), safeSegment(r.Cluster), r.ID)
}

func safeSegment(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			return r
		}
		return '_'
	}, s)
	if s == "" || s == "." || s == ".." {
		return "_"
	}
	return s
}

// --- S3-compatible ---

type s3Store struct {
	cfg    S3Config
	client *s3.Client
}

func newS3Store(c S3Config, secretDir string) (*s3Store, error) {
	opts := []func(*awsconfig.LoadOptions) error{
		// Content-MD5 on every PUT (Object Lock buckets need it); the SDK's
		// trailing checksums are not understood by every S3-compatible store.
		awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	}
	if c.Region != "" {
		opts = append(opts, awsconfig.WithRegion(c.Region))
	} else if c.Endpoint != "" {
		opts = append(opts, awsconfig.WithRegion("us-east-1"))
	}
	// Keys come from mounted files, never AWS_* env: k8s-service's own AWS
	// identity (IRSA for EKS tokens) must stay untouched.
	id, err := readSecret(secretDir, "accessKeyId")
	if err != nil {
		return nil, err
	}
	key, err := readSecret(secretDir, "secretAccessKey")
	if err != nil {
		return nil, err
	}
	if id != "" || key != "" {
		if id == "" || key == "" {
			return nil, errors.New("the recording Secret needs both accessKeyId and secretAccessKey (or neither, for IRSA)")
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
	})
	return &s3Store{cfg: c, client: client}, nil
}

func (s *s3Store) Location(r Meta) string { return datedLocation(s.cfg.Prefix, r) }

func (s *s3Store) PutPart(ctx context.Context, location string, part int, data []byte) error {
	sum := md5.Sum(data)
	in := &s3.PutObjectInput{
		Bucket:      aws.String(s.cfg.Bucket),
		Key:         aws.String(location + partName(part)),
		Body:        bytes.NewReader(data),
		ContentType: aws.String("application/x-asciicast"),
		ContentMD5:  aws.String(base64.StdEncoding.EncodeToString(sum[:])),
	}
	switch s.cfg.SSE {
	case "AES256":
		in.ServerSideEncryption = types.ServerSideEncryptionAes256
	case "aws:kms":
		in.ServerSideEncryption = types.ServerSideEncryptionAwsKms
		if s.cfg.KMSKeyID != "" {
			in.SSEKMSKeyId = aws.String(s.cfg.KMSKeyID)
		}
	}
	if _, err := s.client.PutObject(ctx, in); err != nil {
		return fmt.Errorf("s3 put %s: %w", aws.ToString(in.Key), err)
	}
	return nil
}

func (s *s3Store) GetPart(ctx context.Context, location string, part int) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(location + partName(part))})
	if err != nil {
		return nil, fmt.Errorf("s3 get %s: %w", location+partName(part), err)
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

// --- files (a PVC) ---

type fileStore struct{ dir string }

func (f fileStore) Location(r Meta) string { return datedLocation("", r) }

func (f fileStore) PutPart(_ context.Context, location string, part int, data []byte) error {
	dir := filepath.Join(f.dir, filepath.FromSlash(location))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "."+partName(part))
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, partName(part)))
}

func (f fileStore) GetPart(_ context.Context, location string, part int) ([]byte, error) {
	return os.ReadFile(filepath.Join(f.dir, filepath.FromSlash(location), partName(part)))
}

// --- database (session_recording_parts) ---

type dbStore struct{ pool *pgxpool.Pool }

func (d dbStore) Location(r Meta) string { return r.ID }

func (d dbStore) PutPart(ctx context.Context, location string, part int, data []byte) error {
	_, err := d.pool.Exec(ctx,
		`INSERT INTO session_recording_parts (recording_id, part_no, data) VALUES ($1, $2, $3)
		 ON CONFLICT (recording_id, part_no) DO UPDATE SET data = EXCLUDED.data`, location, part, data)
	return err
}

func (d dbStore) GetPart(ctx context.Context, location string, part int) ([]byte, error) {
	var data []byte
	err := d.pool.QueryRow(ctx, `SELECT data FROM session_recording_parts WHERE recording_id = $1 AND part_no = $2`, location, part).Scan(&data)
	return data, err
}

func newStore(c Config, pool *pgxpool.Pool) (Store, error) {
	switch c.Storage {
	case "s3":
		return newS3Store(c.S3, c.SecretDir)
	case "file":
		return fileStore{dir: c.FileDir}, nil
	case "database":
		return dbStore{pool: pool}, nil
	}
	return nil, fmt.Errorf("unknown store %q", c.Storage)
}
