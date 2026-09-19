//go:build !js

package store

import (
	"testing"
	"time"
)

// The sync server doesn't store agent_session_id, so every pull echoes a chat back without it.
// Applying that echo must keep the CLI session, or the next turn starts a fresh Claude Code
// conversation with no memory of the previous one.
func TestChatApplyKeepsAgentSession(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 19, 4, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	agent := "agent-1"
	chat, err := s.Chats.Create("What's on my agenda for today", &agent)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	session := "session-1"
	if err := s.Chats.SetAgentSession(chat.ID, &session); err != nil {
		t.Fatalf("set session: %v", err)
	}

	pulled, err := s.Chats.GetAny(chat.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	pulled.AgentSessionID = nil
	pulled.Version = 2
	if err := s.Chats.Apply(pulled); err != nil {
		t.Fatalf("apply echo: %v", err)
	}
	got, err := s.Chats.Get(chat.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.AgentSessionID == nil || *got.AgentSessionID != session {
		t.Fatalf("session after pull = %v, want %q", got.AgentSessionID, session)
	}

	// Another device re-pinned the chat to a different agent; the session belonged to the old one.
	other := "agent-2"
	pulled.ConfigID = &other
	pulled.Version = 3
	if err := s.Chats.Apply(pulled); err != nil {
		t.Fatalf("apply re-pin: %v", err)
	}
	if got, _ := s.Chats.Get(chat.ID); got.AgentSessionID != nil {
		t.Errorf("session after re-pin = %q, want none", *got.AgentSessionID)
	}
}
