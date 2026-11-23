-- Companion for Rex: the Companion TUI in a pane, and quick capture from Rex's palette.
--
-- `companion rex install` writes this file to ~/.config/rex/plugins/companion/init.lua and loads
-- it from Rex's config with the path of the companion binary:
--
--   dofile(".../plugins/companion/init.lua").setup({ bin = { "/path/to/companion" } })
--
-- Everything here runs `companion` on this Mac, which talks to the Companion app through its
-- terminal access (Settings › AI › Terminal agents). A session on a remote host has no Companion
-- app to talk to, so the actions refuse there.

local M = {}

local SHELL = "com.superlogical.terminal.shell"

local DEFAULT_PATH = table.concat({
  "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
}, ":")

function M.setup(opts)
  opts = opts or {}
  local bin = opts.bin or { "companion" }
  if type(bin) == "string" then bin = { bin } end
  local env = { PATH = opts.path or DEFAULT_PATH }

  local function argv(...)
    local out = {}
    for _, part in ipairs(bin) do out[#out + 1] = part end
    for _, part in ipairs({ ... }) do out[#out + 1] = part end
    return out
  end

  local function local_only(ctx)
    if ctx.server ~= nil then
      error("Companion: this session is on another host. Companion runs on this Mac, so open it from a local session.", 0)
    end
  end

  -- The TUI in a new tab, or (beside) beside the pane the palette was opened from.
  local function open_tui(ctx, start, beside)
    local_only(ctx)
    local layout = { block = { flavor = SHELL, label = "Companion", options = { command = argv("tui", start) } } }
    if beside and ctx.block_id ~= nil then
      local _, err = rex.session.new_split{
        anchor_id = ctx.block_id, direction = "horizontal", side = "after", focus = true, layout = layout,
      }
      if err ~= nil then error("Companion: couldn't open a pane: " .. tostring(err), 0) end
      return
    end
    local _, err = rex.session.new_window{ label = "Companion", layout = layout, focus = true }
    if err ~= nil then error("Companion: couldn't open a tab: " .. tostring(err), 0) end
  end

  -- Runs `companion new …` and returns what it made, or nil and the error it printed.
  local function create(...)
    local result = rex.exec(argv("new", ...), { env = env, timeout = 45 })
    if result == nil then return nil, "companion didn't start. Is the Companion app installed?" end
    if not result.ok then
      local why = (result.stderr or ""):gsub("^%s+", ""):gsub("%s+$", "")
      return nil, why ~= "" and why or "companion exited with an error"
    end
    local ok, value = pcall(rex.json.decode, result.stdout or "")
    if ok and type(value) == "table" then return value end
    return { title = "" }
  end

  -- Asks for one line; nil when the user backed out.
  local function ask(spec)
    local text, why = rex.ui.input(spec)
    if text == nil then
      if why ~= "cancelled" then rex.log("warn", "Companion: " .. tostring(why)) end
      return nil
    end
    return (text:gsub("^%s+", ""):gsub("%s+$", ""))
  end

  rex.action{
    name = "companion_open",
    title = "Companion: Open",
    description = "Open Companion in a new tab: today's note, calendar, notes, tasks, canvases and the graph.",
    category = "Companion",
    keywords = "companion notes tasks calendar canvas graph tui",
    run = function(ctx) open_tui(ctx, "today", false) end,
  }

  rex.action{
    name = "companion_today",
    title = "Companion: Today's Note",
    description = "Edit today's daily note in a pane beside this one.",
    category = "Companion",
    keywords = "companion today daily note journal",
    run = function(ctx) open_tui(ctx, "today", true) end,
  }

  for _, view in ipairs({ "Calendar", "Notes", "Tasks", "Canvases", "Graph" }) do
    rex.action{
      name = "companion_" .. view:lower(),
      title = "Companion: " .. view,
      description = "Open Companion's " .. view:lower() .. " in a pane beside this one.",
      category = "Companion",
      keywords = "companion " .. view:lower(),
      run = function(ctx) open_tui(ctx, view:lower(), true) end,
    }
  end

  rex.action{
    name = "companion_new_note",
    title = "Companion: New Note…",
    description = "Create a note in Companion: a title, then (optionally) its first lines.",
    category = "Companion",
    keywords = "companion new note create capture quick",
    run = function(ctx)
      local_only(ctx)
      local title = ask{ title = "New note", placeholder = "Title", confirm = "Next" }
      if title == nil or title == "" then return end
      local body = ask{ title = title, placeholder = "First lines (optional)", confirm = "Create note" }
      if body == nil then return end
      local made, err = create("note", "--json", "--title", title, "--body", body)
      if made == nil then error("Companion: " .. err, 0) end
      return { created = "note", title = made.title }
    end,
  }

  rex.action{
    name = "companion_new_task",
    title = "Companion: New Task…",
    description = "Create a task in Companion: a title, then (optionally) when it's due, in plain words.",
    category = "Companion",
    keywords = "companion new task todo create capture quick due",
    run = function(ctx)
      local_only(ctx)
      local title = ask{ title = "New task", placeholder = "Title", confirm = "Next" }
      if title == nil or title == "" then return end
      local prompt = "Due (optional)"
      while true do
        local due = ask{ title = title, placeholder = prompt .. ": tomorrow 5pm, fri, next week", confirm = "Create task" }
        if due == nil then return end
        local made, err
        if due == "" then
          made, err = create("task", "--json", "--title", title)
        else
          made, err = create("task", "--json", "--title", title, "--due", due)
        end
        if made ~= nil then return { created = "task", title = made.title } end
        -- A date that didn't read: ask again rather than drop the task.
        if not err:find("as a date", 1, true) then error("Companion: " .. err, 0) end
        prompt = "Couldn't read “" .. due .. "”. Due"
      end
    end,
  }

  for short, key in pairs(opts.keys or {}) do
    rex.bind(key, "companion_" .. short)
  end
end

return M
