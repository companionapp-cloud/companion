import type { AiTask } from "@companion/core-bridge";
import type { AiApplyMode } from "@companion/editor";
import type { IconName } from "@companion/design-system";

// The note editor's writing assists (core/bridge/ai.go runs them): what the AI menu lists, what
// each asks for before it runs, and where its result can go.

export interface AssistDef {
  task: AiTask;
  label: string;
  icon: IconName;
  /** One line under the label in the menu. */
  hint: string;
  /** What the reader supplies before the run: nothing, an instruction, a grade, a language. */
  input: "none" | "prompt" | "grade" | "language";
}

export const ASSISTS: AssistDef[] = [
  { task: "generate", label: "Write with AI", icon: "sparkle", hint: "Draft or rewrite from a prompt", input: "prompt" },
  { task: "readingLevel", label: "Change reading level", icon: "gauge", hint: "Simplify or elevate the writing", input: "grade" },
  { task: "grammar", label: "Check grammar", icon: "check", hint: "Spelling, grammar and punctuation", input: "none" },
  { task: "summarize", label: "Summarize", icon: "listBullet", hint: "The gist and key points", input: "none" },
  { task: "translate", label: "Translate", icon: "languages", hint: "Into another language", input: "language" },
  { task: "critique", label: "Critique", icon: "quote", hint: "Candid editorial feedback", input: "none" },
  { task: "metadata", label: "Fill in metadata", icon: "tag", hint: "Set the note's type and fields", input: "none" },
];

export const assistFor = (task: AiTask): AssistDef => ASSISTS.find((a) => a.task === task)!;

/** A way to use a finished result, shown as a button. */
export interface ApplyAction {
  label: string;
  mode: AiApplyMode;
  primary?: boolean;
}

/** Where a text task's result can go, by whether it acted on a selection. Grammar, critique and
 *  metadata have their own result views. */
export function applyActions(task: AiTask, selection: boolean): ApplyAction[] {
  switch (task) {
    case "generate":
      return selection
        ? [
            { label: "Replace selection", mode: "replace", primary: true },
            { label: "Insert below", mode: "insertAfter" },
          ]
        : [{ label: "Insert", mode: "cursor", primary: true }];
    case "readingLevel":
    case "translate":
      return [
        { label: selection ? "Replace selection" : "Replace note", mode: "replace", primary: true },
        { label: selection ? "Insert below" : "Add to end", mode: "insertAfter" },
      ];
    case "summarize":
      return selection
        ? [{ label: "Insert below", mode: "insertAfter", primary: true }]
        : [
            { label: "Insert at top", mode: "insertBefore", primary: true },
            { label: "Add to end", mode: "insertAfter" },
          ];
    default:
      return [];
  }
}

export const READING_LEVELS: { grade: number; label: string }[] = [
  { grade: 3, label: "Grade 3" },
  { grade: 5, label: "Grade 5" },
  { grade: 8, label: "Grade 8" },
  { grade: 10, label: "Grade 10" },
  { grade: 12, label: "Grade 12" },
  { grade: 14, label: "College" },
  { grade: 17, label: "Expert" },
];

export const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Japanese",
  "Chinese (Simplified)",
  "Korean",
  "Hindi",
  "Arabic",
];

/** Prompt starters under the generate field, by whether there is a selection to work on. */
export const PROMPT_STARTERS = {
  selection: ["Make it shorter", "Make it more formal", "Expand on this", "Turn into a bulleted list"],
  cursor: ["Continue writing", "Draft an introduction", "Outline the key sections", "Brainstorm ideas"],
};
