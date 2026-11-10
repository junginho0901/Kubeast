// What a tool's answer holds in place of a value (services/pkg/redact, k8s-service's Secret mask) is not that value, and
// the assistant never reads the value, whoever asks. A write holding it would store those letters over the real one, so
// it is refused before kubectl, for every caller. ai-service stops the same calls before the approval card
// (app/services/ai/masked_writes.py); both read tests/fixtures/masked_write_cases.json.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const maskedWriteShown = 5

var (
	// A masked value (its name may hold spaces: a key's name, k8s_diff's "new value") and a personal-data address (REDACTION_PII).
	writePlaceholder  = regexp.MustCompile(`(?:<|\\u003[cC])(REDACTED:[^<>"'\\\r\n]*|EMAIL_[0-9]+)(?:>|\\u003[eE])`)
	writeEncodedToken = regexp.MustCompile(`[A-Za-z0-9+/]{16,}={0,2}`)
	// k8s-service's Secret mask means nothing outside a Secret, where three stars may be a value. A SecretList's items
	// without a kind of their own are Secrets to kubectl.
	writeSecretKindYAML = regexp.MustCompile(`(?m)^[ \t]*(?:-[ \t]+)?["']?kind["']?[ \t]*:[ \t]*["']?Secret(?:List)?["']?[ \t]*\r?$`)
	writeSecretKindJSON = regexp.MustCompile(`"kind"\s*:\s*"Secret(?:List)?"`)
	writeMaskYAML       = regexp.MustCompile(`(?m)^[ \t]*(?:-[ \t]+)?["']?[A-Za-z0-9._/\-]+["']?[ \t]*:[ \t]*["']?\*\*\*["']?[ \t]*\r?$`)
	writeMaskJSON       = regexp.MustCompile(`"[A-Za-z0-9._/\-]+"\s*:\s*"\*\*\*"`)
	// base64 of the mask, without and with the quotes an older YAML window saved it with
	writeMaskEncoded = regexp.MustCompile(`(?:^|[\s"':,{\[])(?:Kioq|JyoqKic=|IioqKiI=)(?:$|[\s"',}\]])`)
)

// maskedWriteGate refuses a write tool whose arguments hold what stands for a value.
func maskedWriteGate(tool string, args map[string]interface{}) error {
	if !requiresApproval(tool) {
		return nil
	}
	found := placeholdersInWrite(args)
	if len(found) == 0 {
		return nil
	}
	return wrapBadRequest(maskedWriteRefusal(found))
}

func maskedWriteRefusal(found []string) string {
	shown := found
	if len(shown) > maskedWriteShown {
		shown = shown[:maskedWriteShown]
	}
	return fmt.Sprintf("This write holds %s: a placeholder the assistant reads in place of a value it is never given. "+
		"Saving it would put those letters where the real value is. Nothing was changed. "+
		"To change other fields, call k8s_patch_resource with those fields only, which leaves the rest as it is "+
		"(kubectl apply takes out a key it applied before and a manifest leaves out). "+
		"A new value has to come from the user, in this chat or on the screen.", strings.Join(shown, ", "))
}

// placeholdersInWrite lists what stands for a value in the arguments, in the order found.
func placeholdersInWrite(args map[string]interface{}) []string {
	namesSecret := namesSecrets(argString(args, "resource_type", ""))
	var found []string
	add := func(word string) {
		for _, seen := range found {
			if seen == word {
				return
			}
		}
		found = append(found, word)
	}
	for _, text := range writeArgumentTexts(args) {
		for _, m := range writePlaceholder.FindAllStringSubmatch(text, -1) {
			add("<" + m[1] + ">")
		}
		for _, token := range writeEncodedToken.FindAllString(text, -1) {
			decoded, err := base64.StdEncoding.DecodeString(token)
			if err != nil {
				continue
			}
			for _, m := range writePlaceholder.FindAllStringSubmatch(string(decoded), -1) {
				add("<" + m[1] + ">")
			}
		}
		for _, document := range strings.Split(text, "\n---") {
			if !namesSecret && !writeSecretKindYAML.MatchString(document) && !writeSecretKindJSON.MatchString(document) {
				continue
			}
			if writeMaskYAML.MatchString(document) || writeMaskJSON.MatchString(document) || writeMaskEncoded.MatchString(document) {
				add("***")
			}
		}
	}
	return found
}

// writeArgumentTexts gives each argument as text: a string as it is, anything else as JSON with its letters unescaped.
func writeArgumentTexts(args map[string]interface{}) []string {
	keys := make([]string, 0, len(args))
	for key := range args {
		if key != "resource_type" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var texts []string
	for _, key := range keys {
		value := args[key]
		if text, ok := value.(string); ok {
			texts = append(texts, text)
			continue
		}
		var buf bytes.Buffer
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		if encoder.Encode(value) == nil {
			texts = append(texts, buf.String())
		}
	}
	return texts
}
