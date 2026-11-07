package helm

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"
)

const maskedPassword = "<REDACTED:password>"

func fakeUser(name string) map[string]interface{} {
	return map[string]interface{}{"name": name, "password": "fake-" + name + "-value"}
}

func shownUser(name string) map[string]interface{} {
	return map[string]interface{}{"name": name, "password": maskedPassword}
}

func threeUsers() map[string]interface{} {
	return map[string]interface{}{"users": []interface{}{fakeUser("first"), fakeUser("second"), fakeUser("third")}}
}

func sentUsers(items ...interface{}) map[string]interface{} {
	return map[string]interface{}{"users": items}
}

// A list item is matched to the item shown with the same text, wherever it now stands, so its value goes with it.
func TestAListItemKeepsItsValueWhereverItMoves(t *testing.T) {
	for _, c := range []struct {
		title   string
		sent    map[string]interface{}
		want    map[string]interface{}
		kept    []string
		changed []string
	}{
		{
			"left as shown",
			sentUsers(shownUser("first"), shownUser("second"), shownUser("third")),
			threeUsers(),
			[]string{"users[0].password", "users[1].password", "users[2].password"},
			nil,
		},
		{
			"the first removed",
			sentUsers(shownUser("second"), shownUser("third")),
			sentUsers(fakeUser("second"), fakeUser("third")),
			[]string{"users[1].password", "users[2].password"},
			[]string{"users[0].password"},
		},
		{
			"the middle removed",
			sentUsers(shownUser("first"), shownUser("third")),
			sentUsers(fakeUser("first"), fakeUser("third")),
			[]string{"users[0].password", "users[2].password"},
			[]string{"users[1].password"},
		},
		{
			"the last removed",
			sentUsers(shownUser("first"), shownUser("second")),
			sentUsers(fakeUser("first"), fakeUser("second")),
			[]string{"users[0].password", "users[1].password"},
			[]string{"users[2].password"},
		},
		{
			"the order reversed",
			sentUsers(shownUser("third"), shownUser("second"), shownUser("first")),
			sentUsers(fakeUser("third"), fakeUser("second"), fakeUser("first")),
			[]string{"users[2].password", "users[1].password", "users[0].password"},
			nil,
		},
		{
			"a new item put in front",
			sentUsers(map[string]interface{}{"name": "new", "password": "fake-new-value"}, shownUser("first"), shownUser("second"), shownUser("third")),
			sentUsers(map[string]interface{}{"name": "new", "password": "fake-new-value"}, fakeUser("first"), fakeUser("second"), fakeUser("third")),
			[]string{"users[0].password", "users[1].password", "users[2].password"},
			nil,
		},
		{
			"an item written over whole",
			sentUsers(map[string]interface{}{"name": "first", "password": "fake-other-value"}, shownUser("second"), shownUser("third")),
			sentUsers(map[string]interface{}{"name": "first", "password": "fake-other-value"}, fakeUser("second"), fakeUser("third")),
			[]string{"users[1].password", "users[2].password"},
			[]string{"users[0].password"},
		},
		{
			"another field of one item edited where it stands",
			sentUsers(shownUser("first"), map[string]interface{}{"name": "second", "role": "admin", "password": maskedPassword}, shownUser("third")),
			sentUsers(fakeUser("first"), map[string]interface{}{"name": "second", "role": "admin", "password": "fake-second-value"}, fakeUser("third")),
			[]string{"users[0].password", "users[1].password", "users[2].password"},
			nil,
		},
		{
			"another field of one item edited and the others swapped around it",
			sentUsers(shownUser("third"), map[string]interface{}{"name": "second", "role": "admin", "password": maskedPassword}, shownUser("first")),
			sentUsers(fakeUser("third"), map[string]interface{}{"name": "second", "role": "admin", "password": "fake-second-value"}, fakeUser("first")),
			[]string{"users[2].password", "users[1].password", "users[0].password"},
			nil,
		},
	} {
		t.Run(c.title, func(t *testing.T) {
			got, kept := keepMaskedValues(c.sent, threeUsers())
			if !reflect.DeepEqual(kept.refused, []string(nil)) {
				t.Fatalf("refused %v", kept.refused)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("the values = %v, want %v", got, c.want)
			}
			if !reflect.DeepEqual(kept.places, c.kept) {
				t.Errorf("kept %v, want %v", kept.places, c.kept)
			}
			if !reflect.DeepEqual(kept.changed, c.changed) {
				t.Errorf("changed %v, want %v", kept.changed, c.changed)
			}
		})
	}
}

// Whatever is removed, moved or added, each value stays with the item it was shown in, and every placeholder shown is
// either kept or named as changed.
func TestListEditsNeverMoveAValueToAnotherItem(t *testing.T) {
	random := rand.New(rand.NewSource(7))
	for run := 0; run < 500; run++ {
		count := 1 + random.Intn(6)
		var realItems, shownItems []interface{}
		for i := 0; i < count; i++ {
			name := fmt.Sprintf("u%d", i)
			realItems = append(realItems, fakeUser(name))
			shownItems = append(shownItems, shownUser(name))
		}
		sentItems := []interface{}{}
		for _, i := range random.Perm(count) {
			if random.Intn(4) > 0 {
				sentItems = append(sentItems, shownItems[i])
			}
		}
		if random.Intn(2) == 0 {
			sentItems = append(sentItems, map[string]interface{}{"name": "plain", "password": "fake-plain-value"})
		}
		got, kept := keepMaskedValues(sentUsers(sentItems...), map[string]interface{}{"users": realItems})
		if len(kept.refused) > 0 {
			t.Fatalf("run %d: refused %v", run, kept.refused)
		}
		outItems, _ := got["users"].([]interface{})
		if len(outItems) != len(sentItems) {
			t.Fatalf("run %d: %d items, want %d", run, len(outItems), len(sentItems))
		}
		for _, item := range outItems {
			m := item.(map[string]interface{})
			if want := "fake-" + m["name"].(string) + "-value"; m["password"] != want {
				t.Fatalf("run %d: item %v holds %v, want %v", run, m["name"], m["password"], want)
			}
		}
		if len(kept.places)+len(kept.changed) != count {
			t.Fatalf("run %d: kept %v and changed %v, want %d together", run, kept.places, kept.changed, count)
		}
		for _, place := range kept.places {
			for _, other := range kept.changed {
				if place == other {
					t.Fatalf("run %d: %s is both kept and changed", run, place)
				}
			}
		}
	}
}

// Items of one text cannot be told apart: all of them stay as they were, or nothing says which value is meant. Only the
// text decides, so a refusal does not say whether the hidden values are the same.
func TestItemsOfOneTextAreKeptTogetherOrRefused(t *testing.T) {
	const shownURL = "postgres://app:" + maskedPassword + "@db.shop/app"
	urls := func(values ...string) map[string]interface{} {
		items := []interface{}{}
		for _, value := range values {
			items = append(items, value)
		}
		return map[string]interface{}{"urls": items}
	}
	different := urls("postgres://app:fake-one@db.shop/app", "postgres://app:fake-two@db.shop/app", "plain-item")
	same := urls("postgres://app:fake-one@db.shop/app", "postgres://app:fake-one@db.shop/app", "plain-item")

	t.Run("left as shown, each keeps its own", func(t *testing.T) {
		got, kept := keepMaskedValues(urls(shownURL, shownURL, "plain-item"), different)
		if len(kept.refused) > 0 || !reflect.DeepEqual(got, different) {
			t.Errorf("refused %v, values %v", kept.refused, got)
		}
		if want := []string{"urls[0]", "urls[1]"}; !reflect.DeepEqual(kept.places, want) {
			t.Errorf("kept %v, want %v", kept.places, want)
		}
	})
	t.Run("moved together past another item, each keeps its own", func(t *testing.T) {
		got, kept := keepMaskedValues(urls("plain-item", shownURL, shownURL), different)
		want := urls("plain-item", "postgres://app:fake-one@db.shop/app", "postgres://app:fake-two@db.shop/app")
		if len(kept.refused) > 0 || !reflect.DeepEqual(got, want) {
			t.Errorf("refused %v, values %v", kept.refused, got)
		}
	})
	t.Run("one of them removed is refused, whether or not the values differ", func(t *testing.T) {
		for _, current := range []map[string]interface{}{different, same} {
			_, kept := keepMaskedValues(urls(shownURL, "plain-item"), current)
			if want := []string{"urls[0]"}; !reflect.DeepEqual(kept.refused, want) {
				t.Errorf("refused %v, want %v", kept.refused, want)
			}
		}
	})
	t.Run("one copied is refused", func(t *testing.T) {
		_, kept := keepMaskedValues(urls(shownURL, shownURL, shownURL), urls("postgres://app:fake-one@db.shop/app", "postgres://app:fake-two@db.shop/app"))
		if want := []string{"urls[0]", "urls[1]", "urls[2]"}; !reflect.DeepEqual(kept.refused, want) {
			t.Errorf("refused %v, want %v", kept.refused, want)
		}
	})
	t.Run("items that hold a field each are told apart by nothing but their text", func(t *testing.T) {
		twins := map[string]interface{}{"users": []interface{}{
			map[string]interface{}{"name": "same", "password": "fake-a-value"},
			map[string]interface{}{"name": "same", "password": "fake-b-value"},
		}}
		_, kept := keepMaskedValues(sentUsers(shownUser("same")), twins)
		if want := []string{"users[0].password"}; !reflect.DeepEqual(kept.refused, want) {
			t.Errorf("refused %v, want %v", kept.refused, want)
		}
	})
}

// An item that matches none shown has no value to take unless it can only be the one it stands in place of.
func TestAnItemMatchingNoneShownIsRefusedWithWhere(t *testing.T) {
	for _, c := range []struct {
		title string
		sent  map[string]interface{}
		want  []string
	}{
		{
			"one edited and another removed",
			sentUsers(map[string]interface{}{"name": "first-renamed", "password": maskedPassword}, shownUser("third")),
			[]string{"users[0].password"},
		},
		{
			"two edited where they stand",
			sentUsers(map[string]interface{}{"name": "first-renamed", "password": maskedPassword}, map[string]interface{}{"name": "second-renamed", "password": maskedPassword}, shownUser("third")),
			[]string{"users[0].password", "users[1].password"},
		},
		{
			"one edited and moved",
			sentUsers(shownUser("first"), shownUser("third"), map[string]interface{}{"name": "second-renamed", "password": maskedPassword}),
			[]string{"users[2].password"},
		},
		{
			"one added holding a placeholder",
			sentUsers(shownUser("first"), shownUser("second"), shownUser("third"), shownUser("fourth")),
			[]string{"users[3].password"},
		},
		{
			"another key's placeholder in an item edited where it stands",
			sentUsers(map[string]interface{}{"name": "first", "password": "<REDACTED:token>"}, shownUser("second"), shownUser("third")),
			[]string{"users[0].password"},
		},
		{
			"a list where none was",
			map[string]interface{}{"others": []interface{}{shownUser("first")}},
			[]string{"others[0].password"},
		},
	} {
		t.Run(c.title, func(t *testing.T) {
			_, kept := keepMaskedValues(c.sent, threeUsers())
			if !reflect.DeepEqual(kept.refused, c.want) {
				t.Errorf("refused %v, want %v", kept.refused, c.want)
			}
		})
	}
}

// The same rule holds in a list inside an item.
func TestAListInsideAnItemIsMatchedTheSameWay(t *testing.T) {
	current := map[string]interface{}{"groups": []interface{}{map[string]interface{}{"members": []interface{}{fakeUser("first"), fakeUser("second")}}}}
	sent := map[string]interface{}{"groups": []interface{}{map[string]interface{}{"members": []interface{}{shownUser("second")}}}}
	got, kept := keepMaskedValues(sent, current)
	want := map[string]interface{}{"groups": []interface{}{map[string]interface{}{"members": []interface{}{fakeUser("second")}}}}
	if len(kept.refused) > 0 || !reflect.DeepEqual(got, want) {
		t.Errorf("refused %v, values %v", kept.refused, got)
	}
	if w := []string{"groups[0].members[1].password"}; !reflect.DeepEqual(kept.places, w) {
		t.Errorf("kept %v, want %v", kept.places, w)
	}
	if w := []string{"groups[0].members[0].password"}; !reflect.DeepEqual(kept.changed, w) {
		t.Errorf("changed %v, want %v", kept.changed, w)
	}
}

// A list with no placeholder in it goes as it was sent.
func TestAListWithoutPlaceholdersGoesAsSent(t *testing.T) {
	current := map[string]interface{}{"hosts": []interface{}{"a.example", "b.example"}}
	sent := map[string]interface{}{"hosts": []interface{}{"b.example", "c.example", "c.example"}}
	got, kept := keepMaskedValues(sent, current)
	if !reflect.DeepEqual(got, sent) || len(kept.refused)+len(kept.places)+len(kept.changed) != 0 {
		t.Errorf("values %v, kept %+v", got, kept)
	}
}

// shownOf is the values text as a caller without reveal reads it, parsed.
func shownOf(t *testing.T, current map[string]interface{}) map[string]interface{} {
	t.Helper()
	text, err := marshalValues(current)
	if err != nil {
		t.Fatal(err)
	}
	var shown map[string]interface{}
	if err := yaml.Unmarshal([]byte(maskText(text)), &shown); err != nil {
		t.Fatal(err)
	}
	return shown
}

// The masks these tests write by hand are the ones the masked text really has.
func TestTheseTestsWriteTheMasksTheTextHas(t *testing.T) {
	shown := shownOf(t, threeUsers())
	want := sentUsers(shownUser("first"), shownUser("second"), shownUser("third"))
	gotJSON, _ := json.Marshal(shown)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("the text shows %s, these tests write %s", gotJSON, wantJSON)
	}
	urls := shownOf(t, map[string]interface{}{"urls": []interface{}{"postgres://app:fake-one@db.shop/app"}})
	if got := urls["urls"].([]interface{})[0].(string); !strings.Contains(got, maskedPassword) {
		t.Errorf("the text shows %s", got)
	}
}
