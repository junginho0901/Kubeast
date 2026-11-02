// Package search finds dashboards the way Grafana 13.3.0's dashboard search
// (/api/search with type dash-db) finds them: the text in the title in any
// case, every tag asked for, one of the folders asked for, and the hits in the
// order of their titles in lower case.
//
// The rules are read from Grafana 13.3.0 (the search service and its unified
// search index, bleve v2.5.7) and written anew; the tests hold them to what
// Grafana 13.3.0 answers. Two differ on purpose: a title with a line break is
// searched across it (Grafana's whole-title match stops at a line break, so it
// finds such a title only by a single word), and a long text is searched as
// any other (Grafana fails a text too large for its index's automaton).
package search

import (
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// Query is what a search asks for; an empty field asks nothing.
type Query struct {
	Text    string   // in the title, in any case: * stands for any run of characters, ? for any one
	Tags    []string // every one of them, as written
	Folders []string // one of them ("" is the top level), not their subfolders
}

// Match says whether q finds d.
func Match(d *model.Dashboard, q Query) bool {
	return matchText(strings.ToLower(d.Metadata.Title), q.Text) && hasTags(d.Metadata.Tags, q.Tags) && inFolders(d.Metadata.Folder, q.Folders)
}

// Search is the dashboards q finds, by title in lower case; Grafana leaves the
// order of equal titles open, and here they go by folder and name.
func Search(ds []*model.Dashboard, q Query) []*model.Dashboard {
	type hit struct {
		d     *model.Dashboard
		title string
	}
	var hits []hit
	for _, d := range ds {
		title := strings.ToLower(d.Metadata.Title)
		if matchText(title, q.Text) && hasTags(d.Metadata.Tags, q.Tags) && inFolders(d.Metadata.Folder, q.Folders) {
			hits = append(hits, hit{d, title})
		}
	}
	sort.Slice(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if a.title != b.title {
			return a.title < b.title
		}
		if a.d.Metadata.Folder != b.d.Metadata.Folder {
			return a.d.Metadata.Folder < b.d.Metadata.Folder
		}
		return a.d.Metadata.Name < b.d.Metadata.Name
	})
	out := make([]*model.Dashboard, len(hits))
	for i, h := range hits {
		out[i] = h.d
	}
	return out
}

// matchText is Grafana's title search: the text in lower case as the wildcard
// *text* over the whole title in lower case, * any run of characters, ? any
// one, every other character itself.
func matchText(title, text string) bool {
	if text == "" {
		return true
	}
	t := []rune(title)
	p := []rune("*" + strings.ToLower(text) + "*")
	ti, pi := 0, 0
	star, from := -1, 0 // the last * and where its run began
	for ti < len(t) {
		switch {
		case pi < len(p) && p[pi] == '*':
			star, from = pi, ti
			pi++
		case pi < len(p) && (p[pi] == '?' || p[pi] == t[ti]):
			ti++
			pi++
		case star >= 0: // the last * takes one more character
			from++
			ti, pi = from, star+1
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

func hasTags(have, want []string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			if h == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func inFolders(folder string, folders []string) bool {
	if len(folders) == 0 {
		return true
	}
	for _, f := range folders {
		if f == folder {
			return true
		}
	}
	return false
}
