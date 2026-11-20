package knowledge

import (
	"context"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"claude-task-platform/go/internal/jsstr"
)

// Repository is one repository TypeScript selected and authorized for the scan.
type Repository struct {
	Name string `json:"name"`
	Root string `json:"root"`
	Self bool   `json:"self"`
}

// Target is where a candidate applies; TypeScript resolves it (assembleCandidates) — scope, applicability and the
// enable policy of user skills are never decided here.
type Target struct {
	Kind  string   `json:"kind"` // repository | repositories | wiki_siblings | wiki_projects | user_skill
	Repo  string   `json:"repo,omitempty"`
	Repos []string `json:"repos,omitempty"`
	Name  string   `json:"name,omitempty"`
}

// Source is one entry of a candidate's source list.
type Source struct {
	Repo   string `json:"repo"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// Candidate is a DiscoveredCandidate of importTypes.ts.
type Candidate struct {
	Key      string         `json:"key"`
	Category string         `json:"category"`
	Title    string         `json:"title"`
	Content  string         `json:"content"`
	Metadata map[string]any `json:"metadata"`
	Source   []Source       `json:"source"`
	Target   Target         `json:"target"`
}

// Discovery is the scan's result (ScanResponse without metrics).
type Discovery struct {
	Candidates []Candidate `json:"candidates"`
	Skipped    []Skipped   `json:"skipped"`
	Scanned    []string    `json:"scanned"`
	Incomplete []string    `json:"incomplete"`
}

// Metrics of one scan.
type Metrics struct {
	FilesRead int   `json:"files_read"`
	BytesRead int   `json:"bytes_read"`
	Entries   int   `json:"entries"`
	TookMs    int64 `json:"took_ms"`
}

var (
	wikiName   = regexp.MustCompile(`(?i)wiki`)
	wikiExtra  = []*regexp.Regexp{regexp.MustCompile(`^\.inventory/conflicts\.md$`)}
	wikiSkip   = []string{"changelog", "build-docs", "reference/links", "frontend-demo"}
	docsDir    = regexp.MustCompile(`(^|/)docs/`)
	companion  = regexp.MustCompile(`(?i)\.(md|txt|py|sh|ts|js|mjs|json|ya?ml|go|sql)$`)
	textFile   = regexp.MustCompile(`(?i)\.(md|txt)$`)
	convention = func(name string) bool { return containsFold(name, "convention") }
)

func wikiSkipped(rel string) bool {
	for _, s := range wikiSkip {
		if containsFold(rel, s) {
			return true
		}
	}
	return hasSuffixFold(rel, "authoring.md")
}

// trimMdFold is s.replace(/\.md$/i, "").
func trimMdFold(s string) string {
	if hasSuffixFold(s, ".md") {
		return s[:len(s)-3]
	}
	return s
}

type skillGroup struct {
	name, text string
	companions []companionFile
	repos      []string
	paths      []string
}

type companionFile struct{ rel, text string }

// Discover is discoverKnowledge() of importer.ts. ctx carries the scan deadline (budget) and the request's
// cancellation; a canceled request returns ctx.Err().
func Discover(ctx context.Context, repos []Repository, userDir string, lim Limits) (Discovery, Metrics, error) {
	start := time.Now()
	scanCtx, cancel := context.WithTimeout(ctx, time.Duration(lim.DeadlineMs)*time.Millisecond)
	defer cancel()
	b := &budget{ctx: scanCtx, lim: lim}
	d := Discovery{Candidates: []Candidate{}, Skipped: []Skipped{}, Scanned: []string{}, Incomplete: []string{}}
	var groups []*skillGroup
	byID := map[string]*skillGroup{}

	for _, r := range repos {
		if ctx.Err() != nil {
			return d, Metrics{}, ctx.Err()
		}
		root := r.Root
		t, err := newTree(root, r.Name, &d.Skipped, b)
		if err != nil {
			d.Incomplete = append(d.Incomplete, r.Name)
			continue
		}
		src := func(file, text string) []Source {
			return []Source{{Repo: r.Name, Path: rel(root, file), SHA256: jsstr.Sha256Hex(text)}}
		}
		isWiki := wikiName.MatchString(r.Name)
		here := Target{Kind: "repository", Repo: r.Name}

		// 1. Agent instructions / conventions (identical copies once).
		seen := map[string]bool{}
		for _, f := range []string{"CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules"} {
			file := filepath.Join(root, f)
			if !exists(file) {
				continue
			}
			text, ok := t.read(file)
			if !ok || seen[jsstr.Sha256Hex(text)] {
				continue
			}
			seen[jsstr.Sha256Hex(text)] = true
			d.Candidates = append(d.Candidates, Candidate{
				Key: slug(r.Name + "." + trimMdFold(f)), Category: "repository_convention",
				Title: r.Name + ": " + f, Content: text,
				Metadata: map[string]any{"load": "inline", "description": firstParagraph(text)},
				Source:   src(file, text), Target: here,
			})
		}
		for _, file := range t.walk(filepath.Join(root, "docs"), 1) {
			if !convention(filepath.Base(file)) || !strings.HasSuffix(file, ".md") {
				continue
			}
			text, ok := t.read(file)
			if !ok {
				continue
			}
			target := here
			if isWiki {
				target = Target{Kind: "wiki_siblings", Repo: r.Name}
			}
			d.Candidates = append(d.Candidates, Candidate{
				Key: slug(r.Name + "." + strings.TrimSuffix(filepath.Base(file), ".md")), Category: "repository_convention",
				Title: r.Name + ": " + headingOr(text, filepath.Base(file)), Content: text,
				Metadata: map[string]any{"load": "inline", "description": firstParagraph(text)},
				Source:   src(file, text), Target: target,
			})
		}

		// 2. Skills (.claude preferred over .agents for the same name).
		inRepo := map[string]bool{}
		for _, base := range []string{".claude/skills", ".agents/skills"} {
			dir := filepath.Join(root, base)
			names, err := readNames(dir)
			if err != nil {
				continue
			}
			for _, name := range names {
				if inRepo[name] {
					continue
				}
				file := ""
				for _, f := range []string{"SKILL.md", name + ".md"} {
					if p := filepath.Join(dir, name, f); exists(p) {
						file = p
						break
					}
				}
				if file == "" {
					continue
				}
				text, ok := t.read(file)
				if !ok {
					continue
				}
				inRepo[name] = true
				comps := skillCompanions(t, filepath.Join(dir, name), file)
				id := name + "\x00" + jsstr.Sha256Hex(text) + "\x00" + companionsID(comps)
				g := byID[id]
				if g == nil {
					g = &skillGroup{name: name, text: text, companions: comps}
					byID[id] = g
					groups = append(groups, g)
				}
				g.repos = append(g.repos, r.Name)
				g.paths = append(g.paths, rel(root, file))
			}
		}

		// 3. Cursor rules.
		for _, file := range t.walk(filepath.Join(root, ".cursor", "rules"), 1) {
			if !strings.HasSuffix(file, ".mdc") && !strings.HasSuffix(file, ".md") {
				continue
			}
			text, ok := t.read(file)
			if !ok {
				continue
			}
			fields, body := frontmatter(text)
			base := filepath.Base(file) // .replace(/\.mdc?$/, "")
			if b, ok := strings.CutSuffix(base, ".mdc"); ok {
				base = b
			} else {
				base = strings.TrimSuffix(base, ".md")
			}
			load := "on_demand"
			if fields["alwaysApply"] == "true" {
				load = "inline"
			}
			desc := fields["description"]
			if desc == "" {
				desc = firstParagraph(body)
			}
			var globs any
			if g, ok := fields["globs"]; ok {
				globs = g
			}
			d.Candidates = append(d.Candidates, Candidate{
				Key: slug(r.Name + ".rule." + base), Category: "coding_standard",
				Title: r.Name + ": " + headingOr(body, filepath.Base(file)), Content: jsstr.Trim(body),
				Metadata: map[string]any{"load": load, "description": desc, "globs": globs},
				Source:   src(file, text), Target: here,
			})
		}

		// This installation's own checkout: its architecture and integration notes, on demand.
		if r.Self {
			for _, file := range t.walk(filepath.Join(root, "docs"), 3) {
				if !strings.HasSuffix(file, ".md") || convention(filepath.Base(file)) {
					continue
				}
				rp := rel(root, file)
				if !strings.HasPrefix(rp, "docs/architecture/") && !strings.HasPrefix(rp, "docs/integrations/") &&
					rp != "docs/frontend/ui-quality-standards.md" {
					continue
				}
				text, ok := t.read(file)
				if !ok {
					continue
				}
				category := "domain_knowledge"
				if strings.HasPrefix(rp, "docs/architecture/") {
					category = "architecture_guideline"
				} else if rp == "docs/frontend/ui-quality-standards.md" {
					category = "coding_standard"
				}
				d.Candidates = append(d.Candidates, Candidate{
					Key: slug(r.Name + "." + strings.ReplaceAll(strings.TrimSuffix(rp, ".md"), "/", ".")), Category: category,
					Title: r.Name + ": " + headingOr(text, filepath.Base(file)), Content: text,
					Metadata: map[string]any{"load": "on_demand", "description": firstParagraph(text)},
					Source:   src(file, text), Target: here,
				})
			}
		}

		// 4. Wiki repositories: docs for the whole project, on demand.
		if isWiki {
			for _, file := range t.walk(root, 4) {
				rp := rel(root, file)
				if !strings.HasSuffix(rp, ".md") || !(docsDir.MatchString(rp) || wikiExtra[0].MatchString(rp)) {
					continue
				}
				if wikiSkipped(rp) {
					continue
				}
				if docsDir.MatchString(rp) && convention(filepath.Base(file)) &&
					len(strings.Split(rel(filepath.Join(root, "docs"), file), "/")) <= 2 {
					continue // imported above as a convention
				}
				text, ok := t.read(file)
				if !ok {
					continue
				}
				category := "domain_knowledge"
				if containsFold(rp, "architecture") {
					category = "architecture_guideline"
				}
				d.Candidates = append(d.Candidates, Candidate{
					Key:      slug(r.Name + "." + strings.ReplaceAll(strings.TrimSuffix(strings.TrimPrefix(rp, "."), ".md"), "/", ".")),
					Category: category, Title: r.Name + ": " + headingOr(text, rp), Content: text,
					Metadata: map[string]any{"load": "on_demand", "description": firstParagraph(text)},
					Source:   src(file, text), Target: Target{Kind: "wiki_projects", Repo: r.Name},
				})
			}
		}
		if t.incomplete {
			d.Incomplete = append(d.Incomplete, r.Name)
		} else {
			d.Scanned = append(d.Scanned, r.Name)
		}
	}
	if ctx.Err() != nil {
		return d, Metrics{}, ctx.Err()
	}

	// User-level skills; copies of repository skills only widen that skill.
	repoHashes := map[string]bool{}
	for _, g := range groups {
		repoHashes[jsstr.Sha256Hex(g.text)] = true
	}
	userHashes := map[string]bool{}
	if userDir != "" && exists(userDir) {
		t, err := newTree(userDir, "~/.claude/skills", &d.Skipped, b)
		names, _ := readNames(userDir)
		for _, name := range names {
			if err != nil {
				break
			}
			text, ok := t.readRaw(filepath.Join(userDir, name, "SKILL.md"))
			if !ok {
				continue
			}
			h := jsstr.Sha256Hex(text)
			if repoHashes[h] {
				userHashes[h] = true
				continue
			}
			if looksSecret(text) {
				d.Skipped = append(d.Skipped, Skipped{Path: "~/.claude/skills/" + name + "/SKILL.md", Reason: "looks like it contains credentials"})
				continue
			}
			fields, body := frontmatter(text)
			title := fields["name"]
			if title == "" {
				title = name
			}
			desc := fields["description"]
			if desc == "" {
				desc = firstParagraph(body)
			}
			d.Candidates = append(d.Candidates, Candidate{
				Key: slug("user.skill." + name), Category: "agent_skill", Title: "Skill: " + title,
				Content:  jsstr.SliceUTF16(jsstr.Trim(body), lim.MaxChars),
				Metadata: map[string]any{"load": "on_demand", "description": jsstr.SliceUTF16(desc, 600), "origin": "user"},
				Source:   []Source{{Repo: "~/.claude", Path: "skills/" + name + "/SKILL.md", SHA256: h}},
				Target:   Target{Kind: "user_skill", Name: name},
			})
		}
	}

	// Skills: identical copies across repositories → one item for all of them.
	variants := map[string]int{}
	for _, g := range groups {
		variants[g.name]++
	}
	for _, g := range groups {
		target := Target{Kind: "repositories", Repos: g.repos}
		if userHashes[jsstr.Sha256Hex(g.text)] {
			target = Target{Kind: "user_skill", Name: g.name}
		}
		key, suffix := slug("skill."+g.name), ""
		if variants[g.name] > 1 {
			key, suffix = slug("skill."+g.name+"."+g.repos[0]), " ("+strings.Join(g.repos, ", ")+")"
		}
		var sources []skillSource
		for i, repo := range g.repos {
			sources = append(sources, skillSource{repo: repo, dir: path.Dir(g.paths[i]), mainFile: path.Base(g.paths[i])})
		}
		for _, c := range skillCandidates(key, g.name, g.text, g.companions, suffix, sources) {
			c.Target = target
			d.Candidates = append(d.Candidates, c)
		}
	}
	return d, Metrics{FilesRead: b.files, BytesRead: b.bytes, Entries: b.entries, TookMs: time.Since(start).Milliseconds()}, nil
}

// readNames is readdirSync(dir): every entry name, in byte order.
func readNames(dir string) ([]string, error) {
	list, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(list))
	for i, e := range list {
		names[i] = e.Name()
	}
	return names, nil
}

// headingOr is firstHeading(text) ?? fallback (an empty heading is kept: `??` only replaces a missing one).
func headingOr(text, fallback string) string {
	if h, ok := firstHeading(text); ok {
		return h
	}
	return fallback
}

func companionsID(cs []companionFile) string {
	var b strings.Builder
	for _, c := range cs {
		b.WriteString(jsstr.Sha256Hex(c.rel))
		b.WriteString(jsstr.Sha256Hex(c.text))
	}
	return jsstr.Sha256Hex(b.String())
}

// skillCompanions is readSkillCompanions(): supporting files next to a skill's main file, sorted by path.
func skillCompanions(t *tree, skillDir, mainFile string) []companionFile {
	files := slices.DeleteFunc(t.walk(skillDir, 3), func(f string) bool {
		return f == mainFile || !companion.MatchString(f)
	})
	slices.SortFunc(files, compareUTF16)
	var out []companionFile
	for _, f := range files {
		if text, ok := t.read(f); ok && text != "" {
			out = append(out, companionFile{rel: rel(skillDir, f), text: text})
		}
	}
	return out
}

// compareUTF16 is Array#sort's default order (UTF-16 code units), which differs from byte order only for
// characters above U+FFFF against U+E000–U+FFFF.
func compareUTF16(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	unit := func(r rune) []uint16 {
		if r >= 0x10000 {
			r -= 0x10000
			return []uint16{uint16(0xD800 + (r >> 10)), uint16(0xDC00 + (r & 0x3FF))}
		}
		return []uint16{uint16(r)}
	}
	var ua, ub []uint16
	for _, r := range ra {
		ua = append(ua, unit(r)...)
	}
	for _, r := range rb {
		ub = append(ub, unit(r)...)
	}
	return slices.Compare(ua, ub)
}

type skillSource struct{ repo, dir, mainFile string }

func joinNonEmpty(parts ...string) string {
	return strings.Join(slices.DeleteFunc(parts, func(s string) bool { return s == "" }), "/")
}

// skillCandidates is skillCandidates() of importer.ts without scope (the caller sets the target).
func skillCandidates(key, name, text string, comps []companionFile, titleSuffix string, sources []skillSource) []Candidate {
	fields, body := frontmatter(text)
	display := fields["name"]
	if display == "" {
		display = name
	}
	companionKey := func(r string) string { return slug(key + "." + strings.ReplaceAll(trimMdFold(r), "/", ".")) }
	footer := ""
	if len(comps) > 0 {
		var lines []string
		for _, c := range comps {
			line := "- `" + c.rel + "` → `read_knowledge key=" + companionKey(c.rel) + "`"
			if !textFile.MatchString(c.rel) {
				line += " (script: write it to a temporary file before running it)"
			}
			lines = append(lines, line)
		}
		footer = "\n\n---\n## Supporting files (knowledge registry)\n\nThis skill's files are stored in the knowledge registry, not on disk. Where the text above links to one of these paths, load it with `read_knowledge`:\n\n" +
			strings.Join(lines, "\n") + "\n"
	}
	desc := fields["description"]
	if desc == "" {
		desc = firstParagraph(body)
	}
	meta := map[string]any{"load": "on_demand", "description": jsstr.SliceUTF16(desc, 600)}
	if len(comps) > 0 {
		keys := make([]string, len(comps))
		for i, c := range comps {
			keys[i] = companionKey(c.rel)
		}
		meta["companions"] = keys
	}
	main := Candidate{Key: key, Category: "agent_skill", Title: "Skill: " + display + titleSuffix,
		Content: jsstr.Trim(body) + footer, Metadata: meta}
	for _, s := range sources {
		main.Source = append(main.Source, Source{Repo: s.repo, Path: joinNonEmpty(s.dir, s.mainFile), SHA256: jsstr.Sha256Hex(text)})
	}
	out := []Candidate{main}
	for _, c := range comps {
		var d string
		if hasSuffixFold(c.rel, ".md") {
			if h, ok := firstHeading(c.text); ok && h != "" {
				d = h
			} else {
				d = firstParagraph(c.text)
			}
		} else {
			d = c.rel + " of skill " + display
		}
		item := Candidate{Key: companionKey(c.rel), Category: "agent_skill", Title: "Skill: " + display + " — " + c.rel,
			Content: c.text, Metadata: map[string]any{"load": "on_demand", "parent_skill": key, "skill_file": c.rel,
				"description": jsstr.SliceUTF16(d, 300)}}
		for _, s := range sources {
			item.Source = append(item.Source, Source{Repo: s.repo, Path: joinNonEmpty(s.dir, c.rel), SHA256: jsstr.Sha256Hex(c.text)})
		}
		out = append(out, item)
	}
	return out
}
