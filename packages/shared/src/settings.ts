/**
 * @lain/shared — declarative settings schema.
 *
 * The SINGLE source of truth for every user-configurable setting. The CLI, TUI,
 * and web UI all render and edit settings off this schema, so adding a setting
 * here makes it editable everywhere. Each field maps a dotted key to either the
 * config store (~/.config/lain/config.json or .lain/config.json) or the
 * credentials store (~/.config/lain/credentials.json).
 */
import type { LainConfig, Provider } from "./index.js";
import { DEFAULT_CONFIG } from "./index.js";
import {
  type Credentials,
  loadConfig, loadCredentials,
  saveConfig, saveCredentials, saveWorkspaceConfig,
  unsetConfigPath, unsetCredentialPath,
} from "./config.js";

export type SettingType = "string" | "secret" | "number" | "boolean" | "select";

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingField {
  /** Dotted key in the unified namespace. Config fields: path in config.json.
   *  Credential fields: prefixed with `credentials.` (e.g. credentials.anthropic.apiKey). */
  key: string;
  label: string;
  description?: string;
  type: SettingType;
  section: string;
  store: "config" | "credentials";
  options?: SettingOption[];
  /** Free-text suggestions (e.g. model names) shown as hints. */
  suggestions?: string[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export interface SettingSection {
  id: string;
  title: string;
  description?: string;
}

export const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Anthropic (direct API)" },
  { value: "bedrock", label: "Amazon Bedrock (bearer token)" },
  { value: "openai", label: "OpenAI / compatible (ollama, together, …)" },
  { value: "openrouter", label: "OpenRouter" },
];

/** Free-text model suggestions per provider — not an allowlist. */
export const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  bedrock: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-20250414", "claude-3-5-sonnet-20241022"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  openrouter: ["anthropic/claude-sonnet-4.5", "openai/gpt-4o", "google/gemini-2.0-flash-001"],
};

const ALL_MODEL_SUGGESTIONS = Array.from(new Set(Object.values(MODEL_SUGGESTIONS).flat()));

export const SETTINGS_SECTIONS: SettingSection[] = [
  { id: "provider", title: "Provider & model", description: "Which LLM powers generation." },
  { id: "credentials", title: "Credentials", description: "API keys, stored locally in ~/.config/lain/credentials.json." },
  { id: "generation", title: "Generation defaults", description: "Defaults for new explorations." },
  { id: "behavior", title: "Agent behavior", description: "How the agent substrate runs." },
  { id: "integrations", title: "Sync & synthesis", description: "Obsidian watch + synthesis behavior." },
];

export const SETTINGS_FIELDS: SettingField[] = [
  // ---- Provider & model ----
  { key: "defaultProvider", label: "Provider", type: "select", section: "provider", store: "config",
    options: PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
    description: "The default LLM provider." },
  { key: "defaultModel", label: "Model", type: "string", section: "provider", store: "config",
    suggestions: ALL_MODEL_SUGGESTIONS, placeholder: "claude-sonnet-4-6",
    description: "Model id (provider-specific; free text)." },

  // ---- Credentials ----
  { key: "credentials.anthropic.apiKey", label: "Anthropic API key", type: "secret", section: "credentials", store: "credentials",
    placeholder: "sk-ant-…", description: "Used when provider = anthropic." },
  { key: "credentials.bedrock.apiKey", label: "Bedrock bearer token", type: "secret", section: "credentials", store: "credentials",
    placeholder: "ABSK…", description: "Used when provider = bedrock." },
  { key: "credentials.bedrock.region", label: "Bedrock region", type: "string", section: "credentials", store: "credentials",
    placeholder: "us-west-2", suggestions: ["us-west-2", "us-east-1", "eu-central-1"] },
  { key: "credentials.openai.apiKey", label: "OpenAI API key", type: "secret", section: "credentials", store: "credentials",
    placeholder: "sk-…", description: "Used when provider = openai." },
  { key: "credentials.openai.baseUrl", label: "OpenAI base URL", type: "string", section: "credentials", store: "credentials",
    placeholder: "https://api.openai.com/v1", description: "Override for OpenAI-compatible endpoints (ollama, together, …)." },
  { key: "credentials.openrouter.apiKey", label: "OpenRouter API key", type: "secret", section: "credentials", store: "credentials",
    placeholder: "sk-or-…", description: "Used when provider = openrouter." },
  { key: "credentials.openrouter.baseUrl", label: "OpenRouter base URL", type: "string", section: "credentials", store: "credentials",
    placeholder: "https://openrouter.ai/api/v1" },

  // ---- Generation defaults ----
  { key: "defaultN", label: "Branches (n)", type: "number", section: "generation", store: "config", min: 1, max: 10,
    description: "Children generated per node." },
  { key: "defaultM", label: "Depth (m)", type: "number", section: "generation", store: "config", min: 1, max: 10,
    description: "How many levels deep to recurse." },
  { key: "defaultStrategy", label: "Strategy", type: "select", section: "generation", store: "config",
    options: [{ value: "bf", label: "Breadth-first" }, { value: "df", label: "Depth-first" }] },
  { key: "defaultPlanDetail", label: "Plan detail", type: "select", section: "generation", store: "config",
    options: [
      { value: "brief", label: "Brief" }, { value: "sentence", label: "Sentence" },
      { value: "detailed", label: "Detailed" }, { value: "none", label: "None" },
    ] },
  { key: "defaultExtension", label: "Lens", type: "select", section: "generation", store: "config",
    options: [
      { value: "freeform", label: "Freeform" }, { value: "worldbuilding", label: "Worldbuilding" },
      { value: "debate", label: "Debate" }, { value: "research", label: "Research" },
    ] },

  // ---- Agent behavior ----
  { key: "maxTokens", label: "Max tokens", type: "number", section: "behavior", store: "config", min: 256, max: 32000, step: 256,
    description: "Token budget per model completion." },
  { key: "concurrency", label: "Concurrency", type: "number", section: "behavior", store: "config", min: 1, max: 20,
    description: "Max parallel agent calls during generation." },
  { key: "defaultMissionRounds", label: "Mission rounds", type: "number", section: "behavior", store: "config", min: 0, max: 6,
    description: "Default validate→fix rounds for a mission." },

  // ---- Sync & synthesis ----
  { key: "synthesis.autoMerge", label: "Auto-merge synthesis", type: "boolean", section: "integrations", store: "config",
    description: "Automatically apply safe synthesis annotations (crosslinks, notes)." },
  { key: "watch.debounceMs", label: "Watch debounce (ms)", type: "number", section: "integrations", store: "config", min: 0, max: 10000, step: 50,
    description: "Delay before syncing a changed Obsidian file." },
  { key: "watch.onDelete", label: "On file delete", type: "select", section: "integrations", store: "config",
    options: [{ value: "prune", label: "Prune node" }, { value: "ignore", label: "Ignore" }] },
];

// ============================================================================
// Path helpers
// ============================================================================

export function getByPath(obj: unknown, dotted: string): unknown {
  let cur: any = obj;
  for (const part of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Build a fresh nested object that sets `dotted` to `value`. */
function nestValue(dotted: string, value: unknown): Record<string, unknown> {
  const parts = dotted.split(".");
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

export function findSettingField(key: string): SettingField | undefined {
  return SETTINGS_FIELDS.find((f) => f.key === key);
}

// ============================================================================
// Coercion / validation
// ============================================================================

export interface CoerceResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Coerce a raw input (string/number/boolean) into the field's typed value. */
export function coerceSettingValue(field: SettingField, raw: unknown): CoerceResult {
  switch (field.type) {
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(raw).toLowerCase().trim();
      if (["true", "1", "yes", "on"].includes(s)) return { ok: true, value: true };
      if (["false", "0", "no", "off"].includes(s)) return { ok: true, value: false };
      return { ok: false, error: `expected true/false` };
    }
    case "number": {
      const num = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(num)) return { ok: false, error: `expected a number` };
      if (field.min != null && num < field.min) return { ok: false, error: `must be ≥ ${field.min}` };
      if (field.max != null && num > field.max) return { ok: false, error: `must be ≤ ${field.max}` };
      return { ok: true, value: num };
    }
    case "select": {
      const s = String(raw).trim();
      const allowed = (field.options ?? []).map((o) => o.value);
      if (!allowed.includes(s)) return { ok: false, error: `must be one of: ${allowed.join(", ")}` };
      return { ok: true, value: s };
    }
    case "secret":
    case "string":
    default:
      return { ok: true, value: String(raw) };
  }
}

// ============================================================================
// View (for read APIs — secrets redacted)
// ============================================================================

export interface SettingFieldView extends SettingField {
  /** Current value (omitted/empty for secrets — see `isSet`). */
  value: unknown;
  /** For secrets: whether a value is stored, without revealing it. */
  isSet: boolean;
}

export interface SettingsView {
  sections: SettingSection[];
  fields: SettingFieldView[];
}

/** Resolve the stored value for a field from config + credentials. */
export function resolveSettingValue(
  field: SettingField,
  config: LainConfig,
  credentials: Credentials
): unknown {
  if (field.store === "credentials") {
    return getByPath(credentials, field.key.replace(/^credentials\./, ""));
  }
  return getByPath(config, field.key);
}

/** Build a redacted, value-annotated view of all settings (safe to send over the wire). */
export function buildSettingsView(config: LainConfig, credentials: Credentials): SettingsView {
  const fields: SettingFieldView[] = SETTINGS_FIELDS.map((f) => {
    const raw = resolveSettingValue(f, config, credentials);
    const isSet = raw != null && raw !== "";
    return { ...f, isSet, value: f.type === "secret" ? "" : raw ?? "" };
  });
  return { sections: SETTINGS_SECTIONS, fields };
}

// ============================================================================
// Apply (write)
// ============================================================================

export interface SettingUpdate {
  key: string;
  /** New value, or null/undefined to unset. */
  value: unknown;
}

export interface ApplyOptions {
  scope?: "global" | "workspace";
  cwd?: string;
}

export interface ApplyResult {
  applied: string[];
  errors: { key: string; error: string }[];
}

/**
 * Validate + persist a batch of setting updates, routing each field to the
 * correct store (config vs credentials). Credentials are always global.
 * Returns which keys were applied and any per-key validation errors.
 */
export function applySettings(updates: SettingUpdate[], opts: ApplyOptions = {}): ApplyResult {
  const scope = opts.scope ?? "global";
  const cwd = opts.cwd ?? process.cwd();
  const applied: string[] = [];
  const errors: { key: string; error: string }[] = [];

  let configPatch: Record<string, unknown> = {};
  let credPatch: Record<string, unknown> = {};
  const configUnset: string[] = [];
  const credUnset: string[] = [];

  for (const u of updates) {
    const field = findSettingField(u.key);
    if (!field) { errors.push({ key: u.key, error: "unknown setting" }); continue; }

    const isUnset = u.value == null || (typeof u.value === "string" && u.value === "" && field.type !== "string" && field.type !== "secret");
    if (isUnset) {
      if (field.store === "credentials") credUnset.push(field.key.replace(/^credentials\./, ""));
      else configUnset.push(field.key);
      applied.push(u.key);
      continue;
    }

    const coerced = coerceSettingValue(field, u.value);
    if (!coerced.ok) { errors.push({ key: u.key, error: coerced.error || "invalid" }); continue; }

    if (field.store === "credentials") {
      credPatch = deepMergeLocal(credPatch, nestValue(field.key.replace(/^credentials\./, ""), coerced.value));
    } else {
      configPatch = deepMergeLocal(configPatch, nestValue(field.key, coerced.value));
    }
    applied.push(u.key);
  }

  if (Object.keys(configPatch).length > 0) {
    if (scope === "workspace") saveWorkspaceConfig(cwd, configPatch as Partial<LainConfig>);
    else saveConfig(configPatch as Partial<LainConfig>);
  }
  if (Object.keys(credPatch).length > 0) {
    saveCredentials(credPatch as Partial<Credentials>);
  }
  for (const path of configUnset) unsetConfigPath(path, { scope, cwd });
  for (const path of credUnset) unsetCredentialPath(path);

  return { applied, errors };
}

function deepMergeLocal(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const bv = b[k];
    if (bv && typeof bv === "object" && !Array.isArray(bv) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMergeLocal(out[k] as Record<string, unknown>, bv as Record<string, unknown>);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

/** Convenience: the full current settings view from disk. */
export function currentSettingsView(cwd?: string): SettingsView {
  return buildSettingsView(loadConfig(cwd), loadCredentials());
}
