package github

import (
	"context"
	"errors"
)

// CloneToken makes a token that can only read one repository's contents,
// for a build's checkout container (design ⓒ §7: no other container sees
// it). GitHub narrows an installation token to the repositories and
// permissions asked for, and never past what the app was granted. The token
// is not cached: each build gets its own, valid for an hour from now.
func (a *App) CloneToken(ctx context.Context, installation int64, repo string) (Token, error) {
	if installation <= 0 {
		return Token{}, errors.New("github: no installation ID")
	}
	_, name, err := splitRepo(repo)
	if err != nil {
		return Token{}, err
	}
	return a.fetchToken(ctx, installation, map[string]any{
		"repositories": []string{name},
		"permissions":  map[string]string{"contents": "read"},
	})
}
