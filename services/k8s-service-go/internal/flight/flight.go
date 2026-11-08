// Package flight runs one read at a time per key for everyone waiting on it, so a crowd asking one thing at one moment
// costs the cluster about two reads. A caller's key must hold who is asking: an answer goes to everyone with that key.
package flight

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
)

// ErrPanicked is the error of a read that panicked while others waited on it.
var ErrPanicked = errors.New("shared read panicked")

// Group is safe for concurrent use; its zero value is ready.
type Group[T any] struct {
	mu   sync.Mutex
	keys map[string]*state[T]
}

// state is a key with a read under way.
type state[T any] struct {
	next *call[T] // answers those who came after that read started, as it may have read before what they want to see
}

type call[T any] struct {
	ctx     context.Context
	cancel  context.CancelFunc
	read    func(context.Context) (T, error)
	waiters int
	done    chan struct{}
	val     T
	err     error
}

// Do returns the answer of a read that started after this call: no caller gets an answer older than its question.
// A caller who finds no read under way reads for itself, as it would with no Group. The others wait for one more read,
// which runs on the first of them's context values, not its cancellation, and ends when the last of them has gone, so
// one caller leaving fails no one else. joined says another caller's read answered this one.
func (g *Group[T]) Do(ctx context.Context, key string, read func(context.Context) (T, error)) (v T, joined bool, err error) {
	return g.DoOr(ctx, key, func() (T, error) { return read(ctx) }, read)
}

// DoOr is Do for a caller that reads otherwise when no one else depends on the read: alone runs on the caller's goroutine
// and its answer goes to this caller only, read is the one other callers wait on.
func (g *Group[T]) DoOr(ctx context.Context, key string, alone func() (T, error), read func(context.Context) (T, error)) (v T, joined bool, err error) {
	g.mu.Lock()
	if g.keys == nil {
		g.keys = map[string]*state[T]{}
	}
	st := g.keys[key]
	if st == nil {
		g.keys[key] = &state[T]{}
		g.mu.Unlock()
		defer g.finished(key)
		v, err = alone()
		return v, false, err
	}
	c := st.next
	if c == nil {
		c = newCall(ctx, read)
		st.next = c
	} else {
		c.waiters++
		joined = true
	}
	g.mu.Unlock()
	select {
	case <-c.done:
		return c.val, joined, c.err
	case <-ctx.Done():
		g.leave(key, c)
		return v, joined, ctx.Err()
	}
}

func newCall[T any](ctx context.Context, read func(context.Context) (T, error)) *call[T] {
	readCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	return &call[T]{ctx: readCtx, cancel: cancel, read: read, waiters: 1, done: make(chan struct{})}
}

// finished is a read of key ending: the next one starts if anyone waits for it.
func (g *Group[T]) finished(key string) {
	g.mu.Lock()
	st := g.keys[key]
	next := st.next
	st.next = nil
	if next == nil {
		delete(g.keys, key)
	}
	g.mu.Unlock()
	if next != nil {
		go func() {
			defer g.finished(key)
			next.answer()
			next.cancel()
			close(next.done)
		}()
	}
}

// answer keeps a panic from taking the process down: nothing above this goroutine recovers it.
func (c *call[T]) answer() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("shared read panicked", "panic", r, "stack", string(debug.Stack()))
			c.err = fmt.Errorf("%w: %v", ErrPanicked, r)
		}
	}()
	c.val, c.err = c.read(c.ctx)
}

// leave takes a caller off a read; a read no one waits for stops, or never starts.
func (g *Group[T]) leave(key string, c *call[T]) {
	g.mu.Lock()
	defer g.mu.Unlock()
	c.waiters--
	if c.waiters > 0 {
		return
	}
	c.cancel()
	if st := g.keys[key]; st != nil && st.next == c {
		st.next = nil
	}
}
