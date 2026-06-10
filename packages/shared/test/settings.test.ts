import { describe, it, expect } from "vitest";
import {
  SETTINGS_FIELDS,
  findSettingField,
  coerceSettingValue,
  resolveSettingValue,
  buildSettingsView,
  getByPath,
  DEFAULT_CONFIG,
  type LainConfig,
  type Credentials,
} from "@lain/shared";

const field = (key: string) => findSettingField(key)!;

describe("coerceSettingValue", () => {
  it("validates number ranges", () => {
    expect(coerceSettingValue(field("defaultN"), "5")).toEqual({ ok: true, value: 5 });
    expect(coerceSettingValue(field("defaultN"), 99).ok).toBe(false);
    expect(coerceSettingValue(field("defaultN"), 0).ok).toBe(false);
    expect(coerceSettingValue(field("defaultN"), "abc").ok).toBe(false);
  });

  it("parses booleans loosely", () => {
    expect(coerceSettingValue(field("synthesis.autoMerge"), "true")).toEqual({ ok: true, value: true });
    expect(coerceSettingValue(field("synthesis.autoMerge"), "off")).toEqual({ ok: true, value: false });
    expect(coerceSettingValue(field("synthesis.autoMerge"), false)).toEqual({ ok: true, value: false });
    expect(coerceSettingValue(field("synthesis.autoMerge"), "maybe").ok).toBe(false);
  });

  it("validates select options", () => {
    expect(coerceSettingValue(field("defaultStrategy"), "df")).toEqual({ ok: true, value: "df" });
    expect(coerceSettingValue(field("defaultStrategy"), "sideways").ok).toBe(false);
  });

  it("passes strings and secrets through", () => {
    expect(coerceSettingValue(field("defaultModel"), "gpt-4o")).toEqual({ ok: true, value: "gpt-4o" });
    expect(coerceSettingValue(field("credentials.openai.apiKey"), "sk-x")).toEqual({ ok: true, value: "sk-x" });
  });
});

describe("resolveSettingValue", () => {
  const config: LainConfig = { ...DEFAULT_CONFIG, defaultProvider: "openai", defaultModel: "gpt-4o", maxTokens: 8192 };
  const creds: Credentials = { openai: { apiKey: "sk-secret", baseUrl: "https://x/v1" } };

  it("reads config fields by path", () => {
    expect(resolveSettingValue(field("defaultProvider"), config, creds)).toBe("openai");
    expect(resolveSettingValue(field("maxTokens"), config, creds)).toBe(8192);
    expect(resolveSettingValue(field("watch.debounceMs"), config, creds)).toBe(DEFAULT_CONFIG.watch.debounceMs);
  });

  it("reads credential fields (stripping the credentials. prefix)", () => {
    expect(resolveSettingValue(field("credentials.openai.apiKey"), config, creds)).toBe("sk-secret");
    expect(resolveSettingValue(field("credentials.openai.baseUrl"), config, creds)).toBe("https://x/v1");
    expect(resolveSettingValue(field("credentials.anthropic.apiKey"), config, creds)).toBeUndefined();
  });
});

describe("buildSettingsView", () => {
  const config: LainConfig = { ...DEFAULT_CONFIG, defaultModel: "claude-sonnet-4-6" };
  const creds: Credentials = { bedrock: { apiKey: "ABSK-secret", region: "us-west-2" } };
  const view = buildSettingsView(config, creds);

  it("includes every field and all sections", () => {
    expect(view.fields).toHaveLength(SETTINGS_FIELDS.length);
    expect(view.sections.map((s) => s.id)).toContain("credentials");
  });

  it("redacts secret values but reports isSet", () => {
    const secret = view.fields.find((f) => f.key === "credentials.bedrock.apiKey")!;
    expect(secret.type).toBe("secret");
    expect(secret.value).toBe(""); // never leaked
    expect(secret.isSet).toBe(true);
    const unsetSecret = view.fields.find((f) => f.key === "credentials.anthropic.apiKey")!;
    expect(unsetSecret.isSet).toBe(false);
  });

  it("exposes non-secret values directly", () => {
    const model = view.fields.find((f) => f.key === "defaultModel")!;
    expect(model.value).toBe("claude-sonnet-4-6");
    const region = view.fields.find((f) => f.key === "credentials.bedrock.region")!;
    expect(region.value).toBe("us-west-2");
  });
});

describe("getByPath / findSettingField", () => {
  it("walks dotted paths", () => {
    expect(getByPath({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
    expect(getByPath({ a: {} }, "a.b.c")).toBeUndefined();
  });
  it("returns undefined for unknown keys", () => {
    expect(findSettingField("nope.nope")).toBeUndefined();
  });
});
