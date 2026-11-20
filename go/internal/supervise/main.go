package supervise

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"claude-task-platform/go/internal/platform"
)

// Exit ends the launcher the way the command ended: with its exit code, or with the signal that killed it, so the
// parent sees the same termination it would without a launcher. The Go runtime keeps its own handlers for most
// signals (SIGUSR1 would be ignored), so the signal is raised after exec'ing /bin/sh, which starts with default
// dispositions and keeps the launcher's PID.
func Exit(code int, sig syscall.Signal) {
	if sig != 0 {
		signal.Reset()
		name := unix.SignalName(sig)
		if name != "" {
			_ = syscall.Exec("/bin/sh", []string{"sh", "-c", "kill -s " + strings.TrimPrefix(name, "SIG") + " $$"}, nil)
		}
		_ = syscall.Kill(os.Getpid(), sig)
		time.Sleep(100 * time.Millisecond)
		os.Exit(128 + int(sig))
	}
	os.Exit(code)
}

// Main parses the launcher's flags (`[flags] -- command args`), runs the command and returns the exit code, or the
// signal the caller must re-raise.
func Main(argv []string) (int, syscall.Signal) {
	fs := flag.NewFlagSet("platform-supervise", flag.ContinueOnError)
	var o Options
	fs.DurationVar(&o.Timeout, "timeout", 0, "wall-clock deadline (0 = none)")
	fs.DurationVar(&o.Grace, "grace", 5*time.Second, "SIGTERM grace before the forced kill (0 = kill at once)")
	fs.StringVar(&o.CgroupMode, "cgroup", "auto", "require | auto | none")
	fs.Int64Var(&o.Limits.MemoryMB, "memory-mb", 0, "cgroup memory.max (MiB, 0 = none)")
	fs.IntVar(&o.Limits.Pids, "pids", 0, "cgroup pids.max (0 = none)")
	fs.IntVar(&o.Limits.CPUPercent, "cpu-percent", 0, "cgroup cpu.max, 100 = one CPU (0 = none)")
	fs.Int64Var(&o.Limits.CPUSeconds, "cpu-seconds", 0, "RLIMIT_CPU per process (0 = none)")
	fs.Int64Var(&o.Limits.FileSizeMB, "fsize-mb", 0, "RLIMIT_FSIZE (MiB, 0 = none)")
	fs.Int64Var(&o.Limits.OpenFiles, "nofile", 0, "RLIMIT_NOFILE (0 = unchanged)")
	fs.StringVar(&o.Admission.Dir, "admission-dir", "", "host-wide admission lock directory")
	fs.StringVar(&o.Class, "class", "agent", "agent | verification")
	fs.IntVar(&o.Admission.Slots, "slots", 0, "concurrent processes of this class on this host (0 = no admission)")
	fs.DurationVar(&o.Admission.Timeout, "admission-timeout", 10*time.Minute, "longest wait for a slot")
	fs.Float64Var(&o.Admission.MaxMemoryPressure, "psi-memory", 0, "defer while /proc/pressure/memory some avg10 exceeds this %")
	fs.Float64Var(&o.Admission.MaxCPUPressure, "psi-cpu", 0, "defer while /proc/pressure/cpu some avg10 exceeds this %")
	fs.StringVar(&o.ReportPath, "report", "", "write the JSON report here")
	unset := fs.String("unset", "", "comma-separated variables to drop from the command's environment")
	fs.StringVar(&o.RunID, "run-id", "", "trace correlation")
	fs.StringVar(&o.AttemptID, "attempt-id", "", "trace correlation")
	if err := fs.Parse(argv); err != nil {
		return ExitBadArguments, 0
	}
	o.Command = fs.Args()
	if len(o.Command) == 0 || !(o.CgroupMode == "require" || o.CgroupMode == "auto" || o.CgroupMode == "none") ||
		(o.Admission.Slots > 0 && o.Admission.Dir == "") {
		fmt.Fprintln(os.Stderr, "usage: platform-supervise [flags] -- command [args]")
		return ExitBadArguments, 0
	}
	o.Admission.Class = o.Class
	if *unset != "" {
		o.Unset = strings.Split(*unset, ",")
	}
	// The launcher's own telemetry endpoint arrives prefixed, so the command never inherits it.
	shutdown := func(context.Context) error { return nil }
	if ep := os.Getenv("CTP_SUPERVISE_OTEL_EXPORTER_OTLP_ENDPOINT"); ep != "" {
		_ = os.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", ep)
		o.Unset = append(o.Unset, "OTEL_EXPORTER_OTLP_ENDPOINT")
		if s, err := platform.SetupTelemetry(context.Background(), true); err == nil {
			shutdown = s
		}
	}
	code, sig := Run(o)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	_ = shutdown(ctx)
	cancel()
	return code, sig
}
