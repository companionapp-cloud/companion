// Captures the screenshots the docs embed (apps/website/public/docs/*.png).
//
// It boots the web app's dev server, seeds a throwaway workspace through the core
// bridge that `apps/web` exposes on `window.__companion` in dev, then drives the real
// UI and screenshots each screen. Every shot therefore comes from the code in this
// repo — if the UI changes, re-run this and the docs images follow.
//
//   npm --prefix apps/website run capture:docs
//
// Requires a Chromium for Playwright once:  npx playwright install chromium
// Set CAPTURE_BASE_URL to point at an already-running dev server instead of spawning one.
// Set CAPTURE_OUT_DIR to write somewhere else (e.g. a scratch dir while fixing a broken
// step) — a run starts by emptying its output directory.

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = process.env.CAPTURE_OUT_DIR ? path.resolve(process.env.CAPTURE_OUT_DIR) : path.join(here, "../public/docs");

const BASE_URL = process.env.CAPTURE_BASE_URL ?? "http://localhost:5273";
const VIEWPORT = { width: 1440, height: 900 };

// ---------------------------------------------------------------- dev server

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server never came up at ${url}`);
}

function startDevServer() {
  const child = spawn("npm", ["run", "dev", "-w", "@companion/web"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  child.stdout.on("data", (b) => process.env.CAPTURE_VERBOSE && process.stdout.write(`[vite] ${b}`));
  // Once we're shutting the server down, npm's SIGTERM death rattle (code 143) isn't news.
  child.stderr.on("data", (b) => !child.stopping && process.stderr.write(`[vite] ${b}`));
  return child;
}

function stopDevServer(child) {
  if (!child) return;
  child.stopping = true;
  child.kill("SIGTERM");
}

// ---------------------------------------------------------------- seed data

/** Deterministic-ish demo workspace, written straight through the core bridge. */
async function seed(page) {
  await page.waitForFunction(() => Boolean(window.__companion?.core), null, { timeout: 60_000 });

  return page.evaluate(async () => {
    const core = window.__companion.core;
    const call = (m, p) => core.invoke(m, p);

    // Dates relative to "now" so the screenshots never look stale.
    const now = new Date();
    const at = (dayOffset, hour, minute = 0) => {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hour, minute, 0, 0);
      return d.toISOString();
    };
    const isoDate = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const fullDate = (d) =>
      d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

    // --- object type: Meeting (notes get attendees / decision / follow-up) ---
    const meeting = await call("objectTypes.create", {
      name: "Meeting",
      appliesTo: "note",
      schemaJson: {
        icon: "chat",
        color: "#6E56CF",
        fields: [
          { key: "attendees", type: "text", label: "Attendees" },
          { key: "decision", type: "text", label: "Decision" },
          { key: "follow_up", type: "date", label: "Follow-up date" },
        ],
      },
    });

    // --- area + project ---
    const area = await call("areas.create", { name: "Work" });
    const project = await call("projects.create", { areaId: area.id, name: "v1.2 launch" });
    // A few more projects, so the command palette's project chips have something to walk.
    await call("projects.create", { areaId: area.id, name: "Hiring" });
    const home = await call("areas.create", { name: "Home" });
    await call("projects.create", { areaId: home.id, name: "Kitchen renovation" });

    // --- tasks ---
    const draft = await call("tasks.create", {
      title: "Draft the launch announcement",
      dueAt: at(0, 17),
    });
    const pricing = await call("tasks.create", {
      title: "Review pricing page copy",
      dueAt: at(1, 17),
      remindAt: at(1, 9),
    });
    const sync = await call("tasks.create", {
      title: "Weekly team sync",
      dueAt: at(1, 9),
      repeatRule: "FREQ=WEEKLY;BYDAY=MO",
    });
    const investor = await call("tasks.create", {
      title: "Send the investor update",
      dueAt: at(5, 9),
    });

    // --- notes (wikilinks are id-typed: [[task:<id>]] / [[note:<id>]]) ---
    const planMarkdown = [
      "Shipping v1.2 at the end of the month. Risks are mostly on the pricing page.",
      "",
      "## What has to happen",
      "",
      "- Finish the pricing page copy",
      "- Line up the announcement post",
      "- Brief support on the new billing flow",
      "",
      // Wikilinks carry an optional |alias — the chip falls back to the raw id without one.
      `Tracking the work in [[task:${pricing.id}|Review pricing page copy]] and [[task:${draft.id}|Draft the launch announcement]].`,
      "",
    ].join("\n");

    const plan = await call("notes.create", {
      title: "Launch plan — v1.2",
      contentMd: planMarkdown,
    });

    const positioning = await call("notes.create", {
      title: "Pricing page positioning",
      contentMd: [
        "Three tiers, annual by default, and a self-host row that points at the docs.",
        "Keep the copy short — the page is doing too much work today.",
        "",
        `Part of [[note:${plan.id}|Launch plan — v1.2]].`,
        "",
      ].join("\n"),
    });

    await call("notes.create", {
      title: "Launch sync — Monday",
      objectTypeId: meeting.id,
      props: {
        attendees: "Sam, Priya, Alex",
        decision: "Ship on the 30th; pricing page is the blocker",
        follow_up: isoDate(new Date(now.getTime() + 4 * 864e5)),
      },
      contentMd: [
        "Sam walked through the billing flow. Priya owns the pricing page copy; Alex drafts the announcement.",
        "",
        `Decisions land in [[note:${plan.id}|Launch plan — v1.2]].`,
        "",
      ].join("\n"),
    });

    // --- daily note (an ordinary note stamped with today's date). Its link to the plan keeps
    // it in the graph's one cluster instead of floating off on its own. ---
    await call("notes.create", {
      title: fullDate(now),
      date: isoDate(now),
      contentMd: [
        "Head down on the launch today. Pricing page copy is the long pole — everything else is queued behind it.",
        "",
        "- Sat with support on the billing questions",
        "- Priya's draft looks close; one more pass tomorrow",
        `- Checklist is in [[note:${plan.id}|Launch plan — v1.2]]`,
        "",
      ].join("\n"),
    });

    // --- file everything under the project ---
    await call("projects.addMembers", {
      projectId: project.id,
      entityType: "task",
      entityIds: [draft.id, pricing.id, sync.id, investor.id],
    });
    await call("projects.addMembers", {
      projectId: project.id,
      entityType: "note",
      entityIds: [plan.id, positioning.id],
    });

    // --- a canvas: the launch, laid out. Cards reference the notes and tasks above; x/y are
    // the top-left corner, on the board's 8px grid, and the whole layout keeps roughly the pane's
    // proportions so that Fit board leaves the cards legible. Groups sit behind their contents (z -1). ---
    const canvas = await call("canvases.create", { name: "Launch map" });
    const card = (kind, x, y, width, height, extra = {}) => ({ kind, x, y, width, height, data: {}, ...extra });
    const ref = (type, entity, x, y, height) => card(type, x, y, 260, height, { refType: type, refId: entity.id });
    const nodes = await call("canvases.nodes.upsert", {
      canvasId: canvas.id,
      nodes: [
        ref("note", plan, 0, 72, 170),
        card("text", 16, 312, 220, 140, { data: { text: "Ship on the 30th.\nPricing page is the long pole." } }),
        card("group", 320, 0, 600, 248, { z: -1, color: "#14b8a6", data: { label: "Pricing page" } }),
        ref("note", positioning, 344, 56, 170),
        ref("task", pricing, 632, 56, 92),
        card("group", 320, 296, 600, 224, { z: -1, color: "#8b5cf6", data: { label: "Announcement" } }),
        ref("task", draft, 344, 352, 92),
        card("text", 632, 352, 220, 140, {
          color: "#8b5cf6",
          data: { text: "Lead with self-hosting — it's what people ask about first." },
        }),
        ref("task", investor, 344, 568, 92),
      ],
    });
    const [planCard, , , positioningCard, , , draftCard, , investorCard] = nodes;
    const arrow = (from, to, label = "") => ({
      fromNodeId: from.id,
      toNodeId: to.id,
      fromEnd: "none",
      toEnd: "arrowFilled",
      style: "curved",
      label,
    });
    await call("canvases.edges.upsert", {
      canvasId: canvas.id,
      edges: [arrow(planCard, positioningCard), arrow(planCard, draftCard), arrow(draftCard, investorCard, "then")],
    });
    await call("projects.addMembers", { projectId: project.id, entityType: "canvas", entityIds: [canvas.id] });

    return { planId: plan.id, planMarkdown, projectId: project.id };
  });
}

// ---------------------------------------------------------------- helpers

/** Screenshot the app, minus the blinking caret and any focus ring. */
async function shot(page, name) {
  await page.evaluate(() => {
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    window.getSelection()?.removeAllRanges();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  process.stdout.write(`  ✓ ${name}.png\n`);
}

const go = async (page, route) => {
  await page.goto(`${BASE_URL}${route}`);
  await page.waitForTimeout(1200);
};

/**
 * Notes and Tasks open on the "Unsorted" filter, and the seeded workspace files
 * everything under a project — so the lists start empty. Switch to "All" before
 * looking for anything in them.
 */
async function setListFilter(page, label) {
  await page.getByLabel("Filter list").click();
  await page.getByText(label, { exact: true }).click();
  await page.waitForTimeout(600);
}

/**
 * Open a note/task from the browse list by its exact title. Matching loosely would also hit
 * the *preview* line of other rows — a note that links to "Launch plan — v1.2" carries that
 * title in its own preview text, and a substring match lands on the wrong row.
 */
async function openFromList(page, title) {
  await page.getByText(title, { exact: true }).first().click();
  await page.waitForTimeout(800);
}

/** The rail expands on hover; pin it so the sidebar shows in a screenshot. */
async function pinSidebar(page) {
  await page.mouse.move(20, 300);
  await page.waitForTimeout(400);
  const pin = page.getByLabel("Pin sidebar");
  if (await pin.isVisible().catch(() => false)) await pin.click();
  await page.waitForTimeout(400);
}

/**
 * Screenshot the command palette with some of the app around it. A full-viewport shot would
 * leave the palette a small card in a sea of scrim, so clip to the card plus a margin. Unlike
 * `shot`, this keeps focus where it is — the focused project chip is part of the picture.
 */
async function paletteShot(page, name) {
  const panel = page.locator('[aria-label="Close quick capture"] + div');
  const box = await panel.boundingBox();
  const margin = { x: 200, top: 96, bottom: 72 };
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    // A caret mid-blink would make the shot differ from run to run.
    caret: "hide",
    clip: {
      x: Math.max(0, box.x - margin.x),
      y: Math.max(0, box.y - margin.top),
      width: Math.min(VIEWPORT.width, box.width + margin.x * 2),
      height: box.height + margin.top + margin.bottom,
    },
  });
  process.stdout.write(`  ✓ ${name}.png\n`);
}

// ---------------------------------------------------------------- capture

async function capture(page, seeded) {
  // Today — daily note, month strip, agenda
  await go(page, "/today");
  await shot(page, "today");

  // Notes — the editor
  await go(page, "/notes");
  await setListFilter(page, "All notes");
  await openFromList(page, "Launch plan — v1.2");
  await shot(page, "note-editor");

  // The note's graph panel
  await page.getByLabel("Show note graph").click();
  await page.waitForTimeout(1500);
  await shot(page, "note-graph");
  await page.getByLabel("Show document").click();
  await page.waitForTimeout(500);

  // [[ autocomplete, mid-search. Text locators are unreliable inside the editor (the body
  // also renders as the list's preview line, and a paragraph full of chips is a moving
  // target), so click the empty space below the last block — ProseMirror puts the caret at
  // the end of the document — and type there.
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible" });
  const box = await editor.boundingBox();
  await page.mouse.click(box.x + 120, box.y + box.height - 24);
  await page.waitForTimeout(200);
  await page.keyboard.type("\nSee also [[");
  await page.waitForTimeout(300);
  await page.keyboard.type("pricing", { delay: 60 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "note-wikilink.png") });
  process.stdout.write("  ✓ note-wikilink.png\n");
  await page.keyboard.press("Escape");

  // The typed "See also [[pricing" is now autosaved into the note, and it would show up in
  // every later shot that previews it (the project view, the graph). Editor-level undo is
  // flaky here, so close the editor and rewrite the note's markdown through the core.
  await go(page, "/today");
  await page.evaluate(
    ({ id, md }) => window.__companion.core.invoke("notes.update", { id, contentMd: md }),
    { id: seeded.planId, md: seeded.planMarkdown },
  );
  await page.reload();
  await page.waitForTimeout(1500);

  // A typed note + its metadata panel
  await go(page, "/notes");
  await setListFilter(page, "All notes");
  await openFromList(page, "Launch sync — Monday");
  await page.getByLabel("Show metadata").click();
  await page.waitForTimeout(600);
  await shot(page, "note-metadata");

  // Tasks — the task editor (due date, reminder, repeat, type)
  await go(page, "/tasks");
  await setListFilter(page, "All tasks");
  await openFromList(page, "Review pricing page copy");
  await shot(page, "task-editor");

  // Projects — sidebar hierarchy + a project view, with one of its notes open so the view
  // isn't mostly an empty "Nothing selected" pane
  await pinSidebar(page);
  await page.getByText("v1.2 launch").first().click();
  await page.waitForTimeout(1000);
  await openFromList(page, "Launch plan — v1.2");
  await shot(page, "project-view");

  // Canvases — the seeded board, fitted to the pane
  await go(page, "/canvases");
  await openFromList(page, "Launch map");
  await page.waitForTimeout(1200);
  await page.locator('[aria-label^="Fit board"]').click();
  await page.waitForTimeout(800);
  await shot(page, "canvas");

  // The command palette, over Today: its commands, a new task being filed, and a search
  await go(page, "/today");
  await page.getByText("Capture", { exact: true }).click();
  await page.waitForTimeout(600);
  await paletteShot(page, "palette");

  await page.keyboard.press("Enter"); // New task is the first command
  await page.waitForTimeout(400);
  await page.keyboard.type("Book the launch venue", { delay: 20 });
  await page.keyboard.press("Tab"); // onto the first project chip
  await paletteShot(page, "palette-new-task");

  await page.keyboard.press("Escape"); // back to the commands
  await page.waitForTimeout(300);
  await page.keyboard.type("launch", { delay: 40 });
  await page.waitForTimeout(700);
  await paletteShot(page, "palette-find");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Graph — let the layout settle, then fit it to the canvas
  await go(page, "/graph");
  await page.waitForTimeout(2500);
  await page.getByLabel("Fit", { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await shot(page, "graph");

  // Calendar
  await go(page, "/calendar");
  await page.waitForTimeout(1200);
  await shot(page, "calendar");

  // Settings. Each section name appears twice — once in the settings nav, once as the
  // panel heading — so take the first (the nav row).
  const settingsSection = (name) => page.getByText(name, { exact: true }).first();

  // Objects (the Meeting type, expanded)
  await go(page, "/settings");
  await settingsSection("Objects").click();
  await page.waitForTimeout(500);
  await page.getByText("Meeting", { exact: true }).first().click();
  await page.waitForTimeout(600);
  await shot(page, "object-type");
  // The type opens in a dialog, whose scrim would swallow the next click on the settings nav.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // AI — the Add agent sheet on its Cloud tab, which shows where an API key is kept. (Its
  // first tab only explains the desktop app on the web, since a browser can't host agents.)
  await settingsSection("AI").click();
  await page.waitForTimeout(600);
  await page.getByLabel("Add agent", { exact: true }).click();
  await page.getByText("Cloud", { exact: true }).click();
  await page.waitForTimeout(600);
  await shot(page, "ai-settings");
  // As above — but this sheet covers the middle of its scrim, so click the scrim's corner.
  await page.getByLabel("Close", { exact: true }).first().click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(400);

  // Sync
  await settingsSection("Sync").click();
  await page.waitForTimeout(600);
  await shot(page, "sync-settings");

  // Chat — the empty state until an agent is installed
  await go(page, "/chat");
  await shot(page, "chat-empty");
}

// ---------------------------------------------------------------- main

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const server = process.env.CAPTURE_BASE_URL ? null : startDevServer();
  const browser = await chromium.launch();
  try {
    await waitForServer(BASE_URL);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => process.stderr.write(`[page] ${e.message}\n`));

    await page.goto(`${BASE_URL}/today`);
    process.stdout.write("seeding demo workspace…\n");
    const seeded = await seed(page);
    await page.reload();
    await page.waitForTimeout(2000);

    process.stdout.write(`capturing to ${path.relative(repoRoot, outDir)}\n`);
    await capture(page, seeded);
  } finally {
    await browser.close();
    stopDevServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
