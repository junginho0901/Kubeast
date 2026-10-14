// Package googlegroups reads a user's Google Workspace groups through the Admin
// SDK Directory API (groups.list with userKey). Google's ID token carries no
// groups, so the OIDC login asks here instead.
//
// The service account needs the Workspace admin role Groups Reader; no
// domain-wide delegation. Without delegation the request must name the domain:
// a service account has no "my_customer", so userKey alone answers 404
// "Domain not found".
package googlegroups

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const (
	Scope       = "https://www.googleapis.com/auth/admin.directory.group.readonly"
	defaultBase = "https://admin.googleapis.com"
	maxPages    = 20
)

type Client struct {
	http   *http.Client
	base   string
	domain string
}

// New reads a Google credential file — external_account (Workload Identity
// Federation, no key) or a service_account key; other types are refused.
func New(credentialsFile, domain string) (*Client, error) {
	data, err := os.ReadFile(credentialsFile)
	if err != nil {
		return nil, fmt.Errorf("google credentials: %w", err)
	}
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("google credentials: %w", err)
	}
	t := google.CredentialsType(head.Type)
	if t != google.ExternalAccount && t != google.ServiceAccount {
		return nil, fmt.Errorf("google credentials type %q: want external_account or service_account", head.Type)
	}
	creds, err := google.CredentialsFromJSONWithType(context.Background(), data, t, Scope)
	if err != nil {
		return nil, fmt.Errorf("google credentials: %w", err)
	}
	return &Client{http: oauth2.NewClient(context.Background(), creds.TokenSource), base: defaultBase, domain: domain}, nil
}

// Groups returns the email addresses (lower case) of the groups the user is a
// direct member of.
func (c *Client) Groups(ctx context.Context, email string) ([]string, error) {
	domain := c.domain
	if domain == "" {
		if i := strings.LastIndex(email, "@"); i >= 0 {
			domain = email[i+1:]
		}
	}
	var out []string
	page := ""
	for n := 0; n < maxPages; n++ {
		q := url.Values{"userKey": {email}, "domain": {domain}, "maxResults": {"200"}}
		if page != "" {
			q.Set("pageToken", page)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/admin/directory/v1/groups?"+q.Encode(), nil)
		if err != nil {
			return nil, err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		var body struct {
			Groups []struct {
				Email string `json:"email"`
			} `json:"groups"`
			NextPageToken string `json:"nextPageToken"`
			Error         *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			msg := http.StatusText(resp.StatusCode)
			if body.Error != nil && body.Error.Message != "" {
				msg = body.Error.Message
			}
			return nil, fmt.Errorf("directory API %d: %s", resp.StatusCode, msg)
		}
		if err != nil {
			return nil, fmt.Errorf("directory API: %w", err)
		}
		for _, g := range body.Groups {
			out = append(out, strings.ToLower(g.Email))
		}
		if body.NextPageToken == "" {
			break
		}
		page = body.NextPageToken
	}
	return out, nil
}
