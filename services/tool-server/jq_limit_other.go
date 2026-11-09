//go:build !linux || cgo

package main

// jqAddressLimited is false where limitAddressSpace sets nothing: macOS refuses RLIMIT_AS (EINVAL), and a build with
// cgo starts its threads through pthread_create, whose stacks count against the limit. The image is built without cgo
// on Linux; elsewhere the heap watcher alone holds a run to its budget.
const jqAddressLimited = false

func limitAddressSpace(int64) error { return nil }
