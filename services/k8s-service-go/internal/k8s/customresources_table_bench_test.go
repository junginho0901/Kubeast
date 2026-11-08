package k8s

import (
	"encoding/json"
	"fmt"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// What k8s-service spends on one read of a CRD's rows, the API server's part aside: why a table past useWatchChanges'
// LIVE_ROWS_MAX is not read again by itself.
func BenchmarkCustomResourceRowsToJSON(b *testing.B) {
	for _, rows := range []int{500, 2000, 10000, 50000} {
		b.Run(fmt.Sprintf("%d rows", rows), func(b *testing.B) {
			table := &metav1.Table{ColumnDefinitions: []metav1.TableColumnDefinition{
				{Name: "Name", Type: "string", Format: "name"},
				{Name: "Size", Type: "string"},
				{Name: "Age", Type: "date"},
			}}
			for i := 0; i < rows; i++ {
				table.Rows = append(table.Rows, metav1.TableRow{
					Cells: []interface{}{fmt.Sprintf("w-%d", i), "large", "2026-11-01T00:00:00Z"},
					Object: runtime.RawExtension{Raw: []byte(fmt.Sprintf(`{"apiVersion":"numbers.kubeast.io/v1","kind":"Widget",`+
						`"metadata":{"name":"w-%d","namespace":"shop","generation":2,"creationTimestamp":"2026-11-01T00:00:00Z","labels":{"app":"web","team":"a"}},`+
						`"spec":{"size":"large","replicas":3,"owner":"team-a"},"status":{"lastSeen":"2026-11-02T01:00:00Z","conditions":[{"type":"Ready","status":"True"}]}}`, i))},
				})
			}
			b.ReportAllocs()
			b.ResetTimer()
			for n := 0; n < b.N; n++ {
				body, err := json.Marshal(customResourceRows(table, "numbers.kubeast.io", "v1"))
				if err != nil {
					b.Fatal(err)
				}
				b.SetBytes(int64(len(body)))
			}
		})
	}
}
