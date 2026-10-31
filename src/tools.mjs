import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAME } from "./common.mjs";

// ---------- tools ----------

export const DEFAULT_MAX_WIDTH = 1280;
export const DEFAULT_TREE_MAX = 20_000;

export const appProp = { type: "string", description: "Bundle ID (e.g. com.brave.Browser) or app name; must be an allowed app." };
export const tabProp = { type: "string", description: "Agent tab ID from open_tab or list_tabs. Give tab instead of app to act inside that tab." };
export const elementProp = { type: "integer", minimum: 0, description: "Element number from the latest accessibility tree." };
export const maxWidthProp = {
  type: "integer", minimum: 0, maximum: 4000,
  description: `Downscale screenshots wider than this many pixels (default ${DEFAULT_MAX_WIDTH}; 0 keeps the original). Coordinates you pass later refer to the image you received; the bridge maps them back.`,
};
export const xyProps = { x: { type: "number" }, y: { type: "number" } };

// Actions shared by the single-action tools and batch. All accept app or tab.
export const ACTIONS = {
  click: {
    description: "Click an element (preferred) or coordinates [x, y] from the latest screenshot.",
    props: { element: elementProp, ...xyProps, button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "integer", minimum: 1, maximum: 3 } },
  },
  type_text: { description: "Type text into the focused element.", props: { text: { type: "string" } }, required: ["text"] },
  press_key: {
    description: "Press a key or combination, xdotool syntax: Return, Tab, Escape, Up, super+a (Cmd+A), shift+Tab. In a tab, hold: down keeps the key pressed (games, e.g. Up to accelerate) until press_key with hold: up or release.",
    props: { key: { type: "string" }, hold: { type: "string", enum: ["down", "up"], description: "Tabs only: down presses and holds the key; up lets it go. Omit to press and release." } },
    required: ["key"],
  },
  set_value: { description: "Set a settable element's value (e.g. a text field).", props: { element: elementProp, value: { type: "string" } }, required: ["element", "value"] },
  scroll: {
    description: "Scroll by pages: an app element, or in a tab an element, coordinates [x, y] or the page.",
    props: { element: elementProp, ...xyProps, direction: { type: "string", enum: ["up", "down", "left", "right"] }, pages: { type: "number", exclusiveMinimum: 0, maximum: 20 } },
    required: ["direction"],
  },
  drag: {
    description: "Drag between coordinates from the latest screenshot.",
    props: { from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } },
    required: ["from_x", "from_y", "to_x", "to_y"],
  },
  secondary_action: {
    description: "Perform an app element's listed secondary action (e.g. Raise, Copy, Increment); apps only.",
    props: { element: elementProp, action: { type: "string" } },
    required: ["element", "action"],
  },
};

// A batch step is any action's parameters plus "action"; secondary_action's own
// action name moves to "name" because "action" selects the step.
export const batchItemProps = Object.assign({}, ...Object.values(ACTIONS).map((d) => d.props), {
  action: { type: "string", enum: [...Object.keys(ACTIONS), "wait"] },
  name: { type: "string", description: "secondary_action only: the action name." },
  ms: { type: "integer", minimum: 0, maximum: 10_000, description: "wait only: milliseconds (default 500)." },
});

export const locatorProps = {
  css: { type: "string", description: "CSS selector." },
  role: { type: "string", description: "ARIA role, optionally with name." },
  name: { type: "string", description: "Accessible name for role." },
  text: { type: "string", description: "Visible text." },
  label: { type: "string", description: "Form label text." },
  placeholder: { type: "string" },
  test_id: { type: "string" },
  exact: { type: "boolean" },
  nth: { type: "integer", minimum: 0, description: "Pick the Nth match (0-based) when several match." },
};

export const TAB_TOOLS = ["list_tabs", "open_tab", "navigate_tab", "close_tab", "read_tab", "eval_tab", "tab_locator"];

export const TOOL_DEFS = [
  { name: "list_apps", readOnly: true, description: "List the apps this bridge may control and whether they are running.", props: {} },
  {
    name: "release",
    description: "Release computer use when you are done for now: at the end of a task, or before waiting more than a few minutes. Lets go of held keys, detaches agent tabs (they stay open) and stops the engine; the next call restarts it.",
    props: {},
  },
  {
    name: "launch_app",
    description: "Start an allowed app in the background without bringing it to the front.",
    props: { app: appProp },
    required: ["app"],
  },
  {
    name: "get_state",
    readOnly: true,
    description: "Return the accessibility tree of an app's key window or of an agent tab, with numbered elements. Element numbers are valid until the next call.",
    props: {
      app: appProp, tab: tabProp, screenshot: { type: "boolean" }, max_width: maxWidthProp,
      max_chars: { type: "integer", minimum: 0, description: `Return at most this many characters of the tree (default ${DEFAULT_TREE_MAX} unless the server sets treeMaxChars; 0 for no limit). Other tools always use the server's limit.` },
    },
  },
  { name: "screenshot", readOnly: true, description: "Screenshot of an app's key window or of an agent tab.", props: { app: appProp, tab: tabProp, max_width: maxWidthProp } },
  ...Object.entries(ACTIONS).map(([name, d]) => ({
    name,
    description: `${d.description} Returns the window's or tab's tree.`,
    props: { app: appProp, tab: tabProp, ...d.props },
    required: d.required,
  })),
  {
    name: "batch",
    description: "Run up to 25 actions in order in one call (click, type_text, press_key, set_value, scroll, drag, secondary_action, or wait with ms), then return the tree once. Stops at the first failing step. Element numbers are from the tree before the batch, so prefer coordinates or stable elements for later steps.",
    props: {
      app: appProp, tab: tabProp,
      actions: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", properties: batchItemProps, required: ["action"], additionalProperties: false } },
      screenshot: { type: "boolean", description: "Also return a screenshot after the last step." },
      max_width: maxWidthProp,
    },
    required: ["actions"],
  },
  {
    name: "list_tabs",
    readOnly: true,
    description: "List your agent tabs (the ones you can act on) and the browser's other tabs: the user's and other agents' (title and URL only; you cannot act on them).",
    props: { limit: { type: "integer", minimum: 1, maximum: 1000, description: "Most user tabs to list (default 50)." } },
  },
  {
    name: "open_tab",
    description: "Open a URL in a new background tab (in your own tab group) and return its tab ID and tree. Never touches the user's tabs or focus.",
    props: { url: { type: "string" } },
    required: ["url"],
  },
  {
    name: "navigate_tab",
    description: "Navigate an agent tab: goto (with url), back, forward or reload.",
    props: { tab: tabProp, action: { type: "string", enum: ["goto", "back", "forward", "reload"] }, url: { type: "string" } },
    required: ["tab", "action"],
  },
  { name: "close_tab", description: "Close an agent tab.", props: { tab: tabProp }, required: ["tab"] },
  {
    name: "read_tab",
    readOnly: true,
    description: "Read an agent tab's content: the visible text of the page or of a CSS selector (format text), or its HTML (format dom).",
    props: { tab: tabProp, format: { type: "string", enum: ["text", "dom"] }, selector: { type: "string" }, max_chars: { type: "integer", minimum: 100, maximum: 200_000 } },
    required: ["tab"],
  },
  {
    name: "eval_tab",
    readOnly: true,
    description: "Evaluate a JavaScript expression in an agent tab and return the JSON result. Read-only: the browser rejects any expression with side effects (DOM writes, events, network, storage).",
    props: { tab: tabProp, expression: { type: "string" }, max_chars: { type: "integer", minimum: 100, maximum: 200_000 } },
    required: ["tab", "expression"],
  },
  {
    name: "tab_locator",
    description: "Find an element in an agent tab (css, role+name, text, label, placeholder or test_id) and click, dblclick, fill, type, press (a key), check, uncheck, select_option, or read its text or count. Good for repetitive pages where element numbers shift.",
    props: {
      tab: tabProp, ...locatorProps,
      action: { type: "string", enum: ["click", "dblclick", "fill", "type", "press", "check", "uncheck", "select_option", "text", "count"] },
      value: { type: "string", description: "Text for fill/type, key for press (e.g. Enter), option for select_option." },
    },
    required: ["tab", "action"],
  },
];

export const APP_TOOLS = ["list_apps", "launch_app", "secondary_action"];

// Without app control (Linux) every tool works on tabs, so tab is required and app is gone.
export function tabOnlyDefs() {
  const { name: _name, ...items } = batchItemProps;
  items.action = { type: "string", enum: [...Object.keys(ACTIONS).filter((n) => !APP_TOOLS.includes(n)), "wait"] };
  return TOOL_DEFS.filter((d) => !APP_TOOLS.includes(d.name)).map((d) => {
    const props = { ...d.props };
    delete props.app;
    if (d.name === "batch") {
      props.actions = { ...props.actions, items: { ...props.actions.items, properties: items } };
      return { ...d, props, required: ["tab", "actions"], description: "Run up to 25 actions in an agent tab in order in one call (click, type_text, press_key, set_value, scroll, drag, or wait with ms), then return the tree once. Stops at the first failing step." };
    }
    const required = props.tab && !(d.required ?? []).includes("tab") ? ["tab", ...(d.required ?? [])] : d.required;
    return { ...d, props, required };
  });
}

// Without an allowed browser there are no tab tools, and app tools take only app.
// Without app control there are only tab tools.
export function toolDefs(tabs, apps = true) {
  if (!apps) return tabs ? tabOnlyDefs() : [];
  if (tabs) return TOOL_DEFS;
  return TOOL_DEFS.filter((d) => !TAB_TOOLS.includes(d.name)).map((d) => {
    const props = { ...d.props };
    delete props.tab;
    if (d.name === "scroll") {
      delete props.x;
      delete props.y;
      return { ...d, props, required: ["element", "direction"], description: "Scroll an app element by pages. Returns the window's tree." };
    }
    return { ...d, props };
  });
}

export const toolSchema = ({ name, description, props, required, readOnly }) => ({
  name,
  description,
  inputSchema: { type: "object", properties: props, required: required ?? [], additionalProperties: false },
  annotations: { readOnlyHint: !!readOnly, destructiveHint: !readOnly, openWorldHint: true },
});

export class BadInput extends Error {}

export const num = (v, name) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadInput(`${name} must be a number`);
  return v;
};
export const int = (v, name) => {
  if (!Number.isInteger(v) || v < 0) throw new BadInput(`${name} must be a non-negative integer`);
  return v;
};
export const str = (v, name, max = 20_000) => {
  if (typeof v !== "string" || v.length > max) throw new BadInput(`${name} must be a string of at most ${max} characters`);
  return v;
};
export const opt = (v, name, max) => (v === undefined ? undefined : str(v, name, max));

export const httpUrl = (v) => {
  str(v, "url", 4000);
  let u;
  try { u = new URL(v); } catch { throw new BadInput("url must be an absolute http(s) URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BadInput("url must be http or https");
  return u.toString();
};

export const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

// Pixel width of a PNG or JPEG, or undefined.
export function imageWidth(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return buf.readUInt16BE(i + 7);
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

// Downscales an image block with macOS sips; returns the block and the scale factor.
export async function scaleImage(block, maxWidth) {
  const buf = Buffer.from(block.data, "base64");
  const width = imageWidth(buf);
  if (!maxWidth || !width || width <= maxWidth) return { block, scale: 1 };
  const dir = await mkdtemp(join(tmpdir(), `${NAME}-`));
  try {
    const src = join(dir, block.mimeType === "image/png" ? "in.png" : "in.jpg");
    const out = join(dir, "out.jpg");
    await writeFile(src, buf);
    await new Promise((resolve, reject) => execFile("/usr/bin/sips",
      ["--resampleWidth", String(maxWidth), "-s", "format", "jpeg", "-s", "formatOptions", "75", src, "--out", out],
      (e) => (e ? reject(e) : resolve())));
    const data = (await readFile(out)).toString("base64");
    return { block: { type: "image", mimeType: "image/jpeg", data }, scale: width / maxWidth, width };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
