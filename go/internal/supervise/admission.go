package supervise

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// Admission bounds how many processes of one class run at once on this host, across every platform instance and
// engine user of the same account: N lock files per class, a process holds one flock for its lifetime. The kernel
// drops the lock when the launcher exits, crashes or is killed, so a slot can never leak. Before taking a slot the
// launcher also waits (bounded) while the host is under memory or CPU pressure (PSI avg10).
type Admission struct {
	Dir     string // e.g. /tmp/ctp-admission-<uid>
	Class   string // agent | verification
	Slots   int
	Timeout time.Duration
	// Wait while /proc/pressure avg10 "some" exceeds these percentages (0 = ignore).
	MaxMemoryPressure float64
	MaxCPUPressure    float64
}

// Acquire returns the held slot (close it to release) and how long it waited. It gives up when ctx ends (canceled
// before the command started) or Timeout passes; a pressure wait that times out still runs the command (the slot is
// the hard bound, pressure only defers).
func (a Admission) Acquire(ctx context.Context) (*os.File, time.Duration, error) {
	start := time.Now()
	if a.Slots <= 0 {
		return nil, 0, nil
	}
	dir := filepath.Join(a.Dir, a.Class)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, 0, err
	}
	deadline := start.Add(a.Timeout)
	for {
		for i := range a.Slots {
			f, err := os.OpenFile(filepath.Join(dir, fmt.Sprintf("slot-%d", i)), os.O_CREATE|os.O_RDWR, 0o600)
			if err != nil {
				return nil, time.Since(start), err
			}
			if unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB) == nil {
				if err := a.waitPressure(ctx, deadline); err != nil {
					_ = f.Close()
					return nil, time.Since(start), err
				}
				return f, time.Since(start), nil
			}
			_ = f.Close()
		}
		if a.Timeout > 0 && time.Now().After(deadline) {
			return nil, time.Since(start), fmt.Errorf("no %s slot free within %s (%d slots)", a.Class, a.Timeout, a.Slots)
		}
		select {
		case <-ctx.Done():
			return nil, time.Since(start), ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (a Admission) waitPressure(ctx context.Context, deadline time.Time) error {
	for {
		cpu, mem, _ := SystemPressure()
		over := (a.MaxMemoryPressure > 0 && mem > a.MaxMemoryPressure) || (a.MaxCPUPressure > 0 && cpu > a.MaxCPUPressure)
		if !over || (a.Timeout > 0 && time.Now().After(deadline)) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
