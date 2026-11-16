package main

import (
	"context"
	"fmt"
	"os"
	"testing"
)

// The kubectl runner a test of the runner itself calls, on a stand-in binary of its own.
var realKubectlExec = kubectlExec

// A test that forgets its stand-in fails on it instead of reaching the cluster the machine's kubeconfig names.
func TestMain(m *testing.M) {
	// handleJQQuery runs its program in this binary as a child, as main does.
	if len(os.Args) > 1 && os.Args[1] == jqWorkerArg {
		os.Exit(runJQWorker(os.Stdin, os.Stdout))
	}
	kubectlExec = func(_ context.Context, args []string, _ *string) ([]byte, error) {
		return nil, fmt.Errorf("a test reached kubectl without its stand-in: %v", args)
	}
	os.Exit(m.Run())
}

// kubectlAsNoOne turns impersonationEnabled off for one test that calls a handler with a context holding no person
// and reads kubectl's argv from its verb; the package's value comes back after it.
func kubectlAsNoOne(t *testing.T) {
	t.Helper()
	was := impersonationEnabled
	impersonationEnabled = false
	t.Cleanup(func() { impersonationEnabled = was })
}
