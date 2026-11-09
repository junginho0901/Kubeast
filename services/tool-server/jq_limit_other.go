//go:build !linux

package main

// limitAddressSpace sets nothing outside Linux, where the image runs: macOS refuses RLIMIT_AS (EINVAL), so the heap
// watcher alone holds a run to its budget there.
func limitAddressSpace(int64) error { return nil }
