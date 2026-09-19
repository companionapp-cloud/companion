import type { CSSProperties } from "react";
import { ProjectMockup, type ProjectSection } from "./ProjectMockups";

// The landing page's project cards: a close-up of each section a project holds, two to a row
// (one on narrow screens, see .project-grid), each with a line or two on what it does.

const CARDS: { section: ProjectSection; title: string; body: string }[] = [
  {
    section: "notes",
    title: "Project notes",
    body: "Quotes, measurements and meeting notes stay with the project they belong to, in a list you can search. File a note from its folder menu, or drag it onto the project in the sidebar.",
  },
  {
    section: "tasks",
    title: "Project tasks",
    body: "See what's due today, what repeats and what's already done. The progress ring fills as you check tasks off.",
  },
  {
    section: "lists",
    title: "Project task lists",
    body: "Drag a project's tasks into the order you'll tackle them, with headings that split a list into stages.",
  },
  {
    section: "canvases",
    title: "Project canvases",
    body: "Map a project out on an open board, with stickies, groups and arrows around your real notes, tasks and events.",
  },
  {
    section: "calendars",
    title: "Project calendars",
    body: "Add the calendars a project runs on, from a whole account to a single subscription. Their events land on the project's own calendar, beside its tasks.",
  },
  {
    section: "habits",
    title: "Project habits, coming soon",
    body: "Pair a project with the routines that move it forward, and watch the streak grow every time you check in.",
  },
];

export function ProjectShowcase() {
  return (
    <div className="project-grid">
      {CARDS.map((card) => (
        <article key={card.section} style={cardStyle}>
          <div style={{ borderBottom: "1px solid #e0e0dc" }}>
            <ProjectMockup section={card.section} />
          </div>
          <div style={{ padding: "22px 24px 26px" }}>
            <h3 style={cardTitle}>{card.title}</h3>
            <p style={cardBody}>{card.body}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

const cardStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  background: "#ffffff",
  border: "1px solid #e0e0dc",
  borderRadius: 14,
};

const cardTitle: CSSProperties = {
  margin: 0,
  fontFamily: "'Geist', sans-serif",
  fontSize: 18,
  fontWeight: 600,
  lineHeight: 1.3,
  letterSpacing: "-0.01em",
  color: "#1a1a18",
};

const cardBody: CSSProperties = {
  margin: "8px 0 0",
  fontFamily: "'Geist', sans-serif",
  fontSize: 15.5,
  lineHeight: 1.55,
  color: "#595954",
  textWrap: "pretty",
};
