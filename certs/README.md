# certs

## global-bundle.pem

The public AWS RDS certificate authority bundle (114 CA certificates, no private keys), used to verify TLS to RDS
PostgreSQL.

- **Source:** the bundle AWS publishes for RDS, `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`
  (AWS documentation: "Using SSL/TLS to encrypt a connection to a DB instance", RDS User Guide).
- **Added to this repository:** 2026-11-06 (commit `aa93e4e`). The commit does not record the download itself; the
  source above is the standard location for a file with this name, not something verified against that commit.
- **SHA-256:** `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`
- **Certificate expiry range:** 2061-05-19 to 2126-09-02.

To refresh it, download the file from the URL above, compare it with a second download from another network, replace
it, and update the date and SHA-256 here. Nothing in `src/` or `go/` currently reads this path; it is for operators who
set `sslrootcert` in `DATABASE_URL`.

Secret scanning ignores this one file (`.gitleaks.toml`) because certificates are public; any other file under
`certs/` is scanned normally.
