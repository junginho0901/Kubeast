package handler

import (
	"strings"
	"testing"
)

const storeAllowEnv = "CLUSTER_STORE_ALLOWED_HOSTS"

var storeValidators = map[string]func(string) error{
	"prometheus_url": validatePrometheusURL,
	"log_search_url": validateLogSearchURL,
}

func TestStoreURLCannotBeCloudMetadata(t *testing.T) {
	for _, bad := range []string{
		"http://169.254.169.254/",
		"http://169.254.169.254:80/latest/meta-data",
		"https://169.254.170.2/",
		"http://[fd00:ec2::254]/",
		"http://[::ffff:169.254.169.254]/",
		"http://[64:ff9b::a9fe:a9fe]/",
		"http://[2002:a9fe:a9fe::]/",
		"http://[fe80::1]:9090/",
		"http://metadata.google.internal/",
		"http://METADATA.GOOGLE.INTERNAL./",
		"http://metadata/",
		"http://instance-data/",
	} {
		for field, validate := range storeValidators {
			err := validate(bad)
			if err == nil || !strings.Contains(err.Error(), field) {
				t.Errorf("%s %q: %v, want a refusal naming the field", field, bad, err)
			}
		}
	}
}

func TestStoreURLCannotBeTheServiceItselfUnlessListed(t *testing.T) {
	addresses := []string{"http://127.0.0.1:9090", "http://127.8.8.8:9090", "http://localhost:9090", "http://foo.localhost:9090/", "http://[::1]:9090", "http://0.0.0.0:9090", "http://[::]:9090", "http://[::ffff:127.0.0.1]:9090"}
	for _, bad := range addresses {
		for field, validate := range storeValidators {
			err := validate(bad)
			if err == nil || !strings.Contains(err.Error(), "features.clusterStoreAllowedHosts") {
				t.Errorf("%s %q: %v, want a refusal naming the setting", field, bad, err)
			}
		}
	}
	t.Setenv(storeAllowEnv, "localhost,127.0.0.1")
	for _, ok := range []string{"http://localhost:9090", "http://127.0.0.1:9090"} {
		if err := validatePrometheusURL(ok); err != nil {
			t.Errorf("%q on the list: %v", ok, err)
		}
	}
}

func TestStoreURLOnPrivateAddressesStaysOpen(t *testing.T) {
	for _, ok := range []string{
		"http://10.84.0.5:9090",
		"http://172.18.0.3:30090",
		"http://192.168.1.10:9090/select/0/prometheus",
		"http://100.64.0.1:9090",
		"http://[fd12:3456::1]:9090",
		"http://prom.monitoring.svc:9090",
		"http://prom.monitoring.svc.cluster.local:9090",
		"http://kubeast-b-control-plane:31999",
		"https://metrics.example.com/prometheus",
		"http://8.8.8.8:9090",
		"http://169.254.169.254.example.com/",
	} {
		for field, validate := range storeValidators {
			if err := validate(ok); err != nil {
				t.Errorf("%s %q: %v", field, ok, err)
			}
		}
	}
}

func TestStoreURLWithAListKeepsToTheList(t *testing.T) {
	t.Setenv(storeAllowEnv, "prom.monitoring.svc, .corp.example.com,10.84.0.5")
	for _, ok := range []string{"http://prom.monitoring.svc:9090", "http://metrics.corp.example.com", "http://corp.example.com", "http://10.84.0.5:9090", "http://PROM.monitoring.svc:9090"} {
		if err := validatePrometheusURL(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://10.84.0.6:9090", "https://metrics.example.com", "http://evilcorp.example.com", "http://localhost:9090"} {
		if err := validatePrometheusURL(bad); err == nil || !strings.Contains(err.Error(), "features.clusterStoreAllowedHosts") {
			t.Errorf("%q: %v, want a refusal naming the setting", bad, err)
		}
	}
}

func TestStoreURLMetadataStaysRefusedWhateverTheListSays(t *testing.T) {
	t.Setenv(storeAllowEnv, "169.254.169.254,metadata.google.internal")
	for _, bad := range []string{"http://169.254.169.254/", "http://metadata.google.internal/"} {
		if err := validateLogSearchURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
