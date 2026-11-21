package knowledge

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"

	"claude-task-platform/go/internal/jsstr"
)

// Limits bound one scan (ScanRequest.limits); the same values as SCAN_LIMITS of the TypeScript engine.
type Limits struct {
	MaxFileBytes  int `json:"max_file_bytes"`
	MaxEntries    int `json:"max_entries"`
	MaxTotalBytes int `json:"max_total_bytes"`
	DeadlineMs    int `json:"deadline_ms"`
	MaxChars      int `json:"max_chars"`
}

// budget is shared by every tree of one scan.
type budget struct {
	ctx     context.Context // its deadline is the scan's
	lim     Limits
	bytes   int
	files   int
	entries int
}

// Skipped is one ImportReport.skipped row.
type Skipped struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// tree is SourceTree of importer.ts: the files of one source root, read safely. Symlinks are followed only when
// their target stays inside the root; a file is opened without following a final symlink and its descriptor is
// re-checked through /proc (a component swapped after the check cannot escape); reads are bounded before allocation.
// Directory entries come in byte order, as Node's readdir returns them.
type tree struct {
	root, label, real string
	skipped           *[]Skipped
	b                 *budget
	incomplete        bool
	stopped           bool // a budget is spent
	failures          int  // read failures (not absences), see failed
	entries           int
}

func newTree(root, label string, skipped *[]Skipped, b *budget) (*tree, error) {
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	return &tree{root: root, label: label, real: real, skipped: skipped, b: b}, nil
}

func (t *tree) inside(p string) bool { return p == t.real || strings.HasPrefix(p, t.real+"/") }

func (t *tree) shown(file string) string { return t.label + "/" + rel(t.root, file) }

func (t *tree) skip(file, reason string) {
	*t.skipped = append(*t.skipped, Skipped{Path: t.shown(file), Reason: reason})
}

// exhausted: a budget is spent (entries, total bytes, deadline) and the scan stops here; a read failure only makes it
// incomplete (a canceled request ends the scan elsewhere).
func (t *tree) exhausted() bool {
	if t.b.bytes > t.b.lim.MaxTotalBytes || t.b.ctx.Err() != nil {
		t.stopped = true
	}
	if t.stopped {
		t.incomplete = true
	}
	return t.stopped
}

// absent: the error says the path is gone (ENOENT, ENOTDIR, a symlink loop) — a legitimate deletion.
func absent(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ELOOP) ||
		strings.Contains(err.Error(), "too many links") // filepath.EvalSymlinks' own loop error
}

// errnoName is the error's code as Node reports it (EACCES, EIO, EMFILE…); EIO when there is none.
func errnoName(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name := unix.ErrnoName(errno); name != "" {
			return name
		}
	}
	return "EIO"
}

// failed is SourceTree.failed: an absence returns quietly; any other error makes the scan incomplete and is
// reported, so nothing of this repository is retired.
func (t *tree) failed(p string, err error) {
	if absent(err) {
		return
	}
	t.incomplete = true
	t.failures++
	t.skip(p, "unreadable ("+errnoName(err)+")")
}

// exists is SourceTree.exists.
func (t *tree) exists(p string) bool {
	if _, err := os.Stat(p); err != nil {
		t.failed(p, err)
		return false
	}
	return true
}

// list is SourceTree.list: entries in byte order; none when absent or unreadable (the latter incomplete).
func (t *tree) list(dir string) []os.DirEntry {
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.failed(dir, err)
		return nil
	}
	return entries
}

// resolve is the real path of p when it exists and stays inside the root.
func (t *tree) resolve(p string) (string, bool) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.failed(p, err)
		return "", false
	}
	if !t.inside(real) {
		return "", false
	}
	return real, true
}

// pointsOutside: p resolves to an existing path outside the root.
func (t *tree) pointsOutside(p string) bool {
	real, err := filepath.EvalSymlinks(p)
	return err == nil && !t.inside(real)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// walk is SourceTree.walk(dir, depth).
func (t *tree) walk(dir string, depth int) []string {
	if depth < 0 || t.exhausted() {
		return nil
	}
	var out []string
	for _, e := range t.list(dir) {
		name := e.Name()
		if name == "node_modules" || name == ".git" || name == "vendor" {
			continue
		}
		t.entries++
		t.b.entries++
		if t.entries > t.b.lim.MaxEntries {
			t.stopped = true
		}
		if t.exhausted() {
			break
		}
		p := filepath.Join(dir, name)
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			target, ok := t.resolve(p)
			if !ok {
				if t.pointsOutside(p) {
					t.skip(p, "symlink outside the repository")
				}
				continue
			}
			st, err := os.Stat(target)
			if err != nil {
				t.failed(p, err)
				continue
			}
			isDir = st.IsDir()
		}
		if isDir {
			out = append(out, t.walk(p, depth-1)...)
		} else {
			out = append(out, p)
		}
	}
	return out
}

// readRaw is SourceTree.readRaw(file): the decoded text, or ok=false (reported where the TypeScript engine reports).
func (t *tree) readRaw(file string) (string, bool) {
	if t.exhausted() {
		t.skip(file, "scan stopped: time or size budget exhausted")
		return "", false
	}
	real, ok := t.resolve(file)
	if !ok {
		if t.pointsOutside(file) {
			t.skip(file, "symlink outside the repository")
		}
		return "", false
	}
	fd, err := syscall.Open(real, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.failed(file, err)
		return "", false
	}
	f := os.NewFile(uintptr(fd), real)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.failed(file, err)
		return "", false
	}
	opened, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(fd))
	if err != nil {
		t.failed(file, err)
		return "", false
	}
	// The descriptor, not the path: a component swapped for a symlink after resolve() is caught here.
	if !st.Mode().IsRegular() || !t.inside(opened) {
		return "", false
	}
	limit := min(st.Size(), int64(t.b.lim.MaxFileBytes)) + 1
	buf := make([]byte, limit)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		t.failed(file, err)
		return "", false
	}
	if n > t.b.lim.MaxFileBytes {
		t.skip(file, "larger than "+strconv.Itoa(t.b.lim.MaxFileBytes)+" bytes")
		return "", false
	}
	t.b.bytes += n
	t.b.files++
	return jsstr.DecodeUTF8(buf[:n]), true
}

var skipPath = []func(string) bool{
	func(r string) bool { return containsFold(r, "env-production") },
	func(r string) bool { return containsFold(r, ".env") },
	func(r string) bool { return containsFold(r, "secret") },
	func(r string) bool {
		return strings.Contains(r, "superpowers/plans/") || strings.Contains(r, "superpowers/specs/")
	},
	func(r string) bool { return strings.Contains(r, "/node_modules/") },
	func(r string) bool { return strings.Contains(r, "/vendor/") },
}

// containsFold is a JS /…/i search for an ASCII pattern.
func containsFold(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if hasPrefixFold(s[i:], sub) {
			return true
		}
	}
	return false
}

// read is SourceTree.read(file): excluded paths, credentials and empty files are skipped (and reported), longer
// files truncated to MaxChars UTF-16 units.
func (t *tree) read(file string) (string, bool) {
	r := rel(t.root, file)
	for _, f := range skipPath {
		if f(r) {
			t.skip(file, "path excluded (env/secret/task plan)")
			return "", false
		}
	}
	text, ok := t.readRaw(file)
	if !ok || jsstr.Trim(text) == "" {
		return "", false
	}
	if looksSecret(text) {
		t.skip(file, "looks like it contains credentials")
		return "", false
	}
	if len(text) > t.b.lim.MaxChars && jsstr.LenUTF16(text) > t.b.lim.MaxChars {
		t.skip(file, "truncated to "+strconv.Itoa(t.b.lim.MaxChars)+" chars")
	}
	return jsstr.SliceUTF16(text, t.b.lim.MaxChars), true
}

// rel is path.relative(root, file) for a file below root.
func rel(root, file string) string {
	r, err := filepath.Rel(root, file)
	if err != nil {
		return file
	}
	return r
}
