//go:build linux

package supervise

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as the launcher: with CTP_SUPERVISE_HELPER=1 it runs Main and ends exactly like
// cmd/platform-supervise (re-raising the command's signal).
func TestMain(m *testing.M) {
	if os.Getenv("CTP_SUPERVISE_HELPER") == "1" {
		_ = os.Unsetenv("CTP_SUPERVISE_HELPER")
		Exit(Main(os.Args[1:]))
	}
	os.Exit(m.Run())
}

// cgroupAvailable: a delegated systemd --user scope works here. CTP_REQUIRE_CGROUP=1 (CI) turns its absence
// into a failure instead of an explicit skip.
func cgroupAvailable(t *testing.T) bool {
	t.Helper()
	err := exec.Command("systemd-run", "--user", "--scope", "-q", "--collect", "-p", "Delegate=yes", "true").Run()
	if err != nil {
		if os.Getenv("CTP_REQUIRE_CGROUP") == "1" {
			t.Fatalf("delegated cgroup required but unavailable: %v", err)
		}
		t.Skipf("no delegated cgroup (systemd --user scope) on this host: %v", err)
	}
	return true
}

type launch struct {
	cmd    *exec.Cmd
	report string
	stdout *bytes.Buffer
}

// scoped is a systemd-run command line; systemd-run expands `$` in it, so arguments are escaped (as the platform does).
func scoped(args ...string) *exec.Cmd {
	esc := make([]string, len(args))
	for i, a := range args {
		esc[i] = strings.ReplaceAll(a, "$", "$$")
	}
	return exec.Command("systemd-run", append([]string{"--user", "--scope", "-q", "--collect", "-p", "Delegate=yes", "--"}, esc...)...)
}

// start runs the launcher with flags and command; scope wraps it in a delegated systemd scope.
func start(t *testing.T, scope bool, flags []string, command ...string) *launch {
	t.Helper()
	self, _ := os.Executable()
	report := filepath.Join(t.TempDir(), "report.json")
	args := append(append([]string{"--report=" + report}, flags...), append([]string{"--"}, command...)...)
	var cmd *exec.Cmd
	if scope {
		cmd = scoped(append([]string{self}, args...)...)
	} else {
		cmd = exec.Command(self, args...)
	}
	cmd.Env = append(os.Environ(), "CTP_SUPERVISE_HELPER=1")
	out := &bytes.Buffer{}
	cmd.Stdout, cmd.Stderr = out, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	return &launch{cmd: cmd, report: report, stdout: out}
}

func (l *launch) wait(t *testing.T) (Report, *os.ProcessState) {
	t.Helper()
	_ = l.cmd.Wait()
	var r Report
	b, err := os.ReadFile(l.report)
	if err != nil {
		t.Fatalf("no report: %v", err)
	}
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r, l.cmd.ProcessState
}

// alive reports whether any process carries marker in its command line.
func alive(marker string) []int {
	var out []int
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		// Only the sleeper itself (shells whose script mentions the marker do not count).
		if err == nil && bytes.Contains(b, []byte("python3\x00-c\x00import time")) && bytes.Contains(b, []byte(marker)) {
			if st, err := os.ReadFile("/proc/" + e.Name() + "/stat"); err == nil && !strings.Contains(string(st), ") Z ") {
				out = append(out, pid)
			}
		}
	}
	return out
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	end := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func marker(t *testing.T) string {
	return fmt.Sprintf("ctp-test-%s-%d", t.Name(), time.Now().UnixNano())
}

// A command that sleeps with a recognisable argv (the marker is its argument; python does not exec away).
func sleeper(m string) string { return fmt.Sprintf(`python3 -c "import time; time.sleep(300)" %s`, m) }

func TestStreamsExitCodesAndSignalsPassThrough(t *testing.T) {
	for _, scope := range []bool{false, true} {
		if scope && !cgroupAvailable(t) {
			continue
		}
		self, _ := os.Executable()
		cmd := exec.Command(self, "--cgroup=none", "--", "sh", "-c", `while read l; do echo "got:$l"; done; echo err >&2; exit 7`)
		if scope {
			cmd = scoped(self, "--cgroup=require", "--", "sh", "-c", `while read l; do echo "got:$l"; done; echo err >&2; exit 7`)
		}
		cmd.Env = append(os.Environ(), "CTP_SUPERVISE_HELPER=1")
		cmd.Stdin = strings.NewReader("a\nb\n")
		var out, errOut bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errOut
		_ = cmd.Run()
		if out.String() != "got:a\ngot:b\n" || errOut.String() != "err\n" || cmd.ProcessState.ExitCode() != 7 {
			t.Fatalf("scope=%v stdout %q stderr %q code %d", scope, out.String(), errOut.String(), cmd.ProcessState.ExitCode())
		}
		// A command killed by a signal ends the launcher with the same signal.
		l := start(t, scope, []string{"--cgroup=" + map[bool]string{true: "require", false: "none"}[scope]}, "sh", "-c", "kill -USR1 $$")
		r, st := l.wait(t)
		ws := st.Sys().(syscall.WaitStatus)
		if !ws.Signaled() || ws.Signal() != syscall.SIGUSR1 || r.Outcome != "signaled" || r.Signal != "SIGUSR1" {
			t.Fatalf("scope=%v %+v %v", scope, r, ws)
		}
	}
}

// Every descendant shape is gone after the command exits: background job, setsid daemon, double fork.
func TestNoDescendantSurvives(t *testing.T) {
	for _, scope := range []bool{false, true} {
		if scope && !cgroupAvailable(t) {
			continue
		}
		m := marker(t)
		script := fmt.Sprintf(`(%[1]s) & setsid sh -c '%[1]s' & sh -c '(%[1]s) &' & sleep 0.3; exit 0`, sleeper(m))
		l := start(t, scope, []string{"--cgroup=" + map[bool]string{true: "require", false: "none"}[scope]}, "bash", "-c", script)
		r, _ := l.wait(t)
		if r.Outcome != "exited" || r.Orphans < 3 || r.Survived != 0 {
			t.Fatalf("scope=%v report %+v", scope, r)
		}
		if p := alive(m); len(p) > 0 {
			t.Fatalf("scope=%v survivors %v", scope, p)
		}
		want := map[bool]string{true: "cgroup", false: "process-tree"}[scope]
		if r.Isolation != want {
			t.Fatalf("isolation %s, want %s", r.Isolation, want)
		}
	}
}

func TestCancelGracefulThenForced(t *testing.T) {
	for _, scope := range []bool{false, true} {
		if scope && !cgroupAvailable(t) {
			continue
		}
		mode := "--cgroup=" + map[bool]string{true: "require", false: "none"}[scope]
		dir := t.TempDir()
		// Honours SIGTERM: writes a marker and exits within the grace period.
		l := start(t, scope, []string{mode, "--grace=5s"}, "sh", "-c", fmt.Sprintf(`trap 'echo bye > %s/term; exit 0' TERM; sleep 300 & wait`, dir))
		time.Sleep(300 * time.Millisecond)
		_ = l.cmd.Process.Signal(syscall.SIGTERM)
		r, _ := l.wait(t)
		if r.Outcome != "canceled" || r.Survived != 0 {
			t.Fatalf("scope=%v %+v", scope, r)
		}
		if _, err := os.Stat(dir + "/term"); err != nil {
			t.Fatalf("scope=%v the command did not get SIGTERM first", scope)
		}
		if r.CleanupMs > 4000 {
			t.Fatalf("graceful stop waited the whole grace: %v ms", r.CleanupMs)
		}
		// Ignores SIGTERM, has a detached child that ignores it too: killed after the grace.
		m := marker(t)
		l = start(t, scope, []string{mode, "--grace=300ms", "--timeout=500ms"}, "bash", "-c",
			fmt.Sprintf(`trap '' TERM; setsid bash -c 'trap "" TERM; %s' & sleep 300 & wait`, sleeper(m)))
		r, st := l.wait(t)
		ws := st.Sys().(syscall.WaitStatus)
		if r.Outcome != "timeout" || r.Killed == 0 || r.Survived != 0 || !ws.Signaled() || ws.Signal() != syscall.SIGKILL {
			t.Fatalf("scope=%v %+v %v", scope, r, ws)
		}
		if p := alive(m); len(p) > 0 {
			t.Fatalf("scope=%v survivors %v", scope, p)
		}
	}
}

// The platform dies (SIGKILL): the launcher's parent-death signal stops the command and its descendants.
func TestParentCrashCleansUp(t *testing.T) {
	self, _ := os.Executable()
	m := marker(t)
	// An intermediate parent we can kill: it starts the launcher, then waits.
	parent := exec.Command("sh", "-c", `"$0" --cgroup=none --grace=200ms -- bash -c "$1" & wait`, self,
		fmt.Sprintf(`setsid bash -c '%s' & sleep 300`, sleeper(m)))
	parent.Env = append(os.Environ(), "CTP_SUPERVISE_HELPER=1")
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the command to run", func() bool { return len(alive(m)) > 0 })
	// The launcher's parent is the sh; kill sh's child chain from the top: sh dies, the launcher is reparented.
	launcher := children(parent.Process.Pid)
	if len(launcher) != 1 {
		t.Fatalf("launcher %v", launcher)
	}
	_ = syscall.Kill(parent.Process.Pid, syscall.SIGKILL)
	_ = parent.Wait()
	waitUntil(t, "cleanup after the parent died", func() bool { return len(alive(m)) == 0 })
	waitUntil(t, "the launcher to exit", func() bool { return syscall.Kill(launcher[0], 0) != nil })
}

// Signals reach only the launcher's own tree: an unrelated process with the same name is untouched, and a pid that
// is not in the workload cgroup is skipped even when it is passed in.
func TestOnlyOwnProcessesAreSignaled(t *testing.T) {
	m := marker(t)
	outsider := exec.Command("bash", "-c", sleeper(m))
	if err := outsider.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = outsider.Process.Kill(); _ = outsider.Wait() }()
	waitUntil(t, "outsider", func() bool { return len(alive(m)) == 1 })
	l := start(t, false, []string{"--cgroup=none", "--timeout=300ms", "--grace=100ms"}, "bash", "-c", sleeper(m))
	r, _ := l.wait(t)
	if r.Outcome != "timeout" || r.Survived != 0 {
		t.Fatalf("%+v", r)
	}
	if syscall.Kill(outsider.Process.Pid, 0) != nil {
		t.Fatal("an unrelated process was killed")
	}
	if n := signalPids([]int{outsider.Process.Pid}, "/sys/fs/cgroup/not-ours.scope/workload", syscall.SIGTERM); n != 0 {
		t.Fatalf("signaled %d processes outside the workload cgroup", n)
	}
	// A PID number that no longer exists (or was reused after we listed it) is never signaled by number.
	if n := signalPids([]int{999999999}, "/x", syscall.SIGKILL); n != 0 {
		t.Fatal("signaled a non-existent pid")
	}
}

func TestLimitsAreEnforced(t *testing.T) {
	if !cgroupAvailable(t) {
		return
	}
	// Memory: the command is OOM-killed inside its own cgroup, and reported as such.
	l := start(t, true, []string{"--cgroup=require", "--memory-mb=32"}, "sh", "-c", `exec awk 'BEGIN{s="x"; while(1) s=s s}'`)
	r, _ := l.wait(t)
	if r.Outcome != "oom" || r.Usage.OOMKills == 0 {
		t.Fatalf("memory: %+v", r)
	}
	// Process count: a fork loop hits pids.max, the command still ends and is reported.
	l = start(t, true, []string{"--cgroup=require", "--pids=16"}, "bash", "-c", `for i in $(seq 64); do sleep 5 & done 2>/dev/null; wait; exit 0`)
	r, _ = l.wait(t)
	if r.Usage.PidsMaxEvents == 0 || r.Survived != 0 {
		t.Fatalf("pids: %+v", r)
	}
	// CPU: a busy loop capped at 20% of a CPU is throttled.
	l = start(t, true, []string{"--cgroup=require", "--cpu-percent=20", "--timeout=1s", "--grace=0s"}, "sh", "-c", `while :; do :; done`)
	r, _ = l.wait(t)
	if r.Usage.CPUThrottledMs == 0 || r.Usage.CPUMs > 600 {
		t.Fatalf("cpu: %+v", r.Usage)
	}
	// rlimits (no cgroup needed): file size.
	dir := t.TempDir()
	l = start(t, false, []string{"--cgroup=none", "--fsize-mb=1"}, "sh", "-c", fmt.Sprintf(`head -c 3000000 /dev/zero > %s/big`, dir))
	r, _ = l.wait(t)
	if st, err := os.Stat(dir + "/big"); err != nil || st.Size() > 1<<20 {
		t.Fatalf("fsize: %+v %v", r, err)
	}
}

// Without a delegated cgroup the launcher refuses to run in require mode: the command never starts.
func TestMissingCgroupFailsClosed(t *testing.T) {
	dir := t.TempDir()
	l := start(t, false, []string{"--cgroup=require"}, "sh", "-c", fmt.Sprintf("touch %s/ran", dir))
	r, st := l.wait(t)
	if r.Outcome != "isolation_unavailable" || st.ExitCode() != ExitUnavailable {
		t.Fatalf("%+v %d", r, st.ExitCode())
	}
	if _, err := os.Stat(dir + "/ran"); err == nil {
		t.Fatal("the command ran without the required cgroup")
	}
}

// The launcher never buffers output: a slow consumer of a flood keeps the launcher's memory flat.
func TestOutputFloodWithSlowConsumer(t *testing.T) {
	self, _ := os.Executable()
	cmd := exec.Command(self, "--cgroup=none", "--", "sh", "-c", "head -c 300000000 /dev/zero")
	cmd.Env = append(os.Environ(), "CTP_SUPERVISE_HELPER=1")
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var peakKB int64
	var mu sync.Mutex
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", cmd.Process.Pid))
			if err != nil {
				continue
			}
			s := bufio.NewScanner(bytes.NewReader(b))
			for s.Scan() {
				if v, ok := strings.CutPrefix(s.Text(), "VmRSS:"); ok {
					kb, _ := strconv.ParseInt(strings.Fields(v)[0], 10, 64)
					mu.Lock()
					peakKB = max(peakKB, kb)
					mu.Unlock()
				}
			}
		}
	}()
	buf := make([]byte, 64<<10)
	var total int64
	for {
		n, err := out.Read(buf)
		total += int64(n)
		if err == io.EOF || err != nil {
			break
		}
		if total < 20<<20 {
			time.Sleep(time.Millisecond) // a slow consumer at first
		}
	}
	_ = cmd.Wait()
	close(stop)
	mu.Lock()
	defer mu.Unlock()
	if total != 300000000 || peakKB > 40<<10 {
		t.Fatalf("read %d bytes, launcher peak RSS %d KiB", total, peakKB)
	}
}

// Host-wide admission: with 2 slots, 5 concurrent launchers never run more than 2 commands at once; a launcher
// stopped while waiting ends without running its command.
func TestAdmissionBoundsConcurrencyAndCancelBeforeStart(t *testing.T) {
	adm := t.TempDir()
	dir := t.TempDir()
	flags := []string{"--cgroup=none", "--class=verification", "--slots=2", "--admission-dir=" + adm}
	script := fmt.Sprintf(`echo start $(date +%%s%%N) >> %[1]s/log; sleep 0.4; echo end $(date +%%s%%N) >> %[1]s/log`, dir)
	var ls []*launch
	for range 5 {
		ls = append(ls, start(t, false, flags, "sh", "-c", script))
	}
	var waited int64
	for _, l := range ls {
		r, _ := l.wait(t)
		waited += r.AdmissionWaitMs
	}
	b, _ := os.ReadFile(dir + "/log")
	running, peak := 0, 0
	type ev struct {
		at    int64
		delta int
	}
	var evs []ev
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		f := strings.Fields(line)
		at, _ := strconv.ParseInt(f[1], 10, 64)
		evs = append(evs, ev{at, map[string]int{"start": 1, "end": -1}[f[0]]})
	}
	for i := range evs {
		for j := i + 1; j < len(evs); j++ {
			if evs[j].at < evs[i].at {
				evs[i], evs[j] = evs[j], evs[i]
			}
		}
	}
	for _, e := range evs {
		running += e.delta
		peak = max(peak, running)
	}
	if peak != 2 || len(evs) != 10 || waited == 0 {
		t.Fatalf("peak %d events %d waited %d ms", peak, len(evs), waited)
	}
	// Both slots held; a third launcher waits and is canceled before its command starts.
	holders := []*launch{start(t, false, flags, "sleep", "2"), start(t, false, flags, "sleep", "2")}
	time.Sleep(200 * time.Millisecond)
	l := start(t, false, flags, "sh", "-c", fmt.Sprintf("touch %s/third", dir))
	time.Sleep(300 * time.Millisecond)
	_ = l.cmd.Process.Signal(syscall.SIGTERM)
	r, _ := l.wait(t)
	if r.Outcome != "canceled_before_start" {
		t.Fatalf("%+v", r)
	}
	if _, err := os.Stat(dir + "/third"); err == nil {
		t.Fatal("a canceled launcher ran its command")
	}
	for _, h := range holders {
		h.wait(t)
	}
}

// Only the launcher reads its OpenTelemetry endpoint; the command's environment never carries launcher variables.
func TestEnvironmentIsTheCommandsOwn(t *testing.T) {
	self, _ := os.Executable()
	cmd := exec.Command(self, "--cgroup=none", "--unset=DROP_ME", "--", "env")
	cmd.Env = append(os.Environ(), "CTP_SUPERVISE_HELPER=1", "CTP_SUPERVISE_SECRET=x", "DROP_ME=1", "KEEP_ME=1")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, "CTP_SUPERVISE_") || strings.Contains(s, "DROP_ME") || !strings.Contains(s, "KEEP_ME=1") {
		t.Fatalf("environment: %s", s)
	}
}
