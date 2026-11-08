// k8s_jq_query's program runs in a child of this binary that ends itself past a memory budget, since one gojq step (a
// repeated string, an index far past an array's end) can hold hundreds of MB that no goroutine can be stopped from
// taking, and on cgroup v2 an OOM kill takes tool-server with it (memory.oom.group); the time limit ends it from here.

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
)

const (
	jqWorkerArg = "--jq-worker"
	// jqMemoryBase is what a program may hold besides its input, which takes jqMemoryPerInputByte for each byte: about a
	// kubectl run's 40 MiB at the default 1 MiB list (two ordinary programs over one ran within 16 MiB).
	jqMemoryBase         = 32 << 20
	jqMemoryPerInputByte = 8
	jqOverMemoryExit     = 3
	jqWatchEvery         = 2 * time.Millisecond
	jqAnswerMaxBytes     = 4 * jqOutputCap
)

// jqTimeout is a variable so a test can wait less than the run's 5 s.
var jqTimeout = 5 * time.Second

type jqRequest struct {
	Expr        string          `json:"expr"`
	Limit       int             `json:"limit"`
	MemoryBytes int64           `json:"memory_bytes"`
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
	request, err := json.Marshal(jqRequest{Expr: expr, Limit: limit, MemoryBytes: int64(jqMemoryBase + jqMemoryPerInputByte*len(listJSON)), List: listJSON})
	if err != nil {
		return jqAnswer{}, err
	}
	self, err := os.Executable()
	if err != nil {
		return jqAnswer{}, fmt.Errorf("jq: cannot find this program to run the expression: %w", err)
	}
	// One of the container's process places, as a kubectl run takes (its memory is reserved the same way).
	release, err := kubectlSlots.Take(ctx)
	if err != nil {
		return jqAnswer{}, fmt.Errorf("%d kubectl and jq runs were under way until this call's time ran out: %w", kubectlSlots.Cap(), err)
	}
	defer release()
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
	watchMemory(request.MemoryBytes)
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
// a large allocation counts the moment it is made, before its pages are written.
func watchMemory(budget int64) {
	debug.SetMemoryLimit(budget * 3 / 4)
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	go func() {
		for range time.Tick(jqWatchEvery) {
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
