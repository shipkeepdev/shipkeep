package caddy

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
)

// maintenanceStyle is the page's only style. The Content-Security-Policy allows it by its hash,
// and nothing else: no script, no image, no font, no form.
const maintenanceStyle = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#141414;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:32rem;padding:2rem 1.5rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0;color:#5c5c58}@media (prefers-color-scheme:dark){body{background:#0b0b0c;color:#ededea}p{color:#9a9a94}}`

// maintenancePage is the page Caddy serves while an application is in maintenance (ADR 0025). It
// is fixed and neutral: no text of it comes from the control plane, so an action cannot use it to
// show anything else on an application's domains.
const maintenancePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Down for maintenance</title><style>` +
	maintenanceStyle +
	`</style></head><body><main><h1>Down for maintenance</h1><p>This site is being updated and will be back shortly. Please try again in a few minutes.</p></main></body></html>`

// MaintenanceRetryAfter is the Retry-After the page sends, in seconds.
const MaintenanceRetryAfter = "120"

// MaintenanceHandler answers every request with the maintenance page: 503, so that clients and
// search engines treat it as temporary, and never cached.
func MaintenanceHandler() Handler {
	sum := sha256.Sum256([]byte(maintenanceStyle))
	policy := "default-src 'none'; style-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) +
		"'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	return Handler{
		Handler:    "static_response",
		StatusCode: http.StatusServiceUnavailable,
		Headers: map[string][]string{
			"Content-Type":            {"text/html; charset=utf-8"},
			"Retry-After":             {MaintenanceRetryAfter},
			"Cache-Control":           {"no-store"},
			"Content-Security-Policy": {policy},
			"X-Content-Type-Options":  {"nosniff"},
			"Referrer-Policy":         {"no-referrer"},
		},
		Body: maintenancePage,
	}
}
