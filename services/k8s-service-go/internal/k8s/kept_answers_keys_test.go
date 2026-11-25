package k8s

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// cacheKeyMakers make a key that says who asked: each holds auth.TokenPayload.CacheIdentity, the identity and the
// namespaces its grant is limited to.
var cacheKeyMakers = map[string]bool{"clusterCacheKey": true, "IdentityCacheKey": true, "listCacheKey": true}

// Every answer put in the shared cache is put under a key one of cacheKeyMakers made. A new place that keeps an answer
// under a key of its own, which another token could ask for, fails here.
func TestEveryKeyOfAnAnswerInTheCacheSaysWhoAsked(t *testing.T) {
	found := 0
	err := filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || filepath.Dir(path) == "../cache" {
			return err
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		for _, decl := range file.Decls {
			made := map[string]bool{}
			ast.Inspect(decl, func(n ast.Node) bool {
				switch n := n.(type) {
				case *ast.AssignStmt:
					for i, right := range n.Rhs {
						if call, ok := right.(*ast.CallExpr); ok && len(n.Lhs) == len(n.Rhs) {
							made[types.ExprString(n.Lhs[i])] = cacheKeyMakers[calledName(call)]
						}
					}
				case *ast.CallExpr:
					set, ok := n.Fun.(*ast.SelectorExpr)
					if !ok || set.Sel.Name != "Set" || len(n.Args) != 4 || !strings.HasSuffix(strings.TrimSuffix(strings.ToLower(types.ExprString(set.X)), "()"), "cache") {
						return true
					}
					found++
					if key := types.ExprString(n.Args[1]); !made[key] {
						t.Errorf("%s: an answer is kept under %s, which none of clusterCacheKey, IdentityCacheKey and listCacheKey made", path, key)
					}
				}
				return true
			})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if found < 9 {
		t.Errorf("%d places that keep an answer in the cache found, want at least 9", found)
	}
}

func calledName(call *ast.CallExpr) string {
	switch fn := call.Fun.(type) {
	case *ast.Ident:
		return fn.Name
	case *ast.SelectorExpr:
		return fn.Sel.Name
	}
	return ""
}
