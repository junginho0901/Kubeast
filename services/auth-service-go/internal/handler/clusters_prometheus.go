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

// lokiTenant is what Loki takes as a tenant ID (X-Scope-OrgID): at most 150
// bytes of letters, digits and ! - _ . * ' ( ) — "." and ".." are refused below.
var lokiTenant = regexp.MustCompile(`^[A-Za-z0-9!\-_.*'()]{1,150}$`)

// validatePrometheusURL accepts an absolute http(s) URL without credentials.
func validatePrometheusURL(raw string) error {
	return validateStoreURL("prometheus_url", "prometheus_auth", raw)
}

// validateLogSearchURL is the same for a cluster's own log store.
func validateLogSearchURL(raw string) error {
	return validateStoreURL("log_search_url", "log_search_auth", raw)
}

// validateStoreURL accepts an absolute http(s) URL without credentials for
// field; authField names where credentials go instead.
func validateStoreURL(field, authField, raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return errors.New(field + ": not a URL")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New(field + ": must be an absolute http or https URL")
	}
	if u.User != nil {
		return errors.New(field + ": put credentials in " + authField + ", not in the URL")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return errors.New(field + ": no query string or fragment")
	}
	return nil
}

// validateLogSearchTenant checks a Loki tenant ID.
func validateLogSearchTenant(raw string) error {
	t := strings.TrimSpace(raw)
	if t == "." || t == ".." || !lokiTenant.MatchString(t) {
		return errors.New("log_search_tenant: at most 150 characters of letters, digits and ! - _ . * ' ( ), not . or ..")
	}
	return nil
}

// prometheusAuthHeader turns the request into the Authorization header value
// to store ("" for none).
func prometheusAuthHeader(a model.PrometheusAuthRequest) (string, error) {
	return authHeaderFromRequest("prometheus_auth", a)
}

// logSearchAuthHeader is the same for a cluster's own log store.
func logSearchAuthHeader(a model.AuthHeaderRequest) (string, error) {
	return authHeaderFromRequest("log_search_auth", a)
}

func authHeaderFromRequest(field string, a model.PrometheusAuthRequest) (string, error) {
	switch strings.ToLower(strings.TrimSpace(a.Type)) {
	case "", "none":
		return "", nil
	case "bearer":
		if strings.TrimSpace(a.Token) == "" {
			return "", errors.New(field + ": bearer needs a token")
		}
		return "Bearer " + strings.TrimSpace(a.Token), nil
	case "basic":
		if a.Username == "" || a.Password == "" {
			return "", errors.New(field + ": basic needs a username and a password")
		}
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(a.Username+":"+a.Password)), nil
	}
	return "", errors.New(field + ": type must be none, bearer or basic")
}
