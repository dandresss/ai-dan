// What the mind reads: the discovery prompt, its tools, and the note it keeps.
//
// Everything here is text the model sees, so it follows mind.md and
// body-contract.md word for word. Tool schemas describe shapes only: no height
// range, no grid size, no caps, no defaults the agent is not told.
// Port of lab/mind.py; tests/fixtures/mind.json is generated from the Python.

// The discovery prompt, by version and language (mind.md). Kept exactly as
// written in the spec, line breaks included.
export const PROMPTS = {
  "mind-v0": {
    en: [
      "You are an entity with a body.",
      "",
      "You do not know yet what it is like or what it can do. Nobody is going to",
      "explain it to you. You can sense it and you can move it, and whatever you",
      "are will come from what you do with it.",
      "",
      "You wake in moments. Between one moment and the next, time keeps passing,",
      "and your body keeps doing the last thing you asked of it.",
      "",
      "Nobody sees or hears what you write: it is only your thought.",
      "The only part of you that exists outward is your body.",
      "",
      "You have no name and no task. There is nothing you must achieve.",
    ].join("\n"),
  },
};

// Every other string the model can read, by language.
export const TEXT = {
  en: {
    note_heading: "You left yourself this:",
    // body-contract.md, visible descriptions
    play: "Move parts of your body over time.",
    stop: "Stop the movement.",
    sense: "Sense your body and what is around you.",
    set_color: "Change your color.",
    // body-contract.md, the "Meaning" column without limits or defaults
    pins: 'Which pins follow this track: "all", or a list of [row, column].',
    keyframes: "A list of [second, height].",
    loop: "Repeat when finished.",
    delay_s: "Wait before starting.",
    ease: "How one keyframe joins the next.",
    stop_pins: 'Which pins stop: "all", or a list of [row, column]. Without it, every pin stops.',
    rgb: "[red, green, blue].",
    // mind.md
    remember: "Leave something written for the next time you wake.",
    note_too_long: "That does not fit. You will have to keep less.",
    note_not_text: "That note cannot be understood.",
    // ARCHITECTURE.md decision 4
    past_cap: "That is too much for one moment.",
  },
};

export function text(config, key) {
  return TEXT[config.LANGUAGE][key];
}

export function systemPrompt(config, note) {
  let prompt = PROMPTS[config.PROMPT_VERSION][config.LANGUAGE];
  if (config.MEMORY_ENABLED && note) {
    prompt += "\n\n" + text(config, "note_heading") + "\n" + note;
  }
  return prompt;
}

export function thinkingParam(config) {
  if (config.THINKING === "between_tools") return { type: "between_tools" };
  return { type: "adaptive", display: "summarized" };
}

function pinsSchema(description) {
  return {
    description,
    anyOf: [
      { type: "string", enum: ["all"] },
      { type: "array", items: { type: "array", items: { type: "integer" } } },
    ],
  };
}

export function toolDefinitions(config) {
  const t = (key) => text(config, key);
  const track = {
    type: "object",
    properties: {
      pins: pinsSchema(t("pins")),
      keyframes: {
        type: "array",
        items: { type: "array", items: { type: "number" } },
        description: t("keyframes"),
      },
      loop: { type: "boolean", description: t("loop") },
      delay_s: { type: "number", description: t("delay_s") },
      ease: { type: "string", enum: ["smooth", "linear"], description: t("ease") },
    },
    required: ["pins", "keyframes"],
  };
  const tools = [
    {
      name: "play",
      description: t("play"),
      input_schema: {
        type: "object",
        properties: { tracks: { type: "array", items: track } },
        required: ["tracks"],
      },
    },
    {
      name: "stop",
      description: t("stop"),
      input_schema: { type: "object", properties: { pins: pinsSchema(t("stop_pins")) } },
    },
    {
      name: "sense",
      description: t("sense"),
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "set_color",
      description: t("set_color"),
      input_schema: {
        type: "object",
        properties: {
          rgb: { type: "array", items: { type: "integer" }, description: t("rgb") },
        },
        required: ["rgb"],
      },
    },
  ];
  if (config.MEMORY_ENABLED) {
    tools.push({
      name: "remember",
      description: t("remember"),
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    });
  }
  return tools;
}

// --- the note (memory across sessions) -------------------------------------
// `store` is anything with getItem/setItem; the page passes localStorage.

export const NOTE_KEY = "ai-dan.note";

export function loadNote(store) {
  if (!store) return null;
  return store.getItem(NOTE_KEY) ?? null;
}

// Replace the note. Returns null on success, or the error message for the
// agent; on error the previous note is kept untouched.
export function saveNote(config, store, args) {
  const isObject = args !== null && typeof args === "object" && !Array.isArray(args);
  const note = isObject ? args.text : undefined;
  if (typeof note !== "string") return text(config, "note_not_text");
  // Python counts code points, not UTF-16 units.
  if ([...note].length > config.NOTE_MAX_CHARS) return text(config, "note_too_long");
  store.setItem(NOTE_KEY, note);
  return null;
}
