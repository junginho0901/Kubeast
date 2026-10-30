package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestMarshalOrdered(t *testing.T) {
	m := map[string]interface{}{"edges": []int{1}, "b": "<x>", "nodes": []int{2}, "a": 1, "namespace": "shop"}
	out, err := marshalOrdered(m, []string{"namespace", "missing"}, []string{"nodes", "edges"})
	if err != nil {
		t.Fatal(err)
	}
	if out != `{"namespace":"shop","a":1,"b":"`+"\\u003cx\\u003e"+`","nodes":[2],"edges":[1]}` {
		t.Fatalf("order: %s", out)
	}
	// the same object as json.Marshal writes, only in another order
	var got, want map[string]interface{}
	plain, _ := json.Marshal(m)
	if json.Unmarshal([]byte(out), &got) != nil || json.Unmarshal(plain, &want) != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("content: %s vs %s", out, plain)
	}
	if _, err := marshalOrdered(map[string]interface{}{"x": make(chan int)}, nil, nil); err == nil {
		t.Fatal("a value json cannot write is an error")
	}
}
