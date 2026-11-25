package knowledge

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"hasaki-orbit/go/internal/jsstr"
)

// testdata/text-golden.json is what the TypeScript importer computes on these inputs
// (test/fixtures/knowledgeTextGolden.ts regenerates it). Keys, titles, descriptions and secret decisions of both
// engines must agree on every edge case.
type golden struct {
	Texts []struct {
		Text        string `json:"text"`
		Frontmatter struct {
			Fields map[string]string `json:"fields"`
			Body   string            `json:"body"`
		} `json:"frontmatter"`
		Heading   *string `json:"heading"`
		Paragraph string  `json:"paragraph"`
	} `json:"texts"`
	Secrets []struct {
		Text   string `json:"text"`
		Secret bool   `json:"secret"`
	} `json:"secrets"`
	Slugs []struct {
		In  string `json:"in"`
		Out string `json:"out"`
	} `json:"slugs"`
	Slices []struct {
		In  string `json:"in"`
		N   int    `json:"n"`
		Out string `json:"out"`
	} `json:"slices"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	b, err := os.ReadFile("testdata/text-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestTextRulesMatchTheTypeScriptImporter(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Texts {
		fields, body := frontmatter(c.Text)
		if !reflect.DeepEqual(fields, c.Frontmatter.Fields) || body != c.Frontmatter.Body {
			t.Errorf("frontmatter(%q) = %q %q, want %q %q", c.Text, fields, body, c.Frontmatter.Fields, c.Frontmatter.Body)
		}
		h, ok := firstHeading(c.Text)
		if ok != (c.Heading != nil) || (ok && h != *c.Heading) {
			t.Errorf("firstHeading(%q) = %q %v, want %v", c.Text, h, ok, c.Heading)
		}
		if p := firstParagraph(c.Text); p != c.Paragraph {
			t.Errorf("firstParagraph(%q) = %q, want %q", c.Text, p, c.Paragraph)
		}
	}
	for _, c := range g.Secrets {
		if got := looksSecret(c.Text); got != c.Secret {
			t.Errorf("looksSecret(%q) = %v, want %v", c.Text, got, c.Secret)
		}
	}
	for _, c := range g.Slugs {
		if got := slug(c.In); got != c.Out {
			t.Errorf("slug(%q) = %q, want %q", c.In, got, c.Out)
		}
	}
	for _, c := range g.Slices {
		if got := jsstr.SliceUTF16(c.In, c.N); got != c.Out {
			t.Errorf("slice(%q, %d) = %q, want %q", c.In, c.N, got, c.Out)
		}
	}
}
