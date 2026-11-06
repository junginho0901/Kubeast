package cache

// globMatch follows Redis SCAN MATCH (* ? [set] \), so a pattern means the same with Redis off; path.Match's * stops at a slash.
func globMatch(pattern, key string) bool {
	p, k := 0, 0
	afterStar, starKey := -1, 0
	for k < len(key) {
		if p < len(pattern) {
			if pattern[p] == '*' {
				p++
				afterStar, starKey = p, k
				continue
			}
			if next, ok := matchByte(pattern, p, key[k]); ok {
				p, k = next, k+1
				continue
			}
		}
		if afterStar < 0 {
			return false
		}
		// Only the last * takes one more byte: the walk stays len(pattern)*len(key) however many stars there are.
		starKey++
		p, k = afterStar, starKey
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}

// matchByte matches b against the pattern element at p and returns where the next element starts.
func matchByte(pattern string, p int, b byte) (int, bool) {
	switch pattern[p] {
	case '?':
		return p + 1, true
	case '[':
		return matchSet(pattern, p+1, b)
	case '\\':
		if p+1 < len(pattern) {
			p++
		}
	}
	return p + 1, pattern[p] == b
}

// matchSet matches b against the set whose first element is at p. An unclosed set ends with the pattern, as in Redis.
func matchSet(pattern string, p int, b byte) (int, bool) {
	negate := p < len(pattern) && pattern[p] == '^'
	if negate {
		p++
	}
	found := false
	for p < len(pattern) && pattern[p] != ']' {
		switch {
		case pattern[p] == '\\' && p+1 < len(pattern):
			p++
			found = found || pattern[p] == b
		case p+2 < len(pattern) && pattern[p+1] == '-':
			lo, hi := pattern[p], pattern[p+2]
			if lo > hi {
				lo, hi = hi, lo
			}
			found = found || (lo <= b && b <= hi)
			p += 2
		default:
			found = found || pattern[p] == b
		}
		p++
	}
	if p < len(pattern) {
		p++
	}
	return p, found != negate
}
