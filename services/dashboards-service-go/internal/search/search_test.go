package search

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// testdata/grafana-13.3.0-search.json.gz: 42 dashboards made in Grafana 13.3.0
// (titles in many cases and scripts, with wildcard and regex characters, tags,
// three folders one inside another) and what /api/search?type=dash-db answered
// for each text, tag set, folder set and mixes of them.
func TestSearch_AsGrafana(t *testing.T) {
	f, err := os.Open("testdata/grafana-13.3.0-search.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Dashboards []struct {
			UID, Title, Folder, Description string
			Tags                            []string
		}
		Cases []struct {
			Text          string
			Tags, Folders []string
			Want          []string
		}
	}
	if err := json.NewDecoder(z).Decode(&data); err != nil {
		t.Fatal(err)
	}
	var ds []*model.Dashboard
	title := map[string]string{}
	for _, d := range data.Dashboards {
		ds = append(ds, &model.Dashboard{Metadata: model.Metadata{Name: d.UID, Title: d.Title, Description: d.Description, Tags: d.Tags, Folder: d.Folder}})
		title[d.UID] = d.Title
	}
	// A title with a line break is searched across it here (see the package
	// comment and TestSearch_LineBreak), so it is left out of the comparison.
	differs := func(uid string) bool { return strings.Contains(title[uid], "\n") }
	if len(ds) < 40 || len(data.Cases) < 200 {
		t.Fatalf("%d dashboards, %d cases", len(ds), len(data.Cases))
	}
	for _, c := range data.Cases {
		q := Query{Text: c.Text, Tags: c.Tags}
		for _, f := range c.Folders {
			if f == "general" { // Grafana's name for the top level
				f = ""
			}
			q.Folders = append(q.Folders, f)
		}
		var got []string
		for _, d := range Search(ds, q) {
			if !differs(d.Metadata.Name) {
				got = append(got, d.Metadata.Name)
			}
		}
		want := slices.DeleteFunc(slices.Clone(c.Want), differs)
		// Grafana leaves the order of equal titles open: the same dashboards,
		// and the same titles in the same order.
		lower := func(uids []string) []string {
			out := make([]string, len(uids))
			for i, u := range uids {
				out[i] = strings.ToLower(title[u])
			}
			return out
		}
		if !slices.Equal(slices.Sorted(slices.Values(got)), slices.Sorted(slices.Values(want))) || !slices.Equal(lower(got), lower(want)) {
			t.Errorf("Search(%+v)\n got  %v\n want %v", q, got, want)
		}
		for _, d := range ds {
			if Match(d, q) != slices.Contains(got, d.Metadata.Name) && !differs(d.Metadata.Name) {
				t.Errorf("Match(%s, %+v) = %v, Search disagrees", d.Metadata.Name, q, Match(d, q))
			}
		}
	}
}

func TestSearch_EqualTitlesByFolderAndName(t *testing.T) {
	ds := []*model.Dashboard{
		{Metadata: model.Metadata{Name: "c", Title: "Ab", Folder: "f"}},
		{Metadata: model.Metadata{Name: "b", Title: "ab", Folder: "f"}},
		{Metadata: model.Metadata{Name: "a", Title: "AB", Folder: "g"}},
		{Metadata: model.Metadata{Name: "z", Title: "ab"}},
	}
	var got []string
	for _, d := range Search(ds, Query{Text: "ab"}) {
		got = append(got, d.Metadata.Name)
	}
	if want := []string{"z", "b", "c", "a"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// A title with a line break: Grafana 13.3.0 finds "line\nbreak" by "line" or
// "break" only (its whole-title wildcard does not cross a line break); here
// every text in it finds it.
func TestSearch_LineBreak(t *testing.T) {
	d := &model.Dashboard{Metadata: model.Metadata{Title: "Line\nBreak"}}
	for _, text := range []string{"line", "break", "line?break", "line*break", "e\nb", "LINE\nBREAK"} {
		if !Match(d, Query{Text: text}) {
			t.Errorf("%q does not find %q", text, d.Metadata.Title)
		}
	}
	if Match(d, Query{Text: "line break"}) {
		t.Errorf("a space finds a line break")
	}
}

// Grafana 13.3.0 answers "Search failed" to a text too large for its index's
// automaton (5 000 letters, "node" and 100 ?); here it is searched as any other.
func TestSearch_LongText(t *testing.T) {
	long := strings.Repeat("a", 5000)
	d := &model.Dashboard{Metadata: model.Metadata{Title: "x" + long + "y"}}
	for _, q := range []Query{{Text: long}, {Text: "x" + strings.Repeat("?", 5000) + "y"}, {Text: strings.Repeat("*a", 2500)}} {
		if !Match(d, q) {
			t.Errorf("a text of %d characters does not find the title", len(q.Text))
		}
	}
	if Match(d, Query{Text: "node" + strings.Repeat("?", 100)}) {
		t.Errorf("node??… finds a title without node")
	}
}
