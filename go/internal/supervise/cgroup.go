package supervise

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const cgroupRoot = "/sys/fs/cgroup"

// Cgroup is the workload's leaf cgroup inside the launcher's own delegated scope:
//
//	<scope>/supervisor   the launcher (cgroup v2 forbids processes in a cgroup that delegates controllers)
//	<scope>/workload     the command and every descendant, with the limits; created with CLONE_INTO_CGROUP
//
// Cleanup is cgroup.kill: the kernel kills every process of the leaf, including ones that called setsid, were
// reparented or reused a PID number, so nothing outside it can ever be signaled.
type Cgroup struct {
	Dir string // the workload leaf
	fd  *os.File
}

// ownScope is the launcher's cgroup when it is a dedicated scope holding nothing but the launcher itself (it was
// started by `systemd-run --user --scope -p Delegate=yes`). Anything else — the platform's own cgroup, a shared
// slice — is never touched.
func ownScope() (string, error) {
	raw, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	var path string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if p, ok := strings.CutPrefix(line, "0::"); ok {
			path = p
		}
	}
	if path == "" || !strings.HasSuffix(path, ".scope") {
		return "", fmt.Errorf("not in a dedicated cgroup v2 scope (%q)", path)
	}
	dir := filepath.Join(cgroupRoot, path)
	procs, err := readPids(filepath.Join(dir, "cgroup.procs"))
	if err != nil {
		return "", err
	}
	if !slices.Equal(procs, []int{os.Getpid()}) {
		return "", fmt.Errorf("scope %s holds other processes %v", path, procs)
	}
	return dir, nil
}

// SetupCgroup moves the launcher to <scope>/supervisor, delegates memory, pids and (if available) cpu to the scope's children and
// creates <scope>/workload with the limits. Any failure leaves the scope unchanged enough for the caller to fall
// back (cgroup=auto) or refuse to run (cgroup=require).
func SetupCgroup(l Limits) (*Cgroup, error) {
	scope, err := ownScope()
	if err != nil {
		return nil, err
	}
	sup := filepath.Join(scope, "supervisor")
	if err := os.Mkdir(sup, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(sup, "cgroup.procs"), []byte(strconv.Itoa(os.Getpid())), 0); err != nil {
		return nil, fmt.Errorf("move launcher: %w", err)
	}
	avail, err := os.ReadFile(filepath.Join(scope, "cgroup.controllers"))
	if err != nil {
		return nil, err
	}
	have := strings.Fields(string(avail))
	var enable []string
	for _, c := range []string{"memory", "pids", "cpu"} {
		if slices.Contains(have, c) {
			enable = append(enable, "+"+c)
		}
	}
	if err := os.WriteFile(filepath.Join(scope, "cgroup.subtree_control"), []byte(strings.Join(enable, " ")), 0); err != nil {
		return nil, fmt.Errorf("delegate controllers: %w", err)
	}
	dir := filepath.Join(scope, "workload")
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	set := func(file, value string) error {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(value), 0); err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		return nil
	}
	if l.MemoryMB > 0 {
		if err := set("memory.max", strconv.FormatInt(l.MemoryMB<<20, 10)); err != nil {
			return nil, err
		}
		if err := set("memory.swap.max", "0"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	if l.Pids > 0 {
		if err := set("pids.max", strconv.Itoa(l.Pids)); err != nil {
			return nil, err
		}
	}
	// user@.service often delegates only memory and pids (WSL2); the CPU quota is then skipped, cpu-seconds still applies.
	if l.CPUPercent > 0 && slices.Contains(have, "cpu") {
		// cpu.max: quota per 100 ms period; 100% = one CPU.
		if err := set("cpu.max", fmt.Sprintf("%d 100000", l.CPUPercent*1000)); err != nil {
			return nil, err
		}
	}
	fd, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	return &Cgroup{Dir: dir, fd: fd}, nil
}

// FD is the leaf's directory descriptor for CLONE_INTO_CGROUP.
func (c *Cgroup) FD() int { return int(c.fd.Fd()) }

// Pids of every process in the workload.
func (c *Cgroup) Pids() []int {
	p, _ := readPids(filepath.Join(c.Dir, "cgroup.procs"))
	return p
}

// Kill kills every process in the workload and waits (bounded) until it is empty.
func (c *Cgroup) Kill(wait time.Duration) error {
	if err := os.WriteFile(filepath.Join(c.Dir, "cgroup.kill"), []byte("1"), 0); err != nil {
		return err
	}
	return c.waitEmpty(wait)
}

func (c *Cgroup) waitEmpty(wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for {
		if !c.populated() {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("workload cgroup still populated")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (c *Cgroup) populated() bool {
	return keyValue(filepath.Join(c.Dir, "cgroup.events"))["populated"] == 1
}

// Usage reads what the workload consumed (kernel accounting, no sampling).
func (c *Cgroup) Usage() Usage {
	u := Usage{}
	if b, err := os.ReadFile(filepath.Join(c.Dir, "memory.peak")); err == nil {
		u.MemoryPeakBytes, _ = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	}
	ev := keyValue(filepath.Join(c.Dir, "memory.events"))
	u.OOMKills, u.MemoryMaxEvents = ev["oom_kill"], ev["max"]
	cpu := keyValue(filepath.Join(c.Dir, "cpu.stat"))
	u.CPUMs, u.CPUThrottledMs, u.CPUThrottledPeriods = cpu["usage_usec"]/1000, cpu["throttled_usec"]/1000, cpu["nr_throttled"]
	u.PidsMaxEvents = keyValue(filepath.Join(c.Dir, "pids.events"))["max"]
	u.PSI = PSI{
		CPUSomeMs:    psiTotal(filepath.Join(c.Dir, "cpu.pressure")),
		MemorySomeMs: psiTotal(filepath.Join(c.Dir, "memory.pressure")),
		IOSomeMs:     psiTotal(filepath.Join(c.Dir, "io.pressure")),
	}
	return u
}

// Remove deletes the (empty) leaf and supervisor cgroups; systemd collects the scope when the launcher exits.
func (c *Cgroup) Remove() {
	_ = c.fd.Close()
	_ = syscall.Rmdir(c.Dir)
}

func readPids(path string) ([]int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []int
	s := bufio.NewScanner(f)
	for s.Scan() {
		if n, err := strconv.Atoi(strings.TrimSpace(s.Text())); err == nil {
			out = append(out, n)
		}
	}
	return out, s.Err()
}

func keyValue(path string) map[string]int64 {
	out := map[string]int64{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), " ")
		if ok {
			out[k], _ = strconv.ParseInt(v, 10, 64)
		}
	}
	return out
}

// psiTotal is the "some" stall total of a pressure file, in milliseconds (the kernel reports microseconds).
func psiTotal(path string) int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "some ") {
			continue
		}
		for _, f := range strings.Fields(line) {
			if v, ok := strings.CutPrefix(f, "total="); ok {
				n, _ := strconv.ParseInt(v, 10, 64)
				return n / 1000
			}
		}
	}
	return 0
}

// SystemPressure is the host's avg10 "some" stall percentage for cpu, memory and io (/proc/pressure).
func SystemPressure() (cpu, memory, io float64) {
	read := func(name string) float64 {
		b, err := os.ReadFile("/proc/pressure/" + name)
		if err != nil {
			return 0
		}
		for _, f := range strings.Fields(strings.SplitN(string(b), "\n", 2)[0]) {
			if v, ok := strings.CutPrefix(f, "avg10="); ok {
				x, _ := strconv.ParseFloat(v, 64)
				return x
			}
		}
		return 0
	}
	return read("cpu"), read("memory"), read("io")
}
