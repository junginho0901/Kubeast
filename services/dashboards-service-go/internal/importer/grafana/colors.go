package grafana

import (
	"math"
	"strconv"
	"strings"
)

// namedTokens maps Grafana's named colours to the console's theme tokens.
// Grafana names a hue with shades (super-light-, light-, semi-dark-, dark-);
// the hue alone decides the token.
var namedTokens = map[string]string{
	"green": "state-ok", "red": "state-crit", "orange": "state-warn", "yellow": "state-warn",
	"blue": "state-info", "purple": "series-5",
	"text": "neutral", "transparent": "neutral", "white": "neutral", "black": "neutral",
}

// Token turns a Grafana colour (a name, #rgb/#rrggbb or rgb()/rgba()) into a
// theme token. exact is false when the token is the nearest match of a fixed
// colour; the caller keeps the original value next to it.
func Token(c string) (token string, exact bool) {
	s := strings.ToLower(strings.TrimSpace(c))
	if s == "" {
		return "", true
	}
	base := s
	for _, p := range []string{"super-light-", "light-", "semi-dark-", "dark-"} {
		base = strings.TrimPrefix(base, p)
	}
	if t, ok := namedTokens[base]; ok {
		return t, base == s
	}
	r, g, b, ok := parseRGB(s)
	if !ok {
		return "neutral", false
	}
	return byHue(r, g, b), false
}

func parseRGB(s string) (r, g, b float64, ok bool) {
	switch {
	case strings.HasPrefix(s, "#"):
		h := s[1:]
		if len(h) == 3 {
			h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
		}
		if len(h) != 6 && len(h) != 8 {
			return 0, 0, 0, false
		}
		v, err := strconv.ParseUint(h[:6], 16, 32)
		if err != nil {
			return 0, 0, 0, false
		}
		return float64(v >> 16 & 0xff), float64(v >> 8 & 0xff), float64(v & 0xff), true
	case strings.HasPrefix(s, "rgb"):
		open, close := strings.IndexByte(s, '('), strings.IndexByte(s, ')')
		if open < 0 || close < open {
			return 0, 0, 0, false
		}
		parts := strings.Split(s[open+1:close], ",")
		if len(parts) < 3 {
			return 0, 0, 0, false
		}
		var c [3]float64
		for i := 0; i < 3; i++ {
			v, err := strconv.ParseFloat(strings.TrimSpace(parts[i]), 64)
			if err != nil {
				return 0, 0, 0, false
			}
			c[i] = v
		}
		return c[0], c[1], c[2], true
	}
	return 0, 0, 0, false
}

// byHue picks a token from the colour's hue; greys (low saturation) are neutral.
func byHue(r, g, b float64) string {
	r, g, b = r/255, g/255, b/255
	maxc, minc := math.Max(r, math.Max(g, b)), math.Min(r, math.Min(g, b))
	if maxc-minc < 0.12 {
		return "neutral"
	}
	var h float64
	switch maxc {
	case r:
		h = math.Mod((g-b)/(maxc-minc), 6)
	case g:
		h = (b-r)/(maxc-minc) + 2
	default:
		h = (r-g)/(maxc-minc) + 4
	}
	h *= 60
	if h < 0 {
		h += 360
	}
	switch {
	case h < 20 || h >= 340:
		return "state-crit"
	case h < 65:
		return "state-warn"
	case h < 165:
		return "state-ok"
	case h < 260:
		return "state-info"
	default:
		return "series-5"
	}
}
