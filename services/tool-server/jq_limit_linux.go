//go:build linux && !cgo

package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

const jqAddressLimited = true

// limitAddressSpace lets the run map room bytes past what it has mapped now: the heap reserves its arenas before it
// writes them, so a step past that fails in mmap before a page is used (setrlimit(2), RLIMIT_AS).
func limitAddressSpace(room int64) error {
	if room <= 0 {
		return fmt.Errorf("no address space room given")
	}
	held, err := addressSpaceHeld()
	if err != nil {
		return err
	}
	limit := uint64(held + room)
	return syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: limit, Max: limit})
}

// addressSpaceHeld is the process's VmSize, what RLIMIT_AS counts.
func addressSpaceHeld() (int64, error) {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(status), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmSize:"); ok {
			kib, err := strconv.ParseInt(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(rest), "kB")), 10, 64)
			if err != nil {
				return 0, fmt.Errorf("VmSize %q: %w", rest, err)
			}
			return kib << 10, nil
		}
	}
	return 0, fmt.Errorf("no VmSize in /proc/self/status")
}
