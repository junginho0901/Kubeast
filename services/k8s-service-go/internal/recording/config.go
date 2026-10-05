// Package recording records pod exec and node shell terminals as asciicast v2:
// the output the user saw (not keystrokes), written to a local spool file and
// uploaded in parts while the session runs, so losing the k8s-service pod
// costs at most one part interval. docs/audit-log-plan.md §4-1.
package recording

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

// DatabaseMaxBytes caps a recording kept in the database store.
const DatabaseMaxBytes = 1 << 20

type Config struct {
	Enabled      bool
	Required     bool  // refuse the session when the recording cannot start
	MaxBytes     int64 // per session; past it recording stops (marker + truncated)
	ChunkSeconds int   // upload a part this often while the session runs
	SpoolDir     string
	Storage      string // s3 | database | file
	FileDir      string
	S3           S3Config
	SecretDir    string // accessKeyId / secretAccessKey files (empty → the default AWS chain / IRSA)
}

type S3Config struct {
	Bucket         string
	Prefix         string
	Region         string
	Endpoint       string
	ForcePathStyle bool
	SSE            string // "" | AES256 | aws:kms
	KMSKeyID       string
}

// LoadConfig reads SESSION_RECORDING_* from the environment.
func LoadConfig() Config {
	c := Config{
		Enabled:      pkgconfig.GetEnvBool("SESSION_RECORDING_ENABLED", false),
		Required:     pkgconfig.GetEnvBool("SESSION_RECORDING_REQUIRED", true),
		MaxBytes:     int64(pkgconfig.GetEnvInt("SESSION_RECORDING_MAX_BYTES", 64<<20)),
		ChunkSeconds: pkgconfig.GetEnvInt("SESSION_RECORDING_CHUNK_SEC", 30),
		SpoolDir:     pkgconfig.GetEnv("SESSION_RECORDING_SPOOL_DIR", "/var/lib/kubeast-recordings"),
		Storage:      strings.ToLower(pkgconfig.GetEnv("SESSION_RECORDING_STORAGE", "")),
		FileDir:      pkgconfig.GetEnv("SESSION_RECORDING_FILE_DIR", "/var/lib/kubeast-recordings-store"),
		SecretDir:    pkgconfig.GetEnv("SESSION_RECORDING_SECRET_DIR", ""),
		S3: S3Config{
			Bucket:         pkgconfig.GetEnv("SESSION_RECORDING_S3_BUCKET", ""),
			Prefix:         pkgconfig.GetEnv("SESSION_RECORDING_S3_PREFIX", "sessions/"),
			Region:         pkgconfig.GetEnv("SESSION_RECORDING_S3_REGION", ""),
			Endpoint:       pkgconfig.GetEnv("SESSION_RECORDING_S3_ENDPOINT", ""),
			ForcePathStyle: pkgconfig.GetEnvBool("SESSION_RECORDING_S3_FORCE_PATH_STYLE", false),
			SSE:            pkgconfig.GetEnv("SESSION_RECORDING_S3_SSE", ""),
			KMSKeyID:       pkgconfig.GetEnv("SESSION_RECORDING_S3_KMS_KEY_ID", ""),
		},
	}
	// "S3 when a bucket is set, the database otherwise" when the store is not named.
	if c.Storage == "" {
		if c.S3.Bucket != "" {
			c.Storage = "s3"
		} else {
			c.Storage = "database"
		}
	}
	return c
}

// Validate checks the settings that matter once recording is on.
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	if c.ChunkSeconds < 1 {
		return fmt.Errorf("SESSION_RECORDING_CHUNK_SEC must be at least 1 (got %d)", c.ChunkSeconds)
	}
	if c.MaxBytes < 4096 {
		return fmt.Errorf("SESSION_RECORDING_MAX_BYTES must be at least 4096 (got %d)", c.MaxBytes)
	}
	if strings.TrimSpace(c.SpoolDir) == "" {
		return errors.New("SESSION_RECORDING_SPOOL_DIR is empty")
	}
	switch c.Storage {
	case "s3":
		if c.S3.Bucket == "" {
			return errors.New("SESSION_RECORDING_S3_BUCKET is required for the s3 store")
		}
		if c.S3.SSE != "" && c.S3.SSE != "AES256" && c.S3.SSE != "aws:kms" {
			return fmt.Errorf("SESSION_RECORDING_S3_SSE must be empty, AES256 or aws:kms (got %q)", c.S3.SSE)
		}
	case "database":
	case "file":
		if strings.TrimSpace(c.FileDir) == "" {
			return errors.New("SESSION_RECORDING_FILE_DIR is empty")
		}
	default:
		return fmt.Errorf("SESSION_RECORDING_STORAGE %q: s3, database or file", c.Storage)
	}
	return nil
}

// effectiveMaxBytes applies the database store's own cap.
func (c Config) effectiveMaxBytes() int64 {
	if c.Storage == "database" && c.MaxBytes > DatabaseMaxBytes {
		return DatabaseMaxBytes
	}
	return c.MaxBytes
}

// readSecret returns "" for an absent key; a key that is there but cannot be
// read (file mode, fsGroup) is an error, not a silent fall-back to IRSA.
func readSecret(dir, key string) (string, error) {
	if dir == "" {
		return "", nil
	}
	b, err := os.ReadFile(filepath.Join(dir, key))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("recording secret %s: %w", key, err)
	}
	return strings.TrimSpace(string(b)), nil
}
