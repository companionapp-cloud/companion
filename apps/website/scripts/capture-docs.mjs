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

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = path.join(here, "../public/docs");

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

    // --- daily note (an ordinary note stamped with today's date) ---
    await call("notes.create", {
      title: fullDate(now),
      date: isoDate(now),
      contentMd: [
        "Head down on the launch today. Pricing page copy is the long pole — everything else is queued behind it.",
        "",
        "- Sat with support on the billing questions",
        "- Priya's draft looks close; one more pass tomorrow",
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

  // Projects — sidebar hierarchy + a project view
  await pinSidebar(page);
  await page.getByText("v1.2 launch").first().click();
  await page.waitForTimeout(1000);
  await shot(page, "project-view");

  // Graph
  await go(page, "/graph");
  await page.waitForTimeout(2500);
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

  // AI providers
  await settingsSection("AI").click();
  await page.waitForTimeout(600);
  await shot(page, "ai-settings");

  // Sync
  await settingsSection("Sync").click();
  await page.waitForTimeout(600);
  await shot(page, "sync-settings");

  // Chat — the empty state until a provider is connected
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
