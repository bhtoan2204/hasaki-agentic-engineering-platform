// Package sql is the DerekStride tree-sitter-sql grammar 0.3.11 (src/ copied unmodified from the npm package
// @derekstride/tree-sitter-sql@0.3.11, the version bundled in tree-sitter-wasm 2.0.4). The Go module of that
// repository does not ship the generated parser.c.
package sql

// #cgo CFLAGS: -std=c11 -fPIC -I${SRCDIR}/src
// #include "src/parser.c"
// #include "src/scanner.c"
import "C"

import "unsafe"

// Language returns the tree-sitter Language for SQL.
func Language() unsafe.Pointer {
	return unsafe.Pointer(C.tree_sitter_sql())
}
