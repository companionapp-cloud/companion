package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// notificationsHandler is the desktop half of the reminder pipeline (PLAN §6.4). The
// notification *plan* is computed in core (notify.plan) and reconciled by the shared
// RemindersProvider; that provider hands the plan to a per-platform scheduler. On the
// Wails webview the browser Notification API is unavailable, so the desktop scheduler
// POSTs the plan here and we register real OS notifications through the Wails v3
// notifications service.
//
//	POST /notify/authorize   -> {"granted": bool}   (prompts on first call, macOS)
//	POST /notify/reconcile   [TaskNotification...]  -> 204, replaces all pending fires
//
// Reconcile is cancel-and-reschedule: it clears every previously scheduled fire and
// re-registers the ones still in the plan, matching the provider's contract of handing
// over the complete current plan each time.
type notificationsHandler struct {
	svc *notifications.NotificationService
}

func newNotificationsHandler(svc *notifications.NotificationService) *notificationsHandler {
	return &notificationsHandler{svc: svc}
}

// taskNotification mirrors core/notify.Notification (and core-bridge's TaskNotification)
// on the wire. FireAt is RFC3339; only future fires are schedulable.
type taskNotification struct {
	TaskID string `json:"taskId"`
	Kind   string `json:"kind"`
	FireAt string `json:"fireAt"`
	Title  string `json:"title"`
	Body   string `json:"body"`
}

// taskIDFromResponse resolves which task a tapped reminder was about. The taskId is carried
// in the notification's Data (round-tripped as response UserInfo); the scheduled id
// ("taskId:kind:fireAt") is a fallback for anything that loses the payload.
func taskIDFromResponse(resp notifications.NotificationResponse) string {
	if v, ok := resp.UserInfo["taskId"].(string); ok && v != "" {
		return v
	}
	if resp.ID != "" {
		if i := strings.IndexByte(resp.ID, ':'); i > 0 {
			return resp.ID[:i]
		}
	}
	return ""
}

func (h *notificationsHandler) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	granted, err := h.svc.RequestNotificationAuthorization()
	if err != nil {
		log.Printf("notify: authorization request failed: %v", err)
		granted = false
	} else {
		log.Printf("notify: authorization granted=%v", granted)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"granted": granted})
}

func (h *notificationsHandler) handleReconcile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var plan []taskNotification
	if err := json.Unmarshal(body, &plan); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Surface the OS authorization state: SendNotification's add succeeds even when the
	// user hasn't granted permission, so without this a "scheduled" reminder that never
	// appears looks like a bug here when it's actually a denied/undetermined permission.
	if authorized, err := h.svc.CheckNotificationAuthorization(); err != nil {
		log.Printf("notify: authorization check failed: %v", err)
	} else if !authorized {
		log.Printf("notify: reconcile with %d fire(s) but notifications are NOT authorized — nothing will be delivered", len(plan))
	}

	// Cancel everything we scheduled before, then re-register the current plan. macOS
	// keeps native triggers across restarts, so clearing first is what makes a removed
	// or rescheduled reminder actually stop firing.
	if err := h.svc.RemoveAllPendingNotifications(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now()
	scheduled := 0
	for _, n := range plan {
		fireAt, err := time.Parse(time.RFC3339, n.FireAt)
		if err != nil || !fireAt.After(now) {
			log.Printf("notify: skip task %s fireAt=%q (unparseable or already past)", n.TaskID, n.FireAt)
			continue // unparseable or already past: nothing to schedule
		}
		// Stable per-fire id so a re-register replaces rather than duplicates.
		id := n.TaskID + ":" + n.Kind + ":" + n.FireAt
		if err := h.svc.SendNotification(notifications.NotificationOptions{
			ID:       id,
			Title:    n.Title,
			Body:     n.Body,
			ThreadID: n.TaskID,
			// Carried back on tap (response.UserInfo) so the shell can deep-link to the task.
			Data:     map[string]interface{}{"taskId": n.TaskID},
			Schedule: &notifications.NotificationSchedule{At: fireAt.Unix()},
		}); err != nil {
			log.Printf("notify: schedule task %s failed: %v", n.TaskID, err)
			continue // one bad fire shouldn't sink the rest of the plan
		}
		scheduled++
		log.Printf("notify: scheduled task %s for %s (in %s)", n.TaskID, fireAt.Local().Format(time.Kitchen), time.Until(fireAt).Round(time.Second))
	}
	log.Printf("notify: reconcile done — %d/%d fire(s) scheduled", scheduled, len(plan))
	w.WriteHeader(http.StatusNoContent)
}
