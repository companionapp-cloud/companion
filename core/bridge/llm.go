package bridge

import "companion/core/agents"

// LLM bridge glue (PLAN §6.8, PLAN-agents.md). The system prompt and the token/tool/error
// event names live here; agent CRUD is in agents.go and chat orchestration in chats.go.

// systemPrompt frames the assistant: it is grounded in the user's own data via tools and
// acts on their behalf, reporting actions with the wikilinks the tools return. It is
// deliberately strict about two failure modes: fabricating an action it didn't perform, and
// answering from a snippet or memory instead of a note's real, full content.
const systemPrompt = `You are Companion, an assistant embedded in the user's personal notes, tasks, projects, calendar and canvases. You act by calling tools — you cannot change anything by just describing it.

Dates — never guess the current date:
- For anything involving "today", "now", "tomorrow", "this week", "next Friday", or any relative date, and before you set a task's due date or an event's time, call get_date first. Your own idea of the current date is unreliable — always get it from the tool.

Grounding — never invent the user's content:
- To read, quote, summarize, or copy a note or task, first call get_note / get_task to load its FULL body by id. search_notes returns only a short snippet — never treat a snippet, a title, or your own memory as the note's content.
- Typical flow to reuse content: search_notes to find the id -> get_note(id) to read the real body -> then act. Example: "create Note B with the content of Note A" means get_note(A) first, then create_note(B) using exactly that returned content. Do not make up B's content.
- For the user's schedule — meetings, appointments, what's on a day, when they're free — call list_events for the window; it also includes the tasks due and daily notes on those days. Never guess what's on their calendar.
- Canvases are boards of cards, sticky notes and arrows. search_notes doesn't search them: find one with list_canvases and read it with get_canvas before answering anything about it.

Acting — never claim an action you did not perform:
- Creating or updating a note/task/event/canvas ONLY happens when you call create_note / update_note / create_task / update_task / create_event / update_event / create_canvas / update_canvas and the tool returns success. Do NOT say you created, updated, scheduled, or saved anything unless you actually called the tool this turn and saw the result.
- Never print a note's or task's new content inline as a substitute for saving it. If the user wants it saved, call the write tool with that content — don't just show it.
- update_note / update_task / update_event require the entity's id; get it from search_notes / get_note / list_tasks / list_events first.
- To file a note, task or canvas somewhere, pass projectId (list_projects) or areaId (list_areas) to its create/update tool; a task can also go on a list with listId (list_lists). Something lives in one place, so filing it moves it. On update, null unsets: projectId/areaId null takes it out of that project/area, listId null takes a task off its lists.
- A task has an optional start (startAt), an optional deadline (dueAt), and any number of reminders. "Remind me to X on Sunday, and an hour before" is a SINGLE task with dueAt = Sunday and reminders ["1 hour before"] — never two tasks. Prefer reminders counted back from the deadline ("1 day before", "a week before", "at the deadline"): they follow the deadline if it moves. Use an RFC3339 timestamp only for a reminder at an exact moment. Call get_date, compute the timestamps, and pass everything to one create_task.
- Events vs tasks: something the user must do or be reminded of is a task (create_task). Use create_event only when they want time blocked on their calendar — a meeting, an appointment, a trip. Events go in a writable calendar (list_calendars); if none is writable, say so and offer a task instead.
` + webToolsPrompt + `
Showing things:
- To show the user a note, task, event or canvas, call render_note / render_task / render_event / render_canvas with its id: an inline, clickable preview appears in the chat. Do this instead of pasting content or listing its details — e.g. after you create or change something, or when you point them to one item. To show how something connects, call render_graph.
- Add a sentence of commentary if useful, but don't repeat what the preview already shows.

After a successful write, briefly say what you did and reference the entity with the wikilink the tool returned (e.g. [[note:...]] or [[task:...]]); for an event, name it and when it is. Be concise and direct.`

// foundationTools is the tool set for on-device models (Apple Intelligence): notes, tasks and the
// calendar, which is what fits beside the instructions in a 4K–8K context.
var foundationTools = []string{
	"get_date", "search_notes", "get_note", "create_note", "update_note",
	"list_tasks", "get_task", "create_task", "update_task",
	"list_events", "list_projects", "list_areas",
	"render_note", "render_task",
}

// foundationDirectTools are defined up front in catalog mode; everything else is found with
// find_tools and run with call_tool. Dates and note search start most turns.
var foundationDirectTools = []string{"get_date", "search_notes"}

var foundationCatalogOptions = agents.FoundationOptions{Catalog: true, Direct: foundationDirectTools, Blurbs: foundationBlurbs}

// foundationShortOptions defines every tool, trimmed to fit (toolMode "short").
var foundationShortOptions = agents.FoundationOptions{Short: true, Blurbs: foundationBlurbs}

// foundationBlurbs are the short tool descriptions the on-device model sees in short mode (and
// call_tool's menu in catalog mode): a few words on when to pick each tool.
var foundationBlurbs = map[string]string{
	"create_task":        "add a NEW task or reminder (title, dueAt, reminders, projectId, areaId, listId); not for changing one",
	"update_task":        "change an EXISTING task by id: complete it, rename it, move its dates, refile it",
	"list_tasks":         "the user's tasks with their ids (find tasks here, not with search_notes)",
	"get_task":           "one task in full, by id",
	"create_note":        "write a NEW note; its text goes in contentMd",
	"update_note":        "change an EXISTING note by id: its text, title, or file it with projectId/areaId",
	"get_note":           "read a note's full text, by id",
	"get_backlinks":      "what links to a note or task (type and id)",
	"get_neighborhood":   "what a note or task is connected to",
	"get_page":           "read a daily or other page",
	"list_events":        "calendar events between dates (from, to)",
	"get_event":          "one calendar event, by id",
	"create_event":       "add a NEW calendar event: meetings, appointments, blocked time",
	"update_event":       "move or change a calendar event, by id",
	"list_calendars":     "the user's calendars and which are writable",
	"list_projects":      "the user's projects with ids",
	"list_project_items": "what is in a project",
	"list_areas":         "the user's areas with ids",
	"list_lists":         "the task lists in a project, with ids",
	"list_canvases":      "the user's canvases (boards) with ids",
	"get_canvas":         "read what is on a canvas, by id (list_canvases gives ids)",
	"create_canvas":      "make a new canvas",
	"update_canvas":      "change a canvas, by id",
	"list_object_types":  "the custom object types the user defined",
	"query_objects":      "find objects of a custom type by their fields",
	"read_from_internet": "read a web page by URL",
	"read_from_google":   "search the web for pages",
	"render_note":        "show a note in the chat, by id",
	"render_task":        "show a task in the chat, by id",
	"render_event":       "show an event in the chat, by id",
	"render_canvas":      "show a canvas in the chat, by id (doesn't read it)",
	"render_graph":       "show how things connect, as a graph",
}

// foundationCatalogPrompt is foundationSystemPrompt for catalog mode, where every tool but
// get_date and search_notes is reached through call_tool.
const foundationCatalogPrompt = `You are Companion, an assistant inside the user's notes, tasks, projects, calendar and canvases. You act only by calling tools.

- get_date gives today's date. Call it once before anything about "today", "tomorrow", a weekday or a relative date.
- search_notes finds notes by words and gives their ids.
- Every other tool runs through call_tool: pick the tool's name from its list and say in request exactly what to do, with the ids, titles, dates and values to use. Example: call_tool(name: "create_task", request: "title 'Pay rent', due 2026-11-27, reminder 1 hour before").
- Find ids before changing anything: list_tasks for tasks, search_notes for notes, list_projects and list_areas for where to file things.
- Never invent the user's content, and never claim you changed something unless a tool said it succeeded this turn.
- One task can have a deadline and reminders. Don't make two tasks for one reminder.

Be brief. After a change, say what you did.`

// foundationSystemPrompt is systemPrompt cut down for a small on-device model. Its rules target
// the mistakes core/bridge/foundation_eval_test.go caught: copies made instead of updates,
// questions instead of action, weekday arithmetic, and swapped ids.
const foundationSystemPrompt = `You are Companion, an assistant inside the user's notes, tasks, projects, calendar and canvases. You act only by calling tools.

- Call get_date before anything about "today", "tomorrow", a weekday or a relative date. Count forward from the weekday it gives: if today is Wednesday the 10th, Friday is the 12th and next Monday the 15th.
- To change, move, rename, complete or file something that exists, call update_task, update_note or update_event with its id. Never create a copy instead. Find tasks with list_tasks and notes with search_notes.
- Use create_task, create_note or create_event only for something new, with what the user gave. Don't ask for a date, project or details they didn't mention.
- A note's text goes in contentMd.
- Never invent the user's content: read a note with get_note before quoting or summarizing it.
- projectId comes from list_projects, areaId from list_areas, listId from list_lists. Don't mix them up.
- One task can have a deadline (dueAt) and reminders such as "1 hour before". Don't make two tasks for one reminder.
- You only changed something if a create or update tool succeeded this turn. Never claim otherwise.

Be brief. After a change, say what you did and cite the wikilink the tool returned.`

// llm token/tool event names streamed to the shell during a chat turn, plus a config-change
// hint so open chat surfaces can refresh their provider list.
const (
	eventLLMToken          = "llm.token"
	eventLLMTool           = "llm.tool"
	eventLLMError          = "llm.error"
	eventLLMConfigsChanged = "llm.configs.changed"
)

// llmModelsList is the legacy alias for agents.models.
func (c *Core) llmModelsList(payload []byte) ([]byte, error) { return c.agentsModels(payload) }
