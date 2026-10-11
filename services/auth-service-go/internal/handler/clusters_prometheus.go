package handler

import (
	"encoding/base64"
	"errors"
	"net/url"
	"regexp"
	"strings"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

// promLabelValue is what a Prometheus label value registered for a cluster may
// look like (it is put into a PromQL matcher verbatim).
var promLabelValue = regexp.MustCompile(`^[A-Za-z0-9_.:/-]{1,128}$`)

// validatePrometheusURL accepts an absolute http(s) URL without credentials.
func validatePrometheusURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return errors.New("prometheus_url: not a URL")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("prometheus_url: must be an absolute http or https URL")
	}
	if u.User != nil {
		return errors.New("prometheus_url: put credentials in prometheus_auth, not in the URL")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return errors.New("prometheus_url: no query string or fragment")
	}
	return nil
}

// prometheusAuthHeader turns the request into the Authorization header value
// to store ("" for none).
func prometheusAuthHeader(a model.PrometheusAuthRequest) (string, error) {
	switch strings.ToLower(strings.TrimSpace(a.Type)) {
	case "", "none":
		return "", nil
	case "bearer":
		if strings.TrimSpace(a.Token) == "" {
			return "", errors.New("prometheus_auth: bearer needs a token")
		}
		return "Bearer " + strings.TrimSpace(a.Token), nil
	case "basic":
		if a.Username == "" || a.Password == "" {
			return "", errors.New("prometheus_auth: basic needs a username and a password")
		}
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(a.Username+":"+a.Password)), nil
	}
	return "", errors.New("prometheus_auth: type must be none, bearer or basic")
}
