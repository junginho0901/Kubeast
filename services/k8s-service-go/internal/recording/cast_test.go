package recording

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeClock() func() time.Time {
	t := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	return func() time.Time { t = t.Add(250 * time.Millisecond); return t }
}

func readCast(t *testing.T, path string) (map[string]any, [][]any) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	var header map[string]any
	var events [][]any
	for sc.Scan() {
		if header == nil {
			if err := json.Unmarshal(sc.Bytes(), &header); err != nil {
				t.Fatalf("header: %v", err)
			}
			continue
		}
		var ev []any
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("event %q: %v", sc.Text(), err)
		}
		events = append(events, ev)
	}
	return header, events
}

func TestSessionWritesAsciicastV2(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r.cast")
	s, err := newSession("r1", path, 120, 30, "exec default/nginx", 1<<20, fakeClock())
	if err != nil {
		t.Fatal(err)
	}
	s.Output([]byte("$ ls\r\n"))
	s.Output([]byte("a.txt\r\n"))
	closed := false
	s.onClose = func(*Session) { closed = true }
	s.Close()
	s.Close() // idempotent
	if !closed {
		t.Fatal("onClose not called")
	}
	h, ev := readCast(t, path)
	if h["version"].(float64) != 2 || h["width"].(float64) != 120 || h["height"].(float64) != 30 {
		t.Fatalf("header %v", h)
	}
	if len(ev) != 2 || ev[0][1] != "o" || ev[0][2] != "$ ls\r\n" || ev[1][2] != "a.txt\r\n" {
		t.Fatalf("events %v", ev)
	}
	if ev[1][0].(float64) <= ev[0][0].(float64) {
		t.Fatalf("time must increase: %v", ev)
	}
	s.Output([]byte("after close")) // ignored, no panic
}

func TestSessionKeepsSplitUTF8Together(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r.cast")
	s, _ := newSession("r1", path, 0, 0, "", 1<<20, fakeClock())
	word := []byte("한글") // 6 bytes
	s.Output(word[:4])   // "한" + 1 byte of "글"
	s.Output(word[4:])
	s.Close()
	h, ev := readCast(t, path)
	if h["width"].(float64) != 80 || h["height"].(float64) != 24 {
		t.Fatalf("default size %v", h)
	}
	var got strings.Builder
	for _, e := range ev {
		got.WriteString(e[2].(string))
	}
	if got.String() != "한글" || strings.ContainsRune(got.String(), '\uFFFD') {
		t.Fatalf("got %q", got.String())
	}
}

func TestSessionStopsAtTheSizeCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r.cast")
	s, _ := newSession("r1", path, 80, 24, "", 300, fakeClock())
	for i := 0; i < 20; i++ {
		s.Output([]byte(strings.Repeat("x", 40)))
	}
	if !s.Truncated() {
		t.Fatal("want truncated")
	}
	s.Close()
	st, _ := os.Stat(path)
	if st.Size() > 300+200 {
		t.Fatalf("file %d bytes runs far past the cap", st.Size())
	}
	_, ev := readCast(t, path)
	last := ev[len(ev)-1]
	if last[1] != "m" || !strings.Contains(last[2].(string), "size limit") {
		t.Fatalf("want a marker last, got %v", last)
	}
}

func TestTranscript(t *testing.T) {
	cast := strings.Join([]string{
		`{"version":2,"width":80,"height":24}`,
		`[0.1,"o","\u001b[1;32mroot@nginx\u001b[0m:/# "]`,
		`[0.5,"o","ech\bho hi\r\n"]`,
		`[0.6,"o","hi\r\n\u001b]0;title\u0007"]`,
		`[0.7,"o","50%\r100%\r\n"]`,
		`[0.8,"m","kubeast: size limit reached; recording stopped"]`,
	}, "\n")
	got := Transcript([]byte(cast))
	want := "root@nginx:/# echo hi\nhi\n100%\n\n[kubeast: size limit reached; recording stopped]\n"
	if got != want {
		t.Fatalf("transcript:\n%q\nwant\n%q", got, want)
	}
}

func TestConfigDefaultsAndValidation(t *testing.T) {
	t.Setenv("SESSION_RECORDING_ENABLED", "true")
	c := LoadConfig()
	if c.Storage != "database" || c.ChunkSeconds != 30 || !c.Required {
		t.Fatalf("defaults %+v", c)
	}
	if c.effectiveMaxBytes() != DatabaseMaxBytes {
		t.Fatalf("database cap not applied: %d", c.effectiveMaxBytes())
	}
	t.Setenv("SESSION_RECORDING_S3_BUCKET", "rec")
	if c := LoadConfig(); c.Storage != "s3" {
		t.Fatalf("a bucket picks s3, got %q", c.Storage)
	}
	bad := []Config{
		{Enabled: true, ChunkSeconds: 0, MaxBytes: 1 << 20, SpoolDir: "/x", Storage: "file", FileDir: "/y"},
		{Enabled: true, ChunkSeconds: 30, MaxBytes: 100, SpoolDir: "/x", Storage: "file", FileDir: "/y"},
		{Enabled: true, ChunkSeconds: 30, MaxBytes: 1 << 20, SpoolDir: "/x", Storage: "s3"},
		{Enabled: true, ChunkSeconds: 30, MaxBytes: 1 << 20, SpoolDir: "/x", Storage: "ftp"},
	}
	for _, b := range bad {
		if b.Validate() == nil {
			t.Errorf("should be refused: %+v", b)
		}
	}
	if (Config{Enabled: false}).Validate() != nil {
		t.Fatal("off needs no settings")
	}
}

func TestS3StoreRefusesAnUnreadableSecret(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root reads any file")
	}
	dir := t.TempDir()
	for _, k := range []string{"accessKeyId", "secretAccessKey"} {
		if err := os.WriteFile(filepath.Join(dir, k), []byte("x"), 0o000); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := newS3Store(S3Config{Bucket: "b", Endpoint: "http://127.0.0.1:1"}, dir); err == nil || !strings.Contains(err.Error(), "accessKeyId") {
		t.Fatalf("want an error naming the unreadable key, got %v", err)
	}
	// no Secret files at all → the default chain (IRSA), not an error
	if _, err := newS3Store(S3Config{Bucket: "b", Endpoint: "http://127.0.0.1:1"}, t.TempDir()); err != nil {
		t.Fatalf("empty secret dir: %v", err)
	}
}
