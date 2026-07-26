import SwiftUI

// A reusable list of tasks (Today / Upcoming / Overdue / a project's tasks). `total`, when it
// exceeds the shown rows, surfaces the truncated remainder as a footer.
struct TaskListView: View {
  let title: String
  let tasks: [WatchTask]
  var total: Int?
  var onComplete: (String) -> Void = { _ in }

  private var overflow: Int {
    guard let total else { return 0 }
    return max(0, total - tasks.count)
  }

  var body: some View {
    Group {
      if tasks.isEmpty {
        EmptyStateView(systemImage: "checkmark.circle", message: "Nothing here")
      } else {
        List {
          ForEach(tasks) { task in
            TaskRow(task: task)
              .swipeActions(edge: .trailing) {
                Button { onComplete(task.id) } label: {
                  Label("Done", systemImage: "checkmark")
                }
                .tint(.green)
              }
          }
          if overflow > 0 {
            Text("+\(overflow) more on your phone")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
      }
    }
    .navigationTitle(title)
  }
}

// Upcoming calendar events (today + the next several days), phone-formatted.
struct EventsView: View {
  let events: [WatchEvent]

  var body: some View {
    Group {
      if events.isEmpty {
        EmptyStateView(systemImage: "calendar", message: "No upcoming events")
      } else {
        List {
          ForEach(events) { EventRow(event: $0) }
        }
      }
    }
    .navigationTitle("Calendar")
  }
}

private struct EventRow: View {
  let event: WatchEvent

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: event.allDay != 0 ? "calendar" : "clock")
        .foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text(event.title)
          .lineLimit(2)
        Text(event.whenLabel)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
  }
}

// The Projects list; each row drills into that project's tasks.
struct ProjectsView: View {
  let projects: [WatchProject]
  var onComplete: (String) -> Void = { _ in }

  var body: some View {
    Group {
      if projects.isEmpty {
        EmptyStateView(systemImage: "folder", message: "No projects with tasks")
      } else {
        List {
          ForEach(projects) { project in
            NavigationLink {
              TaskListView(title: project.name, tasks: project.tasks, onComplete: onComplete)
            } label: {
              CountRow(title: project.name, systemImage: "folder", count: project.tasks.count)
            }
          }
        }
      }
    }
    .navigationTitle("Projects")
  }
}

// Quick-add: type/dictate a title and send it to the phone, which creates the task and echoes it
// back in the next snapshot. A date written into the title (e.g. "call Bob Friday 3pm") is
// detected automatically on the phone; the Due picker is just the fallback when the title has no
// date of its own.
struct AddTaskView: View {
  @ObservedObject var store: WatchStore
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var due: DueMode = .today
  // Debounces the phone parse request while typing.
  @State private var parseTask: Task<Void, Never>?

  // Mirrors the `due` values the phone's WatchTasksBridge understands. `none` = Someday (no due).
  enum DueMode: String, CaseIterable, Identifiable {
    case today, tomorrow, none
    var id: String { rawValue }
    var label: String {
      switch self {
      case .today: return "Today"
      case .tomorrow: return "Tomorrow"
      case .none: return "Someday"
      }
    }
  }

  private var canAdd: Bool {
    !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    Form {
      TextField("Task title", text: $title)

      // When the phone detects a date in the title, it wins — show it read-only. Offline, we can't
      // parse but can flag a likely date ("Due date detected"). Otherwise the Today/Tomorrow picker.
      if let detected = store.detectedDue {
        HStack {
          Text("Due")
          Spacer()
          Text(detected).foregroundStyle(.secondary)
        }
      } else if store.offlineDateHint {
        Label("Due date detected", systemImage: "icloud.slash")
          .foregroundStyle(.secondary)
      } else {
        Picker("Due", selection: $due) {
          ForEach(DueMode.allCases) { Text($0.label).tag($0) }
        }
      }

      Button {
        store.createTask(title: title, due: due.rawValue)
        dismiss()
      } label: {
        Label("Add", systemImage: "plus")
      }
      .disabled(!canAdd)
    }
    .navigationTitle("Add Task")
    .onAppear { store.detectedDue = nil; store.offlineDateHint = false }
    .onDisappear { parseTask?.cancel() }
    .onChange(of: title) { _, newValue in
      // Debounce, then ask the phone to detect a date in the title.
      parseTask?.cancel()
      parseTask = Task {
        try? await Task.sleep(nanoseconds: 400_000_000)
        if !Task.isCancelled { store.parseDue(newValue) }
      }
    }
  }
}
