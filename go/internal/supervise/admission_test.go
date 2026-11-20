package supervise

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A host that stays under memory pressure past the admission timeout refuses the command (and frees the slot);
// pressure that drops in time admits it.
func TestPressureTimeoutRefusesTheCommand(t *testing.T) {
	saved := pressure
	defer func() { pressure = saved }()
	a := Admission{Dir: t.TempDir(), Class: "verification", Slots: 1, Timeout: 300 * time.Millisecond, MaxMemoryPressure: 40}
	pressure = func() (float64, float64, float64) { return 0, 90, 0 }
	slot, waited, err := a.Acquire(context.Background())
	if err == nil || slot != nil || !strings.Contains(err.Error(), "pressure") || waited < 300*time.Millisecond {
		t.Fatalf("slot %v waited %v err %v", slot, waited, err)
	}
	calls := 0
	pressure = func() (float64, float64, float64) {
		calls++
		if calls > 2 {
			return 0, 5, 0
		}
		return 0, 90, 0
	}
	slot, _, err = a.Acquire(context.Background())
	if err != nil || slot == nil {
		t.Fatalf("pressure dropped but admission failed: %v", err)
	}
	_ = slot.Close()
	// The refused attempt released its slot: the next one gets it at once.
	pressure = func() (float64, float64, float64) { return 0, 0, 0 }
	if slot, w, err := a.Acquire(context.Background()); err != nil || w > 50*time.Millisecond {
		t.Fatalf("slot leaked: %v %v", w, err)
	} else {
		_ = slot.Close()
	}
}
