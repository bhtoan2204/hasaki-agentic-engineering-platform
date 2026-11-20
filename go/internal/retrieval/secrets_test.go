package retrieval

import "testing"

func TestLooksSecret(t *testing.T) {
	positives := map[string]string{
		"pem":          "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
		"openssh":      "-----BEGIN OPENSSH PRIVATE KEY-----",
		"aws":          "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
		"github":       "use ghp_0123456789abcdefghijklmnopqrstuvwxyzAB to push",
		"gitlab":       "token glpat-AbCdEfGhIjKlMnOpQrSt12",
		"slack":        "xoxb-123456789012-123456789012-AbCdEfGhIjKl",
		"openai":       "OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrStUv123456",
		"jwt":          "Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		"url creds":    "DATABASE_URL=postgres://app:Xk29fjQp@db.internal:5432/app",
		"password":     `password = "Zq8wLm2Nv5Rt7Yp1"`,
		"token colon":  "token: a1b2c3d4e5f6g7h8i9j0",
		"visa":         "card 4111 1111 1111 1111 exp 12/30",
		"amex compact": "378282246310005",
	}
	for name, text := range positives {
		if !looksSecret(text) {
			t.Errorf("%s: not detected: %q", name, text)
		}
	}
	negatives := map[string]string{
		"prose":             "Orders must be confirmed within 24 hours by the warehouse team.",
		"public key":        "-----BEGIN PUBLIC KEY-----",
		"placeholder url":   "DATABASE_URL=postgres://user:<password>@localhost/platform",
		"env url":           "postgres://app:${DB_PASSWORD}@db/app",
		"url without creds": "see https://example.com/docs/a:b and git@github.com:org/repo.git",
		"short password":    "password=hunter2",
		"code reference":    "token = process.env.RETRIEVAL_INTERNAL_TOKEN",
		"typed field":       "token: string; password: string",
		"words only":        "secret: thisisalongwordwithoutdigits",
		"luhn invalid":      "order 4111 1111 1111 1112",
		"timestamp":         "created 1700000000000 ms",
		"sk prose":          "sk-short",
		"aws lowercase":     "akiaiosfodnn7example",
	}
	for name, text := range negatives {
		if looksSecret(text) {
			t.Errorf("%s: false positive: %q", name, text)
		}
	}
}
