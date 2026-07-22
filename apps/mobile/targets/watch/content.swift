import SwiftUI

// Root menu: quick-add plus the four ways into the task lists. Counts come from the snapshot's
// meta (true totals), so a badge can exceed the truncated list it links to. Re-reads the cached
// snapshot on foreground; live updates arrive via the store's WCSession delegate.
struct RootView: View {
  @StateObject private var store = WatchStore()
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      List {
        NavigationLink {
          AddTaskView(store: store)
        } label: {
          Label("Add Task", systemImage: "plus.circle.fill")
        }

        Section {
          NavigationLink {
            TaskListView(title: "Today", tasks: store.snapshot.today, total: store.snapshot.meta?.todayCount, onComplete: complete)
          } label: {
            CountRow(title: "Today", systemImage: "sun.max", count: store.snapshot.meta?.todayCount ?? 0)
          }
          NavigationLink {
            TaskListView(title: "Upcoming", tasks: store.snapshot.upcoming, total: store.snapshot.meta?.upcomingCount, onComplete: complete)
          } label: {
            CountRow(title: "Upcoming", systemImage: "calendar", count: store.snapshot.meta?.upcomingCount ?? 0)
          }
          NavigationLink {
            TaskListView(title: "Overdue", tasks: store.snapshot.overdue, total: store.snapshot.meta?.overdueCount, onComplete: complete)
          } label: {
            CountRow(title: "Overdue", systemImage: "exclamationmark.circle", count: store.snapshot.meta?.overdueCount ?? 0, tint: .red)
          }
          NavigationLink {
            TaskListView(title: "Someday", tasks: store.snapshot.someday, total: store.snapshot.meta?.somedayCount, onComplete: complete)
          } label: {
            CountRow(title: "Someday", systemImage: "tray", count: store.snapshot.meta?.somedayCount ?? 0)
          }
        }

        Section {
          NavigationLink {
            EventsView(events: store.snapshot.events)
          } label: {
            CountRow(title: "Calendar", systemImage: "calendar.badge.clock", count: store.snapshot.meta?.eventCount ?? 0)
          }
          NavigationLink {
            ProjectsView(projects: store.snapshot.projects, onComplete: complete)
          } label: {
            CountRow(title: "Projects", systemImage: "folder", count: store.snapshot.projects.count)
          }
        }

        if !store.hasData {
          Text("Open Companion on your phone to sync.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Companion")
    }
    .onAppear { store.refresh() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { store.refresh() }
    }
  }

  private func complete(_ id: String) {
    store.completeTask(id: id)
  }
}

// A menu row: icon + title on the left, a count badge on the right when non-zero.
struct CountRow: View {
  let title: String
  let systemImage: String
  let count: Int
  var tint: Color = .accentColor

  var body: some View {
    HStack {
      Label(title, systemImage: systemImage)
      Spacer()
      if count > 0 {
        Text("\(count)")
          .font(.footnote)
          .foregroundStyle(tint)
          .monospacedDigit()
      }
    }
  }
}

// A single task row: a status dot, the title, and its due label (red when past due).
struct TaskRow: View {
  let task: WatchTask

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "circle")
        .foregroundStyle(task.isOverdue ? .red : .secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text(task.title)
          .lineLimit(2)
        if !task.dueLabel.isEmpty {
          Text(task.dueLabel)
            .font(.footnote)
            .foregroundStyle(task.isOverdue ? .red : .secondary)
        }
      }
    }
    .padding(.vertical, 2)
  }
}

// Centered empty-state used by the list screens.
struct EmptyStateView: View {
  let systemImage: String
  let message: String

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: systemImage)
        .font(.title2)
        .foregroundStyle(.secondary)
      Text(message)
        .font(.footnote)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

#Preview {
  RootView()
}
