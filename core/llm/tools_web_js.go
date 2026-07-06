//go:build js

package llm

// On the web (wasm) build, outbound HTTP from the core goes through the browser's fetch()
// and is CORS-blocked for arbitrary sites, so the web-reading tools can't work — addWebTools
// is a no-op here and read_from_internet / read_from_google are never offered to the model.
func addWebTools(_ *Registry) {}
