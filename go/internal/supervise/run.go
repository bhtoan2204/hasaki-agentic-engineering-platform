// Package supervise is the process launcher behind PROCESS_SUPERVISION_ENGINE=go (ADR 0005): one short-lived
// `platform-supervise` per supervised command, started by the TypeScript adapter (src/agent/process/supervisor.ts)
// in front of the real command. The command inherits the launcher's stdin, stdout and stderr directly (no copy, no
// buffer: the pipe itself is the backpressure, and JSONL protocols, stdin semantics and resume are untouched). The
// launcher owns the rest of the lifecycle: admission, limits, process group and descendants, deadline, graceful
// then forced termination, zombie reaping, orphan cleanup and a usage report.
package supervise

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Limits apply to the command and all its descendants (cgroup) or to each process (rlimits).
type Limits struct {
	MemoryMB   int64 `json:"memory_mb,omitempty"`
	Pids       int   `json:"pids,omitempty"`
	CPUPercent int   `json:"cpu_percent,omitempty"`
	CPUSeconds int64 `json:"cpu_seconds,omitempty"`
	FileSizeMB int64 `json:"file_size_mb,omitempty"`
	OpenFiles  int64 `json:"open_files,omitempty"`
}

type Options struct {
	Command []string
	// Wall-clock deadline (0 = none). The TypeScript watchdog keeps the turn and idle limits; this is the backstop
	// that still holds when the platform process is stuck or gone.
	Timeout time.Duration
	// Between SIGTERM and the forced kill; 0 kills at once.
	Grace time.Duration
	// "require": refuse to run without a delegated cgroup (fail closed); "auto": fall back to the process tree;
	// "none": never use one.
	CgroupMode string
	Limits     Limits
	Admission  Admission
	ReportPath string
	// Environment variables removed from the command's environment (they were only for the launcher).
	Unset []string
	// Trace correlation only (span attributes), never metric labels.
	RunID, AttemptID string
	Class            string
}

type PSI struct {
	CPUSomeMs    int64 `json:"cpu_some_ms"`
	MemorySomeMs int64 `json:"memory_some_ms"`
	IOSomeMs     int64 `json:"io_some_ms"`
}

type Usage struct {
	MemoryPeakBytes     int64 `json:"memory_peak_bytes"`
	OOMKills            int64 `json:"oom_kills"`
	MemoryMaxEvents     int64 `json:"memory_max_events"`
	PidsMaxEvents       int64 `json:"pids_max_events"`
	CPUMs               int64 `json:"cpu_ms"`
	CPUThrottledMs      int64 `json:"cpu_throttled_ms"`
	CPUThrottledPeriods int64 `json:"cpu_throttled_periods"`
	PSI                 PSI   `json:"psi"`
}

// Report is written to ReportPath when the launcher ends. It carries no environment, arguments or output.
type Report struct {
	Engine  string `json:"engine"`
	Outcome string `json:"outcome"` // exited | signaled | timeout | canceled | canceled_before_start | admission_timeout | start_failed | isolation_unavailable
	// Why the launcher could not run the command (start_failed, isolation_unavailable, admission_timeout).
	Error           string  `json:"error,omitempty"`
	ExitCode        *int    `json:"exit_code"`
	Signal          string  `json:"signal,omitempty"`
	Isolation       string  `json:"isolation"` // cgroup | process-tree
	AdmissionWaitMs int64   `json:"admission_wait_ms"`
	StartLatencyMs  float64 `json:"start_latency_ms"`
	DurationMs      int64   `json:"duration_ms"`
	CleanupMs       float64 `json:"cleanup_ms"`
	// Processes still alive when the stop began (graceful SIGTERM) and when the forced kill ran.
	Terminated int `json:"terminated"`
	Killed     int `json:"killed"`
	// Descendants still running after the command itself exited: killed as orphans.
	Orphans  int    `json:"orphans"`
	Survived int    `json:"survived"` // still alive after cleanup (should always be 0)
	Usage    Usage  `json:"usage"`
	Limits   Limits `json:"limits"`
}

// Exit codes of the launcher's own failures (the command's own code otherwise).
const (
	ExitStartFailed  = 127
	ExitUnavailable  = 125
	ExitNotAdmitted  = 124
	ExitBadArguments = 2
)

// Run supervises opts.Command and returns the launcher's exit status: the command's exit code, or the signal that
// ended it (the caller re-raises it so the parent sees the same termination it would have seen without a launcher).
func Run(opts Options) (code int, sig syscall.Signal) {
	began := time.Now()
	rep := Report{Engine: "go", Limits: opts.Limits, Isolation: "process-tree"}
	defer func() {
		rep.DurationMs = time.Since(began).Milliseconds()
		if opts.ReportPath != "" {
			if b, err := json.Marshal(rep); err == nil {
				_ = os.WriteFile(opts.ReportPath, b, 0o600)
			}
		}
		record(opts, &rep)
	}()

	// Die with the platform: if it goes away (even by SIGKILL) the launcher stops the command like a cancel.
	_ = unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGTERM), 0, 0, 0)
	_ = unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
	stop := make(chan string, 1)
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, unix.SIGTERM, unix.SIGINT, unix.SIGHUP)
	go func() {
		<-signals
		select {
		case stop <- "canceled":
		default:
		}
	}()
	if os.Getppid() == 1 {
		rep.Outcome = "canceled_before_start"
		return ExitNotAdmitted, 0
	}

	// Admission (cancelable: a stop while waiting ends here, before anything ran).
	admitCtx, cancelAdmit := context.WithCancel(context.Background())
	go func() {
		select {
		case reason := <-stop:
			stop <- reason
			cancelAdmit()
		case <-admitCtx.Done():
		}
	}()
	slot, waited, err := opts.Admission.Acquire(admitCtx)
	cancelAdmit()
	rep.AdmissionWaitMs = waited.Milliseconds()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			rep.Outcome = "canceled_before_start"
			return ExitNotAdmitted, 0
		}
		rep.Outcome, rep.Error = "admission_timeout", err.Error()
		fmt.Fprintf(os.Stderr, "platform-supervise: %s\n", rep.Error)
		return ExitNotAdmitted, 0
	}
	if slot != nil {
		defer slot.Close()
	}

	var cg *Cgroup
	if opts.CgroupMode != "none" {
		cg, err = SetupCgroup(opts.Limits)
		if err != nil && opts.CgroupMode == "require" {
			rep.Outcome, rep.Error = "isolation_unavailable", "delegated cgroup unavailable: "+err.Error()
			fmt.Fprintf(os.Stderr, "platform-supervise: %s\n", rep.Error)
			return ExitUnavailable, 0
		}
		if cg != nil {
			rep.Isolation = "cgroup"
			defer cg.Remove()
		}
	}
	if err := applyRlimits(opts.Limits); err != nil {
		rep.Outcome, rep.Error = "start_failed", err.Error()
		return ExitStartFailed, 0
	}

	attr := &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	if cg != nil {
		attr.UseCgroupFD, attr.CgroupFD = true, cg.FD()
	}
	// Pdeathsig follows the OS thread that forked: keep this goroutine on it for the launcher's whole life.
	runtime.LockOSThread()
	startAt := time.Now()
	proc, err := os.StartProcess(lookPath(opts.Command[0]), opts.Command, &os.ProcAttr{
		Env:   env(opts.Unset),
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
		Sys:   attr,
	})
	if err != nil {
		rep.Outcome, rep.Error = "start_failed", err.Error()
		fmt.Fprintf(os.Stderr, "platform-supervise: %v\n", err)
		return ExitStartFailed, 0
	}
	rep.StartLatencyMs = float64(time.Since(startAt).Microseconds()) / 1000
	pid := proc.Pid

	// Reap every child (the command and reparented descendants); report the command's own status.
	exited := make(chan unix.WaitStatus, 1)
	var reaper sync.WaitGroup
	reaper.Go(func() {
		for {
			var ws unix.WaitStatus
			p, err := unix.Wait4(-1, &ws, 0, nil)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			if err != nil { // ECHILD: nothing left
				return
			}
			if p == pid {
				exited <- ws
			}
		}
	})

	var deadline <-chan time.Time
	if opts.Timeout > 0 {
		deadline = time.After(opts.Timeout)
	}
	var status unix.WaitStatus
	reason := ""
	select {
	case status = <-exited:
	case reason = <-stop:
	case <-deadline:
		reason = "timeout"
	}

	cleanupStart := time.Now()
	alive := func() []int {
		if cg != nil {
			return cg.Pids()
		}
		return slices.DeleteFunc(descendants(), func(p int) bool { return isZombie(p) })
	}
	signalAll := func(s unix.Signal) int {
		_ = unix.Kill(-pid, s) // the process group first: what a terminal would do
		if cg != nil {
			return signalPids(cg.Pids(), cg.Dir, s)
		}
		return signalTree(s)
	}
	forceAll := func() int {
		n := len(alive())
		if cg != nil {
			if cg.Kill(5*time.Second) == nil {
				return n
			}
		}
		// Without cgroup.kill, repeat until the tree is empty: while a killed parent exits, its children are
		// moving to the launcher (subreaper) and appear in neither children list for a moment.
		for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
			signalAll(unix.SIGKILL)
			if len(alive()) == 0 {
				break
			}
		}
		return n
	}
	if reason != "" {
		rep.Outcome = reason
		if opts.Grace > 0 {
			rep.Terminated = signalAll(unix.SIGTERM)
			graceEnd := time.After(opts.Grace)
		wait:
			for len(alive()) > 0 {
				select {
				case <-graceEnd:
					break wait
				case <-time.After(10 * time.Millisecond):
				}
			}
		}
		rep.Killed = forceAll()
		status = <-exited
	} else {
		// The command exited by itself: helpers it left behind are orphans.
		rep.Orphans = forceAll()
	}
	waitGone(alive, 5*time.Second)
	rep.Survived = len(alive())
	rep.CleanupMs = float64(time.Since(cleanupStart).Microseconds()) / 1000
	if cg != nil {
		rep.Usage = cg.Usage()
	}
	_ = proc.Release()

	switch {
	case status.Exited():
		c := status.ExitStatus()
		rep.ExitCode = &c
		if rep.Outcome == "" {
			rep.Outcome = "exited"
		}
		return c, 0
	case status.Signaled():
		rep.Signal = unix.SignalName(status.Signal())
		if rep.Outcome == "" {
			rep.Outcome = "signaled"
			if status.Signal() == unix.SIGKILL && rep.Usage.OOMKills > 0 {
				rep.Outcome = "oom"
			}
		}
		return 0, syscall.Signal(status.Signal())
	}
	return 1, 0
}

func waitGone(alive func() []int, max time.Duration) {
	end := time.Now().Add(max)
	for len(alive()) > 0 && time.Now().Before(end) {
		time.Sleep(5 * time.Millisecond)
	}
}

func isZombie(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	s := string(b)
	f := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
	return len(f) > 0 && f[0] == "Z"
}

func applyRlimits(l Limits) error {
	// syscall.Setrlimit (not x/sys): Go restores its saved RLIMIT_NOFILE for children unless set through syscall.
	set := func(res int, v uint64) error { return syscall.Setrlimit(res, &syscall.Rlimit{Cur: v, Max: v}) }
	if err := set(unix.RLIMIT_CORE, 0); err != nil {
		return err
	}
	for _, x := range []struct {
		res int
		v   int64
		mul uint64
	}{{unix.RLIMIT_CPU, l.CPUSeconds, 1}, {unix.RLIMIT_FSIZE, l.FileSizeMB, 1 << 20}, {unix.RLIMIT_NOFILE, l.OpenFiles, 1}} {
		if x.v > 0 {
			if err := set(x.res, uint64(x.v)*x.mul); err != nil {
				return fmt.Errorf("rlimit %d: %w", x.res, err)
			}
		}
	}
	return nil
}

func env(unset []string) []string {
	out := os.Environ()
	return slices.DeleteFunc(out, func(kv string) bool {
		k, _, _ := strings.Cut(kv, "=")
		return strings.HasPrefix(k, "CTP_SUPERVISE_") || slices.Contains(unset, k)
	})
}

// lookPath resolves a bare command name on the command's PATH (structured argv: never a shell).
func lookPath(name string) string {
	if strings.Contains(name, "/") {
		return name
	}
	for _, dir := range strings.Split(os.Getenv("PATH"), ":") {
		if dir == "" {
			continue
		}
		p := dir + "/" + name
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p
		}
	}
	return name
}
