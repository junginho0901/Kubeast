package redact

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
)

// numberedKinds are the personal-data rules whose placeholder carries a number (<EMAIL_1>, <PHONE_2>, <RRN_1>, <CARD_1>):
// the same value gets the same number, so the model can tell that two lines name one person without reading who.
var numberedKinds = map[string]string{"email": "EMAIL", "phone": "PHONE", "rrn": "RRN", "card": "CARD"}

// NumberTable is kind → MaskKey of a value → its number. It holds no value.
type NumberTable map[string]map[string]int

// Numbers keeps the numbers of one table across the texts it is given. Text and JSON start a new one for each text;
// ai-service sends the table of a chat answer or an alert investigation with each tool call (ToolCallRequest.Masks) and
// keeps the table that comes back, so one value has one number for the whole answer and none outside it. A new number
// is past every number of its kind in the table, in After and in the texts given so far, so it is never one the model
// already reads for another value.
type Numbers struct {
	// Key is the HMAC key of MaskKey, made by ai-service for one table: a key read outside it says nothing of a value.
	Key   string      `json:"key"`
	Table NumberTable `json:"table,omitempty"`
	// After is, per kind, the highest number the conversation already holds (earlier answers, the page).
	After map[string]int `json:"after,omitempty"`

	// next is, per kind, one past the highest number in Table, worked out when the kind is first numbered.
	next map[string]int
}

// maskKeyChars: 64 bits of the HMAC, enough to tell apart the values of one answer.
const maskKeyChars = 16

// MaskKey is what a table holds for a value: the HMAC-SHA256 of its normal form under key, in hex, cut to 16 characters.
// An address in another case and a number with other separators are the same value. redact.py's mask_key is the same.
func MaskKey(key, kind, value string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(normalForm(kind, value)))
	return hex.EncodeToString(mac.Sum(nil))[:maskKeyChars]
}

func normalForm(kind, value string) string {
	if kind == "email" {
		return strings.ToLower(value)
	}
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] >= '0' && value[i] <= '9' {
			b.WriteByte(value[i])
		}
	}
	return b.String()
}

// number is the value's number in its kind, a new one (one past the highest) the first time.
func (n *Numbers) number(kind, value string) int {
	if n.Table == nil {
		n.Table = NumberTable{}
	}
	byKey := n.Table[kind]
	if byKey == nil {
		byKey = map[string]int{}
		n.Table[kind] = byKey
	}
	key := MaskKey(n.Key, kind, value)
	if got, ok := byKey[key]; ok && got > 0 {
		return got
	}
	if n.next == nil {
		n.next = map[string]int{}
	}
	next, ok := n.next[kind]
	if !ok {
		next = 1
		if after := n.After[kind]; after > 0 && after <= maxHeldNumber {
			next = after + 1
		}
		for _, v := range byKey {
			if v >= next {
				next = v + 1
			}
		}
	}
	byKey[key] = next
	n.next[kind] = next + 1
	return next
}

// maxHeldNumber: a number past this in a text is not counted, so After stays a small number for every reader of it.
const maxHeldNumber = 999999

// heldPlaceholder is a numbered placeholder already in a text, also as JSON writes < and > for HTML.
var heldPlaceholder = regexp.MustCompile(`(?:<|\\u003[cC])(EMAIL|PHONE|RRN|CARD)_([0-9]{1,6})(?:>|\\u003[eE])`)

var kindOfName = map[string]string{"EMAIL": "email", "PHONE": "phone", "RRN": "rrn", "CARD": "card"}

// startAfterHeld raises After past the numbered placeholders s already holds. redact.py: highest_numbers.
func (n *Numbers) startAfterHeld(s string) {
	if !strings.Contains(s, "<") && !strings.Contains(s, "u003") {
		return
	}
	for _, m := range heldPlaceholder.FindAllStringSubmatch(s, -1) {
		if num, err := strconv.Atoi(m[2]); err == nil && num <= maxHeldNumber {
			n.startAfter(kindOfName[m[1]], num)
		}
	}
}

// startAfter makes the next new number of kind past num.
func (n *Numbers) startAfter(kind string, num int) {
	if num <= n.After[kind] {
		return
	}
	if n.After == nil {
		n.After = map[string]int{}
	}
	n.After[kind] = num
	if next, ok := n.next[kind]; ok && next <= num {
		n.next[kind] = num + 1
	}
}

// isNumberedPlaceholder: a value that is already one of these placeholders is not read as a value.
func isNumberedPlaceholder(v string) bool {
	return strings.HasPrefix(v, "<EMAIL") || strings.HasPrefix(v, "<PHONE_") || strings.HasPrefix(v, "<RRN_") || strings.HasPrefix(v, "<CARD_")
}

// placeholder is what a numbered kind writes in place of a value.
func (n *Numbers) placeholder(kind, value string) string {
	return "<" + numberedKinds[kind] + "_" + strconv.Itoa(n.number(kind, value)) + ">"
}

// Copy is the table of the numbered kinds, for the answer to the caller; nil for a nil or empty Numbers.
func (n *Numbers) Copy() NumberTable {
	if n == nil || len(n.Table) == 0 {
		return nil
	}
	out := make(NumberTable, len(n.Table))
	for kind, byKey := range n.Table {
		if _, ok := numberedKinds[kind]; !ok {
			continue
		}
		m := make(map[string]int, len(byKey))
		for k, v := range byKey {
			m[k] = v
		}
		out[kind] = m
	}
	return out
}
