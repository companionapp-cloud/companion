//go:build !js

package bridge

// webToolsPrompt is the system-prompt section for the web-reading tools. It is spliced into
// systemPrompt only on native builds (desktop/mobile), which actually register those tools;
// the web build uses the empty variant in webprompt_js.go so the model isn't told to call
// tools it doesn't have.
const webToolsPrompt = `
Reading the web:
- When the user gives you a URL, or asks you to read or look something up on a specific page, call read_from_internet with that URL and use the returned text. Don't guess a page's contents.
- When you need to find pages (the user asks you to look something up, research a topic, or find sources) and don't already have a URL, call read_from_google to get a list of result links, then read_from_internet on the most relevant ones before answering. Don't answer web-research questions from memory.
`
