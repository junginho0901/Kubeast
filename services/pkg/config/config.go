package config

import (
	"os"
	"strconv"
	"strings"
)

// GetEnv returns the environment variable value or a default.
func GetEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

// GetEnvInt returns the environment variable as an int or a default.
func GetEnvInt(key string, defaultVal int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return defaultVal
	}
	return i
}

// GetEnvBool returns the environment variable as a bool or a default.
func GetEnvBool(key string, defaultVal bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return defaultVal
	}
	return b
}

// GetEnvList returns the environment variable split by comma.
func GetEnvList(key, defaultVal string) []string {
	return splitList(GetEnv(key, defaultVal))
}

// LookupEnvList is GetEnvList for variables where "set to nothing" means
// "none" rather than "use the default": the default applies only when the
// variable is absent, so ALLOWED_ORIGINS="" yields an empty list.
func LookupEnvList(key, defaultVal string) []string {
	if v, ok := os.LookupEnv(key); ok {
		return splitList(v)
	}
	return splitList(defaultVal)
}

func splitList(v string) []string {
	parts := strings.Split(v, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}
