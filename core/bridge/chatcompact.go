package bridge

import (
	"encoding/json"
	"strings"

	"companion/core/domain"
	"companion/core/llm"
)

// Budgets for compactTranscript: the whole summary, and any one message within it.
const (
	compactMaxChars    = 24000
	compactMaxPerTurn  = 4000
	compactOmittedNote = "[Earlier messages omitted.]"
)

// compactTranscript condenses a chat's earlier turns into one block of text that a fresh CLI
// session can read as context — used when the CLI's own session is gone (expired, or made by
// a different agent). Tool traffic is reduced to the tool names; long messages are clipped;
// when the whole thing is over budget the oldest turns are dropped first. "" when there is
// nothing to carry over.
func compactTranscript(msgs []*domain.ChatMessage) string {
	var turns []string
	for _, m := range msgs {
		if m.DeletedAt != nil {
			continue
		}
		var label string
		switch m.Role {
		case domain.ChatRoleUser:
			label = "User"
		case domain.ChatRoleAssistant:
			label = "Assistant"
		default:
			continue // tool-result turns: the assistant's reply already reflects them
		}
		text := strings.TrimSpace(m.Text)
		if len(text) > compactMaxPerTurn {
			text = text[:compactMaxPerTurn] + "…"
		}
		if m.Role == domain.ChatRoleAssistant && len(m.ToolCalls) > 0 {
			var calls []llm.ToolCall
			if json.Unmarshal(m.ToolCalls, &calls) == nil && len(calls) > 0 {
				names := make([]string, 0, len(calls))
				for _, c := range calls {
					names = append(names, c.Name)
				}
				used := "(used tools: " + strings.Join(names, ", ") + ")"
				if text == "" {
					text = used
				} else {
					text = used + "\n" + text
				}
			}
		}
		if text == "" {
			continue
		}
		turns = append(turns, label+": "+text)
	}
	if len(turns) == 0 {
		return ""
	}
	// Keep the newest turns that fit the budget.
	start, size := len(turns), 0
	for start > 0 && size+len(turns[start-1])+2 <= compactMaxChars {
		start--
		size += len(turns[start]) + 2
	}
	if start == len(turns) {
		start = len(turns) - 1 // always keep at least the latest turn
	}
	kept := turns[start:]
	if start > 0 {
		kept = append([]string{compactOmittedNote}, kept...)
	}
	return strings.Join(kept, "\n\n")
}

// withCompactedHistory prefixes prompt with the compacted transcript of the turns before it,
// so a new CLI session picks the conversation up where it left off.
func withCompactedHistory(history []*domain.ChatMessage, prompt string) string {
	summary := compactTranscript(history)
	if summary == "" {
		return prompt
	}
	return "This conversation is continuing from an earlier session that is no longer available. " +
		"Here is a compacted transcript of it for context:\n\n<previous_conversation>\n" + summary +
		"\n</previous_conversation>\n\nThe user's new message:\n\n" + prompt
}

// historyBeforeLastUser returns the messages before the chat's latest user turn — the one
// being answered now.
func historyBeforeLastUser(msgs []*domain.ChatMessage) []*domain.ChatMessage {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == domain.ChatRoleUser {
			return msgs[:i]
		}
	}
	return msgs
}
