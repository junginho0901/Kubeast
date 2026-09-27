package k8ssetup

import (
	"fmt"
	"net/http"
	"time"
)

// CheckK8sServiceHealth calls k8s-service health endpoint.
func CheckK8sServiceHealth(url string, timeout int) (string, string) {
	client := &http.Client{Timeout: time.Duration(timeout) * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return "unknown", err.Error()
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		return "connected", ""
	}
	return "connecting", fmt.Sprintf("status %d", resp.StatusCode)
}
