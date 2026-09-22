package bridge

import (
	"strings"
	"testing"

	"companion/core/domain"
)

func TestCompactTranscript(t *testing.T) {
	msgs := []*domain.ChatMessage{
		{Role: domain.ChatRoleUser, Text: "find my trip notes"},
		{Role: domain.ChatRoleAssistant, Text: "", ToolCalls: []byte(`[{"id":"1","name":"search_notes","args":{}}]`)},
		{Role: domain.ChatRoleTool, Text: "lots of tool output"},
		{Role: domain.ChatRoleAssistant, Text: "Found two notes."},
		{Role: domain.ChatRoleUser, Text: "summarize them"},
	}
	got := compactTranscript(historyBeforeLastUser(msgs))
	want := "User: find my trip notes\n\nAssistant: (used tools: search_notes)\n\nAssistant: Found two notes."
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if compactTranscript(nil) != "" || withCompactedHistory(nil, "hi") != "hi" {
		t.Fatal("empty history should leave the prompt untouched")
	}
	if p := withCompactedHistory(msgs[:4], "summarize them"); !strings.Contains(p, "<previous_conversation>") || !strings.HasSuffix(p, "summarize them") {
		t.Fatalf("unexpected prompt %q", p)
	}
}

func TestCompactTranscriptDropsOldestOverBudget(t *testing.T) {
	var msgs []*domain.ChatMessage
	for i := 0; i < 20; i++ {
		msgs = append(msgs, &domain.ChatMessage{Role: domain.ChatRoleUser, Text: strings.Repeat("x", 3000)})
	}
	msgs = append(msgs, &domain.ChatMessage{Role: domain.ChatRoleAssistant, Text: "latest"})
	got := compactTranscript(msgs)
	if !strings.HasPrefix(got, compactOmittedNote) || !strings.HasSuffix(got, "Assistant: latest") {
		t.Fatalf("expected oldest turns dropped and newest kept")
	}
	if len(got) > compactMaxChars+len(compactOmittedNote)+2 {
		t.Fatalf("over budget: %d", len(got))
	}
}
