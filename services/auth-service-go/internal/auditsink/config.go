package auditsink

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the sinks file (AUDIT_SINKS_FILE) the chart renders from
// audit.sinks. Secrets are not in it: each sink's Secret is mounted at
// <secretsDir>/<sink name>/<key> and read by the sink.
type Config struct {
	Sinks []SinkConfig `yaml:"sinks"`
}

type SinkConfig struct {
	Name      string `yaml:"name"`
	Type      string `yaml:"type"`      // s3 | webhook | email | file
	StartFrom string `yaml:"startFrom"` // beginning | latest (default: beginning for s3/file, latest otherwise)
	Batch     struct {
		MaxEvents      int `yaml:"maxEvents"`
		MaxWaitSeconds int `yaml:"maxWaitSeconds"`
	} `yaml:"batch"`
	Filter  Filter        `yaml:"filter"`
	S3      S3Config      `yaml:"s3"`
	Webhook WebhookConfig `yaml:"webhook"`
	Email   EmailConfig   `yaml:"email"`
	File    FileConfig    `yaml:"file"`

	// secrets read from <secretsDir>/<name>/ at load time
	secrets map[string]string
}

var sinkName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$`)

// LoadFile reads the sinks file and each sink's mounted Secret. A missing
// path (empty) means no sinks.
func LoadFile(path, secretsDir string) (Config, error) {
	var cfg Config
	if strings.TrimSpace(path) == "" {
		return cfg, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("audit sinks file: %w", err)
	}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("audit sinks file %s: %w", path, err)
	}
	for i := range cfg.Sinks {
		cfg.Sinks[i].secrets = readSecretDir(filepath.Join(secretsDir, cfg.Sinks[i].Name))
	}
	return cfg, cfg.Validate()
}

func readSecretDir(dir string) map[string]string {
	out := map[string]string{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		// Secret volumes hold ..data symlinks; keys are the plain names.
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if b, err := os.ReadFile(filepath.Join(dir, e.Name())); err == nil {
			out[e.Name()] = strings.TrimSpace(string(b))
		}
	}
	return out
}

// Validate checks names, types and the fields each type needs.
func (c Config) Validate() error {
	seen := map[string]bool{}
	for _, s := range c.Sinks {
		if !sinkName.MatchString(s.Name) {
			return fmt.Errorf("audit sink name %q: lowercase letters, digits and '-', up to 42 characters", s.Name)
		}
		if seen[s.Name] {
			return fmt.Errorf("audit sink name %q is used twice", s.Name)
		}
		seen[s.Name] = true
		if s.StartFrom != "" && s.StartFrom != "beginning" && s.StartFrom != "latest" {
			return fmt.Errorf("audit sink %s: startFrom must be beginning or latest", s.Name)
		}
		if err := s.Filter.validate(); err != nil {
			return fmt.Errorf("audit sink %s: %w", s.Name, err)
		}
		if _, err := s.build(); err != nil {
			return fmt.Errorf("audit sink %s: %w", s.Name, err)
		}
	}
	return nil
}

// secret returns a mounted Secret key, or "".
func (s SinkConfig) secret(key string) string { return s.secrets[key] }

// batchLimits are the per-type defaults where the config leaves zero.
func (s SinkConfig) batchLimits() (maxEvents, maxWaitSeconds int) {
	maxEvents, maxWaitSeconds = s.Batch.MaxEvents, s.Batch.MaxWaitSeconds
	switch s.Type {
	case "s3":
		if maxEvents <= 0 {
			maxEvents = 500
		}
		if maxWaitSeconds <= 0 {
			maxWaitSeconds = 60
		}
	case "file":
		if maxEvents <= 0 {
			maxEvents = 500
		}
		if maxWaitSeconds <= 0 {
			maxWaitSeconds = 5
		}
	default:
		if maxEvents <= 0 {
			maxEvents = 20
		}
		if maxWaitSeconds <= 0 {
			maxWaitSeconds = 5
		}
	}
	return maxEvents, maxWaitSeconds
}

// startAtBeginning: archives (s3, file) copy the whole history by default;
// notification sinks start from now so enabling one does not replay it.
func (s SinkConfig) startAtBeginning() bool {
	if s.StartFrom != "" {
		return s.StartFrom == "beginning"
	}
	return s.Type == "s3" || s.Type == "file"
}

func (s SinkConfig) build() (Sink, error) {
	switch s.Type {
	case "s3":
		return newS3Sink(s)
	case "webhook":
		return newWebhookSink(s)
	case "email":
		return newEmailSink(s)
	case "file":
		return newFileSink(s)
	case "":
		return nil, errors.New("type is required (s3, webhook, email, file)")
	default:
		return nil, fmt.Errorf("unknown type %q (s3, webhook, email, file)", s.Type)
	}
}
