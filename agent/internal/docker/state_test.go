package docker

import (
	"net/http"
	"sync/atomic"
	"testing"
)

func TestManagedContainersIncludesStoppedAndRejectsDaemonFailure(t *testing.T) {
	var fail atomic.Bool
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1.47/containers/json" || r.URL.Query().Get("all") != "true" || r.URL.Query().Get("filters") != `{"label":["sk.managed=true"]}` {
			t.Error("incorrect inventory query")
		}
		if fail.Load() {
			http.Error(w, "private", 500)
			return
		}
		_, _ = w.Write([]byte(`[{"Id":"id","Names":["/sk-a"],"State":"exited","Labels":{"sk.managed":"true"}}]`))
	})
	containers, err := client.ManagedContainers(t.Context())
	if err != nil || len(containers) != 1 || containers[0].State != "exited" {
		t.Fatalf("inventory: %v, %v", containers, err)
	}
	fail.Store(true)
	if containers, err = client.ManagedContainers(t.Context()); err == nil || containers != nil {
		t.Fatal("failed request returned a usable inventory")
	}
}
