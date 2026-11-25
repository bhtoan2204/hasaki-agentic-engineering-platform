// Command platform-supervise runs one command under supervision (ADR 0005): `platform-supervise [flags] -- cmd args`.
// It is started per process by the platform's TypeScript adapter, never as a service: there is no listening socket,
// no privilege and no shell. See go/internal/supervise.
package main

import (
	"os"

	"hasaki-orbit/go/internal/supervise"
)

func main() {
	supervise.Exit(supervise.Main(os.Args[1:]))
}
