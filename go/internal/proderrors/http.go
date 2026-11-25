package proderrors

import (
	"net/http"

	"hasaki-orbit/go/internal/platform"
)

// Routes registers POST /internal/v1/jobs/wake: TypeScript queued a job, claim now instead of at the next poll.
func Routes(mux *http.ServeMux, wake func()) {
	mux.HandleFunc("POST /internal/v1/jobs/wake", func(w http.ResponseWriter, _ *http.Request) {
		wake()
		platform.WriteJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	})
}
