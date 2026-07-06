//go:build js

package bridge

// The web build doesn't register the web-reading tools (see core/llm/tools_web_js.go), so
// its system prompt omits their guidance entirely.
const webToolsPrompt = ""
