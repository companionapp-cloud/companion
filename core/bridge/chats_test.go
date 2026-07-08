package bridge

import (
	"encoding/json"
	"testing"
	"time"
)

// TestChatsBackgroundRun exercises the persisted, background chat flow: create a chat, send a
// message, and confirm the assistant reply (and a streamed tool call's action) are persisted
// by the background goroutine — proving a run resolves without the caller waiting on it.
func TestChatsBackgroundRun(t *testing.T) {
	round1 := sse(
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"create_task","arguments":"{\"title\":\"Buy milk\"}"}}]},"finish_reason":"tool_calls"}]}`,
	)
	round2 := sse(`{"choices":[{"delta":{"content":"Added it — [[task]] is on your list."},"finish_reason":"stop"}]}`)
	srv := sseChatServer(t, round1, round2)

	c, _ := newTestCore(t)
	c.SetSecretStore(newFakeSecrets())
	if _, err := c.Invoke("llm.configs.create", mustJSON(map[string]any{
		"scope": "device", "name": "Local", "baseUrl": srv.URL + "/v1",
		"provider": "openai-compatible", "isDefault": true,
	})); err != nil {
		t.Fatalf("config: %v", err)
	}

	// Create a chat and send into it.
	chatOut, err := c.Invoke("chats.create", mustJSON(map[string]any{}))
	if err != nil {
		t.Fatalf("chats.create: %v", err)
	}
	var chat struct {
		ID string `json:"id"`
	}
	json.Unmarshal(chatOut, &chat)

	sendOut, err := c.Invoke("chats.send", mustJSON(map[string]any{"chatId": chat.ID, "text": "add a task to buy milk", "model": "test"}))
	if err != nil {
		t.Fatalf("chats.send: %v", err)
	}
	var ack struct {
		Working bool `json:"working"`
	}
	json.Unmarshal(sendOut, &ack)
	if !ack.Working {
		t.Error("send should report the chat as working")
	}

	// The run is on a goroutine; poll chats.get until the assistant reply is persisted.
	var final string
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		getOut, err := c.Invoke("chats.get", mustJSON(map[string]any{"id": chat.ID}))
		if err != nil {
			t.Fatalf("chats.get: %v", err)
		}
		var got struct {
			Working  bool `json:"working"`
			Messages []struct {
				Role string `json:"role"`
				Text string `json:"text"`
			} `json:"messages"`
		}
		json.Unmarshal(getOut, &got)
		last := got.Messages[len(got.Messages)-1]
		if !got.Working && last.Role == "assistant" && last.Text != "" {
			final = last.Text
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if final == "" {
		t.Fatal("assistant reply was never persisted by the background run")
	}

	// The tool call really created the task in the store.
	tasks, _ := c.store.Tasks.List()
	if len(tasks) != 1 || tasks[0].Title != "Buy milk" {
		t.Errorf("task not created by background run: %+v", tasks)
	}

	// The model passed to send is pinned on the chat, so the conversation continues on it.
	if stored, err := c.store.Chats.Get(chat.ID); err != nil {
		t.Fatalf("get chat: %v", err)
	} else if stored.Model == nil || *stored.Model != "test" {
		t.Errorf("chat model not persisted: %v", stored.Model)
	}

	// The chat is auto-titled from the first user message and no longer working.
	listOut, _ := c.Invoke("chats.list", nil)
	var chats []struct {
		Title   string `json:"title"`
		Working bool   `json:"working"`
	}
	json.Unmarshal(listOut, &chats)
	if len(chats) != 1 || chats[0].Title == "" || chats[0].Working {
		t.Errorf("unexpected chat list state: %+v", chats)
	}
}
