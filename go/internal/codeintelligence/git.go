package codeintelligence

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

var extLanguage = map[string]string{
	"go": "go", "ts": "typescript", "tsx": "tsx", "js": "javascript", "jsx": "javascript",
	"mjs": "javascript", "cjs": "javascript", "proto": "proto", "sql": "sql",
}

// languageOf is p.split(".").pop() looked up in the extension table.
func languageOf(p string) string {
	return extLanguage[p[strings.LastIndexByte(p, '.')+1:]]
}

var (
	buildDir     = regexp.MustCompile(`^(?:\.git|dist|build|coverage)$`)
	dependencies = regexp.MustCompile(`^(?:node_modules|vendor)$`)
	generatedExt = regexp.MustCompile(`(?:\.pb\.go|\.gen\.|\.generated\.|\.min\.)`)
)

// eligible is eligible() of src/codeIntelligence/git.ts: indexed languages outside build output, dependencies,
// generated code and the configured exclusions.
func eligible(p string, lim Limits) bool {
	if languageOf(p) == "" {
		return false
	}
	parts := strings.Split(p, "/")
	for _, s := range parts {
		if buildDir.MatchString(s) || (!lim.IncludeDependencies && dependencies.MatchString(s)) {
			return false
		}
		if !lim.IncludeGenerated && s == "generated" {
			return false
		}
	}
	if !lim.IncludeGenerated && generatedExt.MatchString(p) {
		return false
	}
	for _, prefix := range lim.Excludes {
		if p == prefix || strings.HasPrefix(p, strings.TrimRight(prefix, "/")+"/") {
			return false
		}
	}
	return true
}

func gitOut(ctx context.Context, root string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.fsmonitor=false", "-C", root}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// stderr may carry paths or remote URLs: keep it out of persisted errors.
		return nil, fmt.Errorf("git %s failed: %w", args[0], err)
	}
	return out, nil
}

type treeFile struct {
	Path string
	Blob string
	Size int64
}

var lsTreeLine = regexp.MustCompile(`(?s)^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.*)$`)

// treeFiles lists the eligible blobs of commit sha (git ls-tree -rlz), within the configured scan limits.
func treeFiles(ctx context.Context, root, sha string, lim Limits, m *Metrics) ([]treeFile, error) {
	out, err := gitOut(ctx, root, "ls-tree", "-rlz", sha)
	if err != nil {
		return nil, err
	}
	var files []treeFile
	var total int64
	for _, line := range strings.Split(string(out), "\x00") {
		if line == "" {
			continue
		}
		mm := lsTreeLine.FindStringSubmatch(line)
		if mm != nil && (mm[1] == "100644" || mm[1] == "100755") && eligible(mm[4], lim) {
			size, _ := strconv.ParseInt(mm[3], 10, 64)
			if size <= int64(lim.MaxFileBytes) {
				files = append(files, treeFile{Path: mm[4], Blob: mm[2], Size: size})
				total += size
				continue
			}
		}
		m.SkippedFiles++
	}
	if len(files) > lim.MaxFiles || total > lim.MaxScanBytes {
		return nil, errors.New("Repository scan limit exceeded")
	}
	return files, nil
}

// blobReader streams objects from one long-lived `git cat-file --batch` process: memory stays bounded by one
// object, however large the repository.
type blobReader struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
	max int
}

var blobID = regexp.MustCompile(`^[a-f0-9]{40,64}$`)

func newBlobReader(ctx context.Context, root string, maxBytes int) (*blobReader, error) {
	cmd := exec.CommandContext(ctx, "git", "-c", "core.fsmonitor=false", "-C", root, "cat-file", "--batch")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &blobReader{cmd: cmd, in: in, out: bufio.NewReaderSize(out, 1<<16), max: maxBytes}, nil
}

// Read returns the decoded content of one blob (Buffer#toString("utf8") semantics).
func (r *blobReader) Read(blob string) (string, error) {
	if !blobID.MatchString(blob) {
		return "", errors.New("Invalid Git blob identity")
	}
	if _, err := io.WriteString(r.in, blob+"\n"); err != nil {
		return "", errors.New("Git object read failed")
	}
	header, err := r.out.ReadString('\n')
	if err != nil {
		return "", errors.New("Git object read failed")
	}
	f := strings.Fields(header)
	if len(f) != 3 || f[0] != blob || f[1] != "blob" {
		return "", errors.New("Invalid Git object response")
	}
	size, err := strconv.Atoi(f[2])
	if err != nil || size > r.max {
		return "", errors.New("Blob size limit exceeded")
	}
	buf := make([]byte, size+1)
	if _, err := io.ReadFull(r.out, buf); err != nil || buf[size] != '\n' {
		return "", errors.New("Invalid Git object response")
	}
	return decodeUTF8(buf[:size]), nil
}

func (r *blobReader) Close() {
	_ = r.in.Close()
	_ = r.cmd.Wait()
}

// change is one file of a worktree overlay; Content nil means deleted, masked or unreadable as source.
type change struct {
	Path    string
	Content *string
	Hash    string
}

// worktreeChanges is changes() of src/codeIntelligence/git.ts: committed, staged, unstaged and untracked eligible
// files relative to base, and a generation identifying exactly that state.
func worktreeChanges(ctx context.Context, root, base string, lim Limits) (head, generation string, files []change, err error) {
	h, err := gitOut(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return "", "", nil, err
	}
	head = strings.TrimSpace(string(h))
	diff, err := gitOut(ctx, root, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, "--")
	if err != nil {
		return "", "", nil, err
	}
	untracked, err := gitOut(ctx, root, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return "", "", nil, err
	}
	names := map[string]bool{}
	for _, p := range strings.Split(string(diff)+"\x00"+string(untracked), "\x00") {
		if p != "" {
			names[p] = true
		}
	}
	var paths []string
	for p := range names {
		if eligible(p, lim) {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths) // JS default sort compares UTF-16 code units; repository paths are ASCII in practice.
	if len(paths) > lim.MaxFiles {
		return "", "", nil, errors.New("Overlay file limit exceeded")
	}
	var bytesRead int64
	for _, p := range paths {
		content, rerr := readSource(root, p, lim.MaxFileBytes)
		if rerr != nil && !errors.Is(rerr, errSkippable) {
			return "", "", nil, rerr
		}
		c := change{Path: p, Hash: "masked"}
		if content != nil {
			c.Content, c.Hash = content, sha256Hex(*content)
			bytesRead += int64(len(*content))
		}
		if bytesRead > lim.MaxScanBytes {
			return "", "", nil, errors.New("Overlay scan limit exceeded")
		}
		files = append(files, c)
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(filepath.Join(root, ".git"), &st); err != nil {
		return "", "", nil, err
	}
	// JSON.stringify([head, marker.ino, marker.mtimeMs, files.map((f) => [f.path, f.hash])])
	mtimeMs := float64(st.Mtim.Sec)*1e3 + float64(st.Mtim.Nsec)/1e6
	var sb strings.Builder
	fmt.Fprintf(&sb, "[%s,%d,%s,[", jsonString(head), st.Ino, strconv.FormatFloat(mtimeMs, 'f', -1, 64))
	for i, f := range files {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, "[%s,%s]", jsonString(f.Path), jsonString(f.Hash))
	}
	sb.WriteString("]]")
	return head, sha256Hex(sb.String()), files, nil
}

// jsonString is JSON.stringify for a string.
func jsonString(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			sb.WriteString(`\"`)
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '\b':
			sb.WriteString(`\b`)
		case r == '\f':
			sb.WriteString(`\f`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r == '\t':
			sb.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(&sb, `\u%04x`, r)
		default:
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

var errSkippable = errors.New("source not readable as a regular file")

// readSource is readSource() of src/codeIntelligence/git.ts: no symlink component, O_NOFOLLOW on the final open,
// a /proc check against races, and nil for oversized or binary files. Missing files and symlinks are skippable.
func readSource(root, p string, maxBytes int) (*string, error) {
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	full := filepath.Join(canonical, p)
	rel, err := filepath.Rel(canonical, full)
	if p == "" || path.IsAbs(p) || strings.ContainsRune(p, 0) || err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return nil, errors.New("Unsafe source path")
	}
	cursor := canonical
	for _, part := range strings.Split(rel, "/") {
		cursor = filepath.Join(cursor, part)
		fi, err := os.Lstat(cursor)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
				return nil, errSkippable
			}
			return nil, err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return nil, errSkippable
		}
	}
	fd, err := syscall.Open(full, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ELOOP) {
			return nil, errSkippable
		}
		return nil, err
	}
	f := os.NewFile(uintptr(fd), full)
	defer f.Close()
	if opened, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(fd)); err == nil && opened != full {
		return nil, errSkippable
	}
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > int64(maxBytes) {
		return nil, nil
	}
	b, err := io.ReadAll(io.LimitReader(f, int64(maxBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxBytes || bytes.IndexByte(b, 0) >= 0 {
		return nil, nil
	}
	s := decodeUTF8(b)
	return &s, nil
}
