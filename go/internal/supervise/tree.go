package supervise

import (
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Without a delegated cgroup the launcher is a child subreaper (PR_SET_CHILD_SUBREAPER): a descendant that
// double-forks or calls setsid is reparented to the launcher instead of init, so the launcher's process tree
// (/proc/<pid>/task/<tid>/children) is complete. Signals go through pidfds opened while the process is verified to
// be a child of a member of that tree: a PID number reused by an unrelated process is never signaled.

// descendants of the launcher, children before grandchildren.
func descendants() []int {
	var out []int
	queue := []int{os.Getpid()}
	seen := map[int]bool{}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		for _, c := range children(pid) {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
				queue = append(queue, c)
			}
		}
	}
	return out
}

func children(pid int) []int {
	tasks, err := os.ReadDir("/proc/" + strconv.Itoa(pid) + "/task")
	if err != nil {
		return nil
	}
	var out []int
	for _, t := range tasks {
		b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/task/" + t.Name() + "/children")
		if err != nil {
			continue
		}
		for _, f := range strings.Fields(string(b)) {
			if n, err := strconv.Atoi(f); err == nil {
				out = append(out, n)
			}
		}
	}
	return out
}

func parentOf(pid int) int {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return -1
	}
	s := string(b)
	fields := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
	if len(fields) < 2 {
		return -1
	}
	n, _ := strconv.Atoi(fields[1])
	return n
}

// signalTree signals every descendant of the launcher; returns how many were signaled.
func signalTree(sig unix.Signal) int {
	tree := descendants()
	member := map[int]bool{os.Getpid(): true}
	for _, p := range tree {
		member[p] = true
	}
	n := 0
	for _, pid := range tree {
		fd, err := unix.PidfdOpen(pid, 0)
		if err != nil {
			continue // already gone
		}
		// The pidfd pins the process identity; re-check it is still inside the tree before signaling.
		if member[parentOf(pid)] && unix.PidfdSendSignal(fd, sig, nil, 0) == nil {
			n++
		}
		_ = unix.Close(fd)
	}
	return n
}

// signalPids signals the given workload pids through pidfds, re-checking cgroup membership after opening each.
func signalPids(pids []int, cgroupPath string, sig unix.Signal) int {
	n := 0
	for _, pid := range pids {
		fd, err := unix.PidfdOpen(pid, 0)
		if err != nil {
			continue
		}
		if inCgroup(pid, cgroupPath) && unix.PidfdSendSignal(fd, sig, nil, 0) == nil {
			n++
		}
		_ = unix.Close(fd)
	}
	return n
}

func inCgroup(pid int, dir string) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return false
	}
	rel := strings.TrimPrefix(dir, cgroupRoot)
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if p, ok := strings.CutPrefix(line, "0::"); ok && p == rel {
			return true
		}
	}
	return false
}
