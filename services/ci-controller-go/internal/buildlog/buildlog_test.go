package buildlog

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// cutAll writes in through one Cut in the given chunk sizes (cycled).
func cutAll(t *testing.T, b *Budget, in []byte, chunks ...int) []byte {
	t.Helper()
	var out bytes.Buffer
	c := b.Step(&out)
	for i := 0; len(in) > 0; i++ {
		n := len(in)
		if len(chunks) > 0 {
			n = min(n, chunks[i%len(chunks)])
		}
		if k, err := c.Write(in[:n]); err != nil || k != n {
			t.Fatalf("write: %d %v", k, err)
		}
		in = in[n:]
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

var noteRe = regexp.MustCompile(`\[kubeast: ([0-9]+) bytes of this step were not kept \(build log limit\)\]\n`)

// split takes the cut log of in apart: head, the dropped count and tail.
// The note starts a line, after a line break of its own when the head did
// not end with one.
func split(t *testing.T, in, out []byte) (head []byte, dropped int, tail []byte, cut bool) {
	t.Helper()
	loc := noteRe.FindSubmatchIndex(out)
	if loc == nil {
		return out, 0, nil, false
	}
	fmt.Sscan(string(out[loc[2]:loc[3]]), &dropped)
	head = out[:loc[0]]
	if !bytes.HasPrefix(in, head) {
		if !bytes.HasSuffix(head, []byte("\n")) {
			t.Fatalf("the note does not start a line: %q", out[max(0, loc[0]-20):loc[1]])
		}
		head = head[:len(head)-1]
	}
	return head, dropped, out[loc[1]:], true
}

func TestUnderTheLimitPassesThrough(t *testing.T) {
	in := []byte("step one\nstep two\n한글 줄\n")
	b := NewBudget(Limit{MaxBytes: 4096, Tail: 100})
	if out := cutAll(t, b, in, 3); !bytes.Equal(out, in) {
		t.Fatalf("got %q", out)
	}
	// What is left of the budget passes the next step whole too.
	in2 := bytes.Repeat([]byte("x"), 4096-len(in))
	if out := cutAll(t, b, in2); !bytes.Equal(out, in2) {
		t.Fatalf("second step changed (%d bytes)", len(out))
	}
}

func TestCutKeepsHeadAndTailAtLines(t *testing.T) {
	var in bytes.Buffer
	for i := range 2000 {
		fmt.Fprintf(&in, "line %04d of the build\n", i)
	}
	in.WriteString("error: the last line\n")
	b := NewBudget(Limit{MaxBytes: 5000, Tail: 1000})
	out := cutAll(t, b, in.Bytes(), 4096)
	head, dropped, tail, cut := split(t, in.Bytes(), out)
	if !cut {
		t.Fatal("no note")
	}
	if !bytes.HasPrefix(in.Bytes(), head) || !bytes.HasSuffix(head, []byte("\n")) || len(head) > 5000 || len(head) < 4900 {
		t.Errorf("head: %d bytes, ends %q", len(head), head[max(0, len(head)-10):])
	}
	if !bytes.HasSuffix(in.Bytes(), tail) || !bytes.HasSuffix(tail, []byte("error: the last line\n")) || len(tail) > 1000 || len(tail) < 950 {
		t.Errorf("tail: %d bytes, starts %q", len(tail), tail[:min(30, len(tail))])
	}
	if !bytes.HasPrefix(tail, []byte("line ")) {
		t.Errorf("tail does not start at a line: %q", tail[:20])
	}
	if len(head)+dropped+len(tail) != in.Len() {
		t.Errorf("head %d + dropped %d + tail %d != %d", len(head), dropped, len(tail), in.Len())
	}
}

// TestCutDoesNotDependOnChunks: the same log written in any pieces is kept
// the same, and never splits a UTF-8 character, with or without line breaks.
func TestCutDoesNotDependOnChunks(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	words := []string{"가나다", "é", "x", "🙂🙂", "abc ", "\n", "로그", "\n\n"}
	for round := range 300 {
		var in bytes.Buffer
		for size := r.IntN(20000) + 1; in.Len() < size; {
			in.WriteString(words[r.IntN(len(words))])
		}
		if round%3 == 0 { // no line breaks at all
			in = *bytes.NewBuffer(bytes.ReplaceAll(in.Bytes(), []byte("\n"), []byte("~")))
		}
		lim := Limit{MaxBytes: int64(r.IntN(8000) + 1), Tail: r.IntN(3000)}
		whole := cutAll(t, NewBudget(lim), in.Bytes())
		chunks := []int{r.IntN(50) + 1, r.IntN(5000) + 1, 1}
		if pieces := cutAll(t, NewBudget(lim), in.Bytes(), chunks...); !bytes.Equal(pieces, whole) {
			t.Fatalf("round %d %+v chunks %v: differs from one write", round, lim, chunks)
		}
		head, dropped, tail, cut := split(t, in.Bytes(), whole)
		if !utf8.Valid(head) || !utf8.Valid(tail) {
			t.Fatalf("round %d: a character was split", round)
		}
		if !bytes.HasPrefix(in.Bytes(), head) || !bytes.HasSuffix(in.Bytes(), tail) || len(head)+dropped+len(tail) != in.Len() {
			t.Fatalf("round %d: head %d dropped %d tail %d of %d", round, len(head), dropped, len(tail), in.Len())
		}
		if cut && (int64(len(head)) > lim.MaxBytes || len(tail) > lim.Tail) {
			t.Fatalf("round %d %+v: head %d tail %d over the limit", round, lim, len(head), len(tail))
		}
		if !cut && !bytes.Equal(whole, in.Bytes()) {
			t.Fatalf("round %d: changed without a note", round)
		}
		if cut && dropped == 0 {
			t.Fatalf("round %d: a note though nothing was dropped", round)
		}
	}
}

// TestBudgetIsPerBuild: later steps share what earlier ones left, and every
// step's end is kept even when nothing is left.
func TestBudgetIsPerBuild(t *testing.T) {
	b := NewBudget(Limit{MaxBytes: 10000, Tail: 300})
	step := func(name string, lines int) []byte {
		var in bytes.Buffer
		for i := range lines {
			fmt.Fprintf(&in, "%s %05d\n", name, i)
		}
		fmt.Fprintf(&in, "%s done\n", name)
		return in.Bytes()
	}
	s1 := step("checkout", 100) // ~1.5 KB, whole
	s2 := step("build", 2000)   // takes the rest of the budget
	s3 := step("scan", 2000)    // nothing left: only its end
	if out := cutAll(t, b, s1); !bytes.Equal(out, s1) {
		t.Fatal("first step cut")
	}
	head2, _, tail2, cut2 := split(t, s2, cutAll(t, b, s2))
	head3, _, tail3, cut3 := split(t, s3, cutAll(t, b, s3))
	if !cut2 || !cut3 || len(head3) != 0 {
		t.Fatalf("cut %v %v, third head %d bytes", cut2, cut3, len(head3))
	}
	if len(s1)+len(head2) > 10000 || len(s1)+len(head2) < 9800 {
		t.Errorf("heads use %d of 10000", len(s1)+len(head2))
	}
	for _, tl := range [][]byte{tail2, tail3} {
		if !bytes.HasSuffix(tl, []byte(" done\n")) || len(tl) > 300 {
			t.Errorf("tail %q", tl)
		}
	}
}

func TestNoTail(t *testing.T) {
	in := bytes.Repeat([]byte("abcdefghi\n"), 1000)
	head, dropped, tail, cut := split(t, in, cutAll(t, NewBudget(Limit{MaxBytes: 4096, Tail: 0}), in))
	if !cut || len(tail) != 0 || len(head)+dropped != len(in) {
		t.Fatalf("cut %v head %d dropped %d tail %d", cut, len(head), dropped, len(tail))
	}
}

// TestCutMemory: a step far above the limit costs about two tails.
func TestCutMemory(t *testing.T) {
	b := NewBudget(Limit{MaxBytes: 4096, Tail: 64 << 10})
	c := b.Step(io.Discard)
	chunk := bytes.Repeat([]byte("0123456789abcde\n"), 2048) // 32 KiB
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for range 2048 { // 64 MiB
		c.Write(chunk)
	}
	c.Close()
	runtime.ReadMemStats(&after)
	if n := after.TotalAlloc - before.TotalAlloc; n > 4*(64<<10) {
		t.Fatalf("64 MiB through a 64 KiB tail allocated %d bytes", n)
	}
}

func TestLimitValidate(t *testing.T) {
	for _, l := range []Limit{{4095, 0}, {4096, -1}, {4096, 4097}, {0, 0}} {
		if l.Validate() == nil {
			t.Errorf("%+v accepted", l)
		}
	}
	for _, l := range []Limit{DefaultLimit(), {4096, 0}, {4096, 4096}} {
		if err := l.Validate(); err != nil {
			t.Errorf("%+v: %v", l, err)
		}
	}
}

type failWriter struct{ after int }

func (f *failWriter) Write(p []byte) (int, error) {
	if f.after <= 0 {
		return 0, errors.New("disk full")
	}
	f.after--
	return len(p), nil
}

func TestCutReportsWriterErrors(t *testing.T) {
	c := NewBudget(DefaultLimit()).Step(&failWriter{after: 1})
	if _, err := c.Write([]byte("a\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte("b\n")); err == nil {
		t.Fatal("the writer's error was lost")
	}
	if err := c.Close(); err == nil {
		t.Fatal("Close after a failed write reported nothing")
	}
	if _, err := c.Write([]byte("c")); err == nil {
		t.Fatal("write after Close")
	}
}

func newFile(t *testing.T) (*File, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "logs")
	f, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	return f, dir
}

func readAll(t *testing.T, s Store, build, step string) []byte {
	t.Helper()
	r, err := s.Open(context.Background(), build, step)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFileSaveAndRead(t *testing.T) {
	f, dir := newFile(t)
	ctx := context.Background()
	b := NewBudget(Limit{MaxBytes: 64 << 10, Tail: 4 << 10})
	small := []byte("cloning\ncloned\n")
	var big bytes.Buffer
	for i := range 20000 {
		fmt.Fprintf(&big, "compiling package %d\n", i)
	}
	big.WriteString("error: build failed\n")
	r1, err := Save(ctx, f, b, "b-0001", "checkout", bytes.NewReader(small))
	if err != nil || r1 != (Result{Read: int64(len(small)), Kept: int64(len(small))}) {
		t.Fatalf("save checkout: %+v %v", r1, err)
	}
	r2, err := Save(ctx, f, b, "b-0001", "build", bytes.NewReader(big.Bytes()))
	if err != nil || r2.Read != int64(big.Len()) || r2.Kept >= r2.Read {
		t.Fatalf("save build: %+v %v", r2, err)
	}
	if got := readAll(t, f, "b-0001", "checkout"); !bytes.Equal(got, small) {
		t.Errorf("checkout read back %q", got)
	}
	want := cutAll(t, NewBudget(Limit{MaxBytes: 64<<10 - int64(len(small)), Tail: 4 << 10}), big.Bytes())
	got := readAll(t, f, "b-0001", "build")
	if !bytes.Equal(got, want) || !bytes.HasSuffix(got, []byte("error: build failed\n")) {
		t.Errorf("build read back %d bytes, want %d", len(got), len(want))
	}

	// The real gzip reads what the store wrote.
	path := filepath.Join(dir, "b-0001", "build.log.gz")
	if out, err := exec.Command("gzip", "-dc", path).Output(); err != nil || !bytes.Equal(out, got) {
		t.Errorf("gzip -dc: %v (%d bytes)", err, len(out))
	}
	st, err := os.Stat(path)
	if err != nil || st.Size() >= int64(len(got))/3 || st.Mode().Perm() != 0o640 {
		t.Errorf("stored file: %v %v", st.Size(), st.Mode())
	}
	if dst, _ := os.Stat(filepath.Join(dir, "b-0001")); dst.Mode().Perm() != 0o750 {
		t.Errorf("build folder mode %v", dst.Mode())
	}
	steps, err := f.Steps(ctx, "b-0001")
	if err != nil || len(steps) != 2 || steps[0].Name != "build" || steps[1].Name != "checkout" || steps[0].Size != st.Size() {
		t.Errorf("steps %+v %v", steps, err)
	}
}

// TestFileNothingHalfWritten: until Close a reader sees nothing; Abort,
// a failed read and a cancelled save leave nothing.
func TestFileNothingHalfWritten(t *testing.T) {
	f, dir := newFile(t)
	ctx := context.Background()
	w, err := f.Create(ctx, "b-2", "build")
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte("half"))
	if _, err := f.Open(ctx, "b-2", "build"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("open while writing: %v", err)
	}
	if steps, err := f.Steps(ctx, "b-2"); err != nil || len(steps) != 0 {
		t.Fatalf("steps while writing: %+v %v", steps, err)
	}
	if err := w.Abort(); err != nil {
		t.Fatal(err)
	}
	if left, _ := os.ReadDir(filepath.Join(dir, "b-2")); len(left) != 0 {
		t.Fatalf("abort left %v", left)
	}

	failing := io.MultiReader(strings.NewReader("some\n"), errReader{})
	if _, err := Save(ctx, f, NewBudget(DefaultLimit()), "b-2", "scan", failing); err == nil {
		t.Fatal("a failed read was saved")
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := Save(cctx, f, NewBudget(DefaultLimit()), "b-2", "test", strings.NewReader("x")); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled save: %v", err)
	}
	if left, _ := os.ReadDir(filepath.Join(dir, "b-2")); len(left) != 0 {
		t.Fatalf("failed saves left %v", left)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func TestFileNames(t *testing.T) {
	f, dir := newFile(t)
	ctx := context.Background()
	for _, n := range [][2]string{{"../x", "s"}, {"b", "../../etc/passwd"}, {"B", "s"}, {"", "s"}, {"b", ""}, {"b", "s/t"}, {strings.Repeat("a", 64), "s"}, {"b", ".hidden"}, {"b-", "s"}} {
		if _, err := f.Create(ctx, n[0], n[1]); err == nil {
			t.Errorf("create %q accepted", n)
		}
		if _, err := f.Open(ctx, n[0], n[1]); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("open %q: %v", n, err)
		}
	}
	if _, err := f.Steps(ctx, "../logs"); err == nil {
		t.Error("steps of a path accepted")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("refused names made %v", entries)
	}
	if _, err := f.Open(ctx, "b", "s"); !errors.Is(err, ErrNotFound) {
		t.Errorf("open of a missing log: %v", err)
	}
	if _, err := f.Steps(ctx, "b"); !errors.Is(err, ErrNotFound) {
		t.Errorf("steps of a missing build: %v", err)
	}
}

func TestFileDeleteBefore(t *testing.T) {
	f, dir := newFile(t)
	ctx := context.Background()
	now := time.Now()
	save := func(build, step string, age time.Duration) {
		if _, err := Save(ctx, f, NewBudget(DefaultLimit()), build, step, strings.NewReader("log\n")); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, build, step+suffix)
		if err := os.Chtimes(p, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	save("old", "build", 100*24*time.Hour)
	save("old", "scan", 95*24*time.Hour)
	save("mixed", "build", time.Hour)
	save("mixed", "scan", 100*24*time.Hour)
	save("new", "build", time.Hour)
	// A save that crashed long ago in an old build, and one under way now.
	stale := filepath.Join(dir, "crashed")
	os.MkdirAll(stale, 0o750)
	os.WriteFile(filepath.Join(stale, ".build.log.gz.123"), []byte("x"), 0o640)
	os.Chtimes(filepath.Join(stale, ".build.log.gz.123"), now.Add(-200*24*time.Hour), now.Add(-200*24*time.Hour))
	w, err := f.Create(ctx, "running", "build")
	if err != nil {
		t.Fatal(err)
	}
	defer w.Abort()
	os.MkdirAll(filepath.Join(dir, "Not-A-Build"), 0o750)

	gone, err := f.DeleteBefore(ctx, now.Add(-90*24*time.Hour))
	if err != nil || strings.Join(gone, ",") != "crashed,old" {
		t.Fatalf("deleted %q %v", gone, err)
	}
	for _, kept := range []string{"mixed", "new", "running", "Not-A-Build"} {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Errorf("%s: %v", kept, err)
		}
	}
}

// TestFileConcurrentSaves runs the steps of several builds at once; run
// with -race.
func TestFileConcurrentSaves(t *testing.T) {
	f, _ := newFile(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			build := fmt.Sprintf("b-%d", i)
			b := NewBudget(Limit{MaxBytes: 8192, Tail: 1024})
			for _, step := range []string{"checkout", "build", "scan"} {
				in := bytes.Repeat([]byte(step+" line\n"), 1000)
				if _, err := Save(ctx, f, b, build, step, bytes.NewReader(in)); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	for i := range 8 {
		steps, err := f.Steps(ctx, fmt.Sprintf("b-%d", i))
		if err != nil || len(steps) != 3 {
			t.Errorf("b-%d steps %+v %v", i, steps, err)
		}
	}
}

func TestSaveAllocs(t *testing.T) {
	f, _ := newFile(t)
	in := bytes.Repeat([]byte("a build log line of a usual length\n"), 30000) // ~1 MiB
	ctx := context.Background()
	n := testing.AllocsPerRun(5, func() {
		if _, err := Save(ctx, f, NewBudget(DefaultLimit()), "b-alloc", "build", bytes.NewReader(in)); err != nil {
			t.Fatal(err)
		}
	})
	t.Logf("Save of a 1 MiB step: %.0f allocations", n)
	if n > 60 {
		t.Errorf("Save allocated %.0f times, above 60", n)
	}
}
