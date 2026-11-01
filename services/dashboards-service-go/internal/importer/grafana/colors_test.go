package grafana

import "testing"

func TestToken(t *testing.T) {
	cases := []struct {
		in    string
		token string
		exact bool
	}{
		{"green", "state-ok", true},
		{"semi-dark-red", "state-crit", false},
		{"dark-orange", "state-warn", false},
		{"yellow", "state-warn", false}, // orange is state-warn's name
		{"orange", "state-warn", true},
		{"white", "neutral", false},
		{"blue", "state-info", true},
		{"text", "neutral", true},
		{"#73BF69", "state-ok", false},   // Grafana's green
		{"#F2495C", "state-crit", false}, // Grafana's red
		{"#FF9830", "state-warn", false}, // Grafana's orange
		{"#5794F2", "state-info", false}, // Grafana's blue
		{"#808080", "neutral", false},
		{"rgba(237, 129, 40, 0.89)", "state-warn", false},
		{"#abc", "state-info", false},
		{"not-a-colour", "neutral", false},
		{"", "", true},
	}
	for _, c := range cases {
		token, exact := Token(c.in)
		if token != c.token || exact != c.exact {
			t.Errorf("Token(%q) = %q, %v; want %q, %v", c.in, token, exact, c.token, c.exact)
		}
	}
}
