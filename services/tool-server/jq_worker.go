// k8s_jq_query's program runs in a child of this binary that ends itself past a memory budget and, on Linux, cannot map
// past an address space limit, since one gojq step (a repeated string, an index far past an array's end) can hold
// hundreds of MB that no goroutine can be stopped from taking, and on cgroup v2 an OOM kill takes tool-server with it
// (memory.oom.group); one child runs at a time, and the time limit ends it from here.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime/debug"
	"runtime/metrics"
	"strings"
	"time"

	"github.com/itchyny/gojq"

	"github.com/junginho0901/kubeast/services/pkg/limits"
)

const (
	jqWorkerArg = "--jq-worker"
	// jqMemoryBase is what a program may hold besides its input, which takes jqMemoryPerInputByte for each byte: about a
	// kubectl run's 40 MiB at the default 1 MiB list (two ordinary programs over one ran within 16 MiB).
	jqMemoryBase         = 32 << 20
	jqMemoryPerInputByte = 8
	jqOverMemoryExit     = 3
	jqAnswerMaxBytes     = 4 * jqOutputCap
	// jqAddressRoom is what a run may map past what it has mapped when it starts: a 64 MiB heap arena, since where the
	// heap starts in its first arena is random, and room for the runtime's own maps (measured on Linux, docs/architecture.md).
	jqAddressRoom = 80 << 20
)

// jqTimeout and jqWatchEvery are variables so a test can wait less than the run's 5 s, or leave the heap unwatched.
var (
	jqTimeout    = 5 * time.Second
	jqWatchEvery = 2 * time.Millisecond
)

// jqRuns is one place: the container holds tool-server and the most one run can map, not several of them.
var jqRuns = limits.NewSlots("jq run", 1)

// errBusy is a call that waited for its turn until its time ran out; the caller is asked to ask again (503).
var errBusy = errors.New("tool-server is busy")

type jqRequest struct {
	Expr        string          `json:"expr"`
	Limit       int             `json:"limit"`
	MemoryBytes int64           `json:"memory_bytes"`
	AddressRoom int64           `json:"address_room"`
	WatchEvery  time.Duration   `json:"watch_every"`
	List        json.RawMessage `json:"list"`
}

type jqAnswer struct {
	Matches   int               `json:"matches"`
	Results   []json.RawMessage `json:"results"`
	Truncated bool              `json:"truncated,omitempty"`
	// Error is the program's own (the caller's to fix); Fail is a value the answer cannot hold.
	Error string `json:"error,omitempty"`
	Fail  string `json:"fail,omitempty"`
}

var errJQMemory = errors.New("jq: the expression needed more memory than a run may hold; narrow it to the fields it needs")

// runJQ runs the compiled-before program over list in the child and returns what it gave.
func runJQ(ctx context.Context, expr string, limit int, list map[string]interface{}) (jqAnswer, error) {
	listJSON, err := json.Marshal(list)
	if err != nil {
		return jqAnswer{}, err
	}
	request, err := json.Marshal(jqRequest{Expr: expr, Limit: limit, MemoryBytes: int64(jqMemoryBase + jqMemoryPerInputByte*len(listJSON)),
		AddressRoom: jqAddressRoom, WatchEvery: jqWatchEvery, List: listJSON})
	if err != nil {
		return jqAnswer{}, err
	}
	self, err := os.Executable()
	if err != nil {
		return jqAnswer{}, fmt.Errorf("jq: cannot find this program to run the expression: %w", err)
	}
	release, err := jqRuns.Take(ctx)
	if err != nil {
		return jqAnswer{}, fmt.Errorf("%w: this jq program waited for its turn, one program at a time, until this call's time ran out, so it did not run; ask again", errBusy)
	}
	defer release()
	// One of the container's process places too, as a kubectl run takes (its memory is reserved the same way).
	releaseProcess, err := kubectlSlots.Take(ctx)
	if err != nil {
		return jqAnswer{}, fmt.Errorf("%w: this jq program waited for one of the %d places for kubectl and jq runs until this call's time ran out, so it did not run; ask again", errBusy, kubectlSlots.Cap())
	}
	defer releaseProcess()
	runCtx, cancel := context.WithTimeout(ctx, jqTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, self, jqWorkerArg)
	// Nothing of this process's environment: the program reads no variable, and the child needs none.
	cmd.Env = []string{}
	cmd.Stdin = bytes.NewReader(request)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = time.Second
	runErr := cmd.Run()
	var exit *exec.ExitError
	switch {
	case runErr == nil:
	case ctx.Err() != nil:
		return jqAnswer{}, fmt.Errorf("%w: this call's time ran out before the jq program finished, so it did not answer; ask again", errBusy)
	case runCtx.Err() != nil:
		return jqAnswer{}, wrapBadRequest(fmt.Sprintf("jq: the expression took longer than %s", jqTimeout))
	case errors.As(runErr, &exit) && (exit.ExitCode() == jqOverMemoryExit || strings.Contains(stderr.String(), "out of memory")):
		return jqAnswer{}, wrapBadRequest(errJQMemory.Error())
	default:
		return jqAnswer{}, fmt.Errorf("jq: the run stopped: %v: %s", runErr, capOutput(stderr.Bytes()))
	}
	var answer jqAnswer
	if err := json.Unmarshal(stdout.Bytes(), &answer); err != nil {
		return jqAnswer{}, fmt.Errorf("jq: unreadable answer from the run: %w", err)
	}
	switch {
	case answer.Error != "":
		return jqAnswer{}, wrapBadRequest("jq: " + answer.Error)
	case answer.Fail != "":
		return jqAnswer{}, errors.New(answer.Fail)
	}
	return answer, nil
}

// runJQWorker is the child: it reads a jqRequest, runs it within its memory budget and writes a jqAnswer.
func runJQWorker(in io.Reader, out io.Writer) int {
	raw, err := io.ReadAll(in)
	if err != nil {
		return 1
	}
	var request jqRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return 1
	}
	if err := limitAddressSpace(request.AddressRoom); err != nil {
		fmt.Fprintf(os.Stderr, "jq: the run's address space could not be limited, so it did not start: %v", err)
		return 1
	}
	watchMemory(request.MemoryBytes, request.WatchEvery)
	answer := jqAnswerFor(&request)
	text, err := json.Marshal(answer)
	if err != nil || len(text) > jqAnswerMaxBytes {
		return 1
	}
	if _, err := out.Write(text); err != nil {
		return 1
	}
	return 0
}

// watchMemory ends the process once its heap passes budget, with the collector aiming below it so garbage does not count;
// a large allocation counts the moment it is made, before its pages are written. It holds the budget, tighter than the
// address space limit, and is all there is outside Linux; one step between two looks is held by that limit.
func watchMemory(budget int64, every time.Duration) {
	debug.SetMemoryLimit(budget * 3 / 4)
	if every <= 0 {
		// time.Tick of zero never ticks: a request without the interval is still watched.
		every = 2 * time.Millisecond
	}
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	go func() {
		for range time.Tick(every) {
			metrics.Read(sample)
			if sample[0].Value.Kind() == metrics.KindUint64 && int64(sample[0].Value.Uint64()) > budget {
				os.Exit(jqOverMemoryExit)
			}
		}
	}()
}

func jqAnswerFor(request *jqRequest) jqAnswer {
	answer := jqAnswer{Results: []json.RawMessage{}}
	query, err := gojq.Parse(request.Expr)
	if err != nil {
		answer.Error = err.Error()
		return answer
	}
	code, err := gojq.Compile(query, gojq.WithEnvironLoader(func() []string { return nil }))
	if err != nil {
		answer.Error = err.Error()
		return answer
	}
	var list map[string]interface{}
	if err := json.Unmarshal(request.List, &list); err != nil {
		answer.Fail = fmt.Sprintf("jq: unreadable list: %v", err)
		return answer
	}
	request.List = nil
	size := 0
	iter := code.Run(list)
	for {
		v, ok := iter.Next()
		if !ok {
			return answer
		}
		if jqErr, isErr := v.(error); isErr {
			answer.Error = jqErr.Error()
			return answer
		}
		answer.Matches++
		if len(answer.Results) >= request.Limit {
			answer.Truncated = true
			continue
		}
		raw, err := json.Marshal(v)
		if err != nil {
			answer.Fail = err.Error()
			return answer
		}
		if size+len(raw) > jqOutputCap {
			answer.Truncated = true
			continue
		}
		size += len(raw)
		answer.Results = append(answer.Results, raw)
	}
}
