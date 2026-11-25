package codeintelligence

/*
#include <stdlib.h>
void ts_set_allocator(void *(*)(size_t), void *(*)(size_t, size_t), void *(*)(void *, size_t), void (*)(void *));
static void use_libc_allocator(void) { ts_set_allocator(malloc, calloc, realloc, free); }
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	tsproto "github.com/coder3101/tree-sitter-proto/bindings/go"
	sitter "github.com/tree-sitter/go-tree-sitter"
	tsgo "github.com/tree-sitter/tree-sitter-go/bindings/go"
	tsjs "github.com/tree-sitter/tree-sitter-javascript/bindings/go"
	tsts "github.com/tree-sitter/tree-sitter-typescript/bindings/go"

	tssql "hasaki-orbit/go/internal/codeintelligence/grammar/sql"
)

// ExtractorVersion is the INDEX_VERSION prefix of src/codeIntelligence/parser.ts this extractor reproduces. The
// grammars are the ones bundled in tree-sitter-wasm 2.0.4 (go 0.25.0, javascript 0.25.0, typescript 0.23.2,
// proto be5691cf, sql 0.3.11); TestParity pins the output to the TypeScript extractor.
const ExtractorVersion = "extractor-2/runtime-0.27.1/grammars-2.0.4"

var languages = map[string]*sitter.Language{}

// fieldIDs resolves the field names the extractor reads once per language: by id, a field lookup costs one cgo
// call instead of also allocating a C string.
var fieldIDs = map[string]map[string]uint16{}

func init() {
	// go-tree-sitter routes every tree-sitter allocation through a Go callback (C→Go→C per malloc), which costs
	// more than parsing itself. Its Go side frees with C.free as well, so plain libc is a drop-in allocator.
	C.use_libc_allocator()
	for name, ptr := range map[string]unsafe.Pointer{
		"go": tsgo.Language(), "javascript": tsjs.Language(), "typescript": tsts.LanguageTypescript(),
		"tsx": tsts.LanguageTSX(), "proto": tsproto.Language(), "sql": tssql.Language(),
	} {
		l := sitter.NewLanguage(ptr)
		languages[name] = l
		fieldIDs[name] = map[string]uint16{}
		for _, f := range []string{"name", "type", "value", "column", "receiver", "body", "path", "source", "function", "arguments"} {
			fieldIDs[name][f] = l.FieldIdForName(f)
		}
	}
}

// Limits are the codeIntelligence settings that change extraction; they arrive with every request.
type Limits struct {
	MaxFileBytes        int      `json:"max_file_bytes"`
	MaxSymbols          int      `json:"max_symbols"`
	MaxFiles            int      `json:"max_files"`
	MaxScanBytes        int64    `json:"max_scan_bytes"`
	TimeoutMs           int      `json:"timeout_ms"`
	Excludes            []string `json:"excludes"`
	IncludeGenerated    bool     `json:"include_generated"`
	IncludeDependencies bool     `json:"include_dependencies"`
}

type Symbol struct {
	Name         string  `json:"symbol_name"`
	Qualified    string  `json:"qualified_name"`
	Kind         string  `json:"symbol_kind"`
	StartLine    int     `json:"start_line"`
	EndLine      int     `json:"end_line"`
	StartByte    int     `json:"start_byte"`
	EndByte      int     `json:"end_byte"`
	ParentSymbol *string `json:"parent_symbol"`
	Signature    string  `json:"signature"`
}

type Relation struct {
	Source     string `json:"source_name"`
	Target     string `json:"target_name"`
	Type       string `json:"relation_type"`
	Resolution string `json:"resolution"`
	Line       int    `json:"line"`
}

type Extraction struct {
	Language    string     `json:"language"`
	ContentHash string     `json:"content_hash"`
	Symbols     []Symbol   `json:"symbols"`
	Relations   []Relation `json:"relations"`
	ParseErrors int        `json:"parse_errors"`
}

var errExtractorLimit = errors.New("Extractor limit exceeded")

var kindNames = map[string]string{
	"function_declaration": "function", "function_signature": "function", "method_declaration": "method",
	"method_elem": "method", "method_definition": "method", "method_signature": "method",
	"class_declaration": "class", "abstract_class_declaration": "class", "interface_declaration": "interface",
	"type_alias_declaration": "type", "message": "message", "enum": "enum", "service": "service", "rpc": "rpc",
	"create_table": "table", "create_view": "view", "create_index": "index", "create_function": "function",
	"column_definition": "column",
}

var rpcPath = regexp.MustCompile(`^/([A-Za-z_][\w.]*)/([A-Za-z_]\w*)$`)

// Parsers holds one tree-sitter parser per language for a single goroutine (parsers are not thread-safe).
type Parsers map[string]*langParser

type langParser struct {
	parser *sitter.Parser
	kinds  map[uint16]string // node kind names by id, so each name crosses cgo once
	named  map[uint16]bool
}

func (lp *langParser) isNamed(n *sitter.Node) bool {
	id := n.KindId()
	named, ok := lp.named[id]
	if !ok {
		named = n.IsNamed()
		lp.named[id] = named
	}
	return named
}

func (p Parsers) get(language string) (*langParser, error) {
	if lp := p[language]; lp != nil {
		return lp, nil
	}
	parser := sitter.NewParser()
	if err := parser.SetLanguage(languages[language]); err != nil {
		parser.Close()
		return nil, fmt.Errorf("Parser unavailable (%s): %w", language, err)
	}
	p[language] = &langParser{parser: parser, kinds: map[uint16]string{}, named: map[uint16]bool{}}
	return p[language], nil
}

// Close releases the native parsers.
func (p Parsers) Close() {
	for _, lp := range p {
		lp.parser.Close()
	}
}

// Extract is extract() of src/codeIntelligence/parser.ts. A nil result means the file is not indexable.
func (p Parsers) Extract(ctx context.Context, path, source string, lim Limits) (*Extraction, error) {
	return p.extract(ctx, path, source, sha256Hex(source), lim)
}

// extract takes the content hash the caller already computed.
func (p Parsers) extract(ctx context.Context, path, source, hash string, lim Limits) (*Extraction, error) {
	language := languageOf(path)
	if language == "" || len(source) > lim.MaxFileBytes || strings.ContainsRune(source, 0) {
		return nil, nil
	}
	lp, err := p.get(language)
	if err != nil {
		return nil, err
	}
	parser := lp.parser
	deadline := time.Now().Add(time.Duration(min(5000, lim.TimeoutMs)) * time.Millisecond)
	// web-tree-sitter parses the JavaScript (UTF-16) string, and error recovery weighs skipped input by its byte
	// length: parsing UTF-8 would recover differently from syntax errors. Parse UTF-16 and map offsets back.
	units := utf16.Encode([]rune(source))
	offsets := make([]int, len(units)+1) // UTF-8 byte offset of every UTF-16 unit
	u, b := 0, 0
	for _, r := range source {
		offsets[u] = b
		if r >= 0x10000 {
			offsets[u+1] = b
			u++
		}
		u++
		b += utf8.RuneLen(r)
	}
	offsets[len(units)] = len(source)
	tree := parser.ParseUTF16LEWithOptions(func(offset int, _ sitter.Point) []uint16 {
		if offset < len(units) {
			return units[offset:min(offset+8192, len(units))]
		}
		return nil
	}, nil, &sitter.ParseOptions{ProgressCallback: func(sitter.ParseState) bool {
		return ctx.Err() != nil || time.Now().After(deadline)
	}})
	if tree == nil {
		parser.Reset()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("Parser deadline exceeded")
	}
	defer tree.Close()
	return walk(ctx, tree, lp, language, source, hash, func(byteOffset uint) int { return offsets[byteOffset/2] }, lim, deadline)
}

// walk reads the tree; at maps a node offset (UTF-16 bytes) to the UTF-8 byte offset in source.
func walk(ctx context.Context, tree *sitter.Tree, lp *langParser, language, source, hash string, at func(uint) int, lim Limits, deadline time.Time) (*Extraction, error) {
	fields := fieldIDs[language]
	kindOf := func(n *sitter.Node) string {
		id := n.KindId()
		k, ok := lp.kinds[id]
		if !ok {
			k = n.Kind()
			lp.kinds[id] = k
		}
		return k
	}
	field := func(n *sitter.Node, name string) *sitter.Node {
		if id := fields[name]; id != 0 {
			return n.ChildByFieldId(id)
		}
		return nil
	}
	out := &Extraction{Language: language, ContentHash: hash, Symbols: []Symbol{}, Relations: []Relation{}}
	cursor := tree.Walk()
	defer cursor.Close()
	named := func(n *sitter.Node) []sitter.Node { return n.NamedChildren(cursor) }
	text := func(n *sitter.Node) string { return source[at(n.StartByte()):at(n.EndByte())] }
	firstOf := func(n *sitter.Node, kind string) *sitter.Node {
		for _, c := range named(n) {
			if kindOf(&c) == kind {
				return &c
			}
		}
		return nil
	}
	root := tree.RootNode()
	pkg := ""
	for _, c := range named(root) {
		if kindOf(&c) == "package_clause" || kindOf(&c) == "package" {
			if kids := named(&c); len(kids) > 0 {
				pkg = text(&kids[0])
			}
			break
		}
	}
	maxRelations := lim.MaxSymbols * 4
	relation := func(n *sitter.Node, source, target, kind, resolution string) {
		if target != "" && len(out.Relations) < maxRelations {
			out.Relations = append(out.Relations, Relation{
				Source: source, Target: sliceUTF16(unquote(target), 512), Type: kind, Resolution: resolution,
				Line: int(n.StartPosition().Row) + 1,
			})
		}
	}
	or := func(parent *string, def string) string {
		if parent != nil {
			return *parent
		}
		return def
	}
	visit := func(n *sitter.Node, parent *string) (*string, bool) {
		t := kindOf(n)
		if t == "ERROR" || n.IsMissing() {
			out.ParseErrors++
			return nil, false
		}
		kind := kindNames[t]
		name, hasName := "", false
		// The TypeScript extractor reads the name of every node but uses it only for symbol kinds.
		if kind != "" || t == "type_spec" || t == "variable_declarator" {
			if f := field(n, "name"); f != nil {
				name, hasName = text(f), true
			}
		}
		if t == "package_clause" || t == "package" {
			kind, name, hasName = "package", pkg, true
		}
		if t == "type_spec" {
			kind = "type"
			if f := field(n, "type"); f != nil {
				switch kindOf(f) {
				case "struct_type":
					kind = "struct"
				case "interface_type":
					kind = "interface"
				}
			}
		}
		if t == "variable_declarator" {
			if v := field(n, "value"); v != nil && (kindOf(v) == "arrow_function" || kindOf(v) == "function_expression") {
				kind = "function"
			}
		}
		if t == "message" || t == "enum" || t == "service" || t == "rpc" {
			name, hasName = "", false
			if c := firstOf(n, t+"_name"); c != nil {
				name, hasName = text(c), true
			}
		}
		if strings.HasPrefix(t, "create_") {
			name, hasName = "", false
			if c := firstOf(n, "object_reference"); c != nil {
				name, hasName = text(c), true
			} else if f := field(n, "column"); f != nil {
				name, hasName = text(f), true
			}
		}
		if t == "create_index" {
			if f := field(n, "column"); f != nil {
				name, hasName = text(f), true
			}
		}
		scope := parent
		if kind != "" && hasName && name != "" && len(out.Symbols) < lim.MaxSymbols {
			receiver := ""
			if r := field(n, "receiver"); r != nil {
				if kids := named(r); len(kids) > 0 {
					if ty := field(&kids[0], "type"); ty != nil {
						receiver = strings.TrimPrefix(text(ty), "*")
					}
				}
			}
			// [parent ?? (pkg && kind !== "package" ? pkg : null), receiver, name].filter(Boolean).join(".")
			head := ""
			if parent != nil {
				head = *parent
			} else if kind != "package" {
				head = pkg
			}
			parts := []string{}
			for _, s := range []string{head, receiver, name} {
				if s != "" {
					parts = append(parts, s)
				}
			}
			qualified := strings.Join(parts, ".")
			body := field(n, "body")
			if body == nil {
				body = firstOf(n, "message_body")
			}
			start, end := at(n.StartByte()), at(n.EndByte())
			headerEnd := end
			if body != nil {
				headerEnd = at(body.StartByte())
			} else if nl := strings.IndexByte(source[start:], '\n'); nl >= 0 {
				headerEnd = min(end, start+nl)
			}
			signature := source[start:headerEnd]
			if loc := signatureCut.FindStringIndex(signature); loc != nil {
				signature = signature[:loc[0]]
			}
			signature = maskQuoted(redactSecrets(sliceUTF16(jsTrim(signature), 400)))
			out.Symbols = append(out.Symbols, Symbol{
				Name: name, Qualified: qualified, Kind: kind,
				StartLine: int(n.StartPosition().Row) + 1, EndLine: int(n.EndPosition().Row) + 1,
				StartByte: start, EndByte: end, ParentSymbol: parent, Signature: signature,
			})
			relation(n, or(parent, pkg), qualified, "DEFINES", "resolved")
			if p := n.Parent(); p != nil && (kindOf(p) == "export_statement" || (p.Parent() != nil && kindOf(p.Parent()) == "export_statement")) {
				relation(n, "export", qualified, "REFERENCES", "resolved")
			}
			q := qualified
			scope = &q
			if t == "rpc" {
				var types []sitter.Node
				for _, c := range named(n) {
					if kindOf(&c) == "message_or_enum_type" {
						types = append(types, c)
					}
				}
				if len(types) > 0 {
					relation(n, qualified, text(&types[0]), "RPC_REQUEST", "candidate")
				}
				if len(types) > 1 {
					relation(n, qualified, text(&types[1]), "RPC_RESPONSE", "candidate")
				}
			}
		}
		if t == "import_spec" || t == "import_statement" || t == "import" || t == "export_statement" {
			target := field(n, "path")
			if target == nil {
				target = field(n, "source")
			}
			if target != nil {
				relation(n, or(parent, pkg), text(target), "IMPORTS", "unresolved")
			}
		}
		if t == "export_statement" {
			for _, c := range named(n) {
				if kindOf(&c) == "export_clause" {
					relation(n, pkg, text(&c), "REFERENCES", "candidate")
				}
			}
		}
		if t == "call_expression" {
			fn := ""
			if f := field(n, "function"); f != nil {
				fn = text(f)
			}
			relation(n, or(parent, pkg), fn, "CALLS", "candidate")
			if args := field(n, "arguments"); args != nil {
				for _, a := range named(args) {
					if kindOf(&a) != "interpreted_string_literal" && kindOf(&a) != "string" {
						continue
					}
					if m := rpcPath.FindStringSubmatch(unquote(text(&a))); m != nil {
						relation(n, or(parent, pkg), m[1]+"."+m[2], "REFERENCES", "candidate")
					}
				}
			}
		}
		if t == "implements_clause" {
			for _, c := range named(n) {
				relation(n, or(parent, pkg), text(&c), "IMPLEMENTS", "candidate")
			}
		}
		if language == "sql" && t == "object_reference" {
			declared := false
			if p := n.Parent(); p != nil && strings.HasPrefix(kindOf(p), "create_") {
				if first := firstOf(p, "object_reference"); first != nil && first.Id() == n.Id() {
					declared = true
				}
			}
			if !declared {
				relation(n, or(parent, ""), text(n), "REFERENCES", "candidate")
			}
		}
		return scope, true
	}
	// Preorder over the named nodes with one cursor: the order of the TypeScript stack walk, without listing the
	// children of every node. ERROR, MISSING and anonymous nodes are not descended into.
	walker := tree.Walk()
	defer walker.Close()
	scopes := []*string{nil} // the scope the children at each depth are defined in
	visited := 0
	for {
		n := walker.Node()
		descend := false
		var scope *string
		if lp.isNamed(n) {
			visited++
			if visited > 200000 {
				return nil, errExtractorLimit
			}
			if visited%256 == 0 {
				if time.Now().After(deadline) {
					return nil, errExtractorLimit
				}
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			scope, descend = visit(n, scopes[len(scopes)-1])
		}
		if descend && walker.GotoFirstChild() {
			scopes = append(scopes, scope)
			continue
		}
		for !walker.GotoNextSibling() {
			if !walker.GotoParent() {
				return out, nil
			}
			scopes = scopes[:len(scopes)-1]
		}
	}
}
