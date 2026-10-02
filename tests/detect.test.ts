// Language registry, detection and resolution (mirrors pythanity's test_detect.py).
import { afterEach, describe, expect, it } from "vitest";

import {
  availableLanguages,
  detectLanguage,
  getFilter,
  registerLanguage,
  resolveLanguages,
  setLanguageDetector,
} from "../src/index.js";
import { tinyldDetector } from "../src/detect.js";
import { tinyldDetector as tinyldLightDetector } from "../src/detect-light.js";
import { all, es } from "../src/languages.js";

afterEach(() => setLanguageDetector(null));

describe("resolveLanguages", () => {
  it("defaults to English without a detector", () => {
    expect(resolveLanguages("hello there")).toEqual(["en"]);
  });

  it("adds the detected language when its list is registered", () => {
    registerLanguage(es);
    setLanguageDetector(() => "es");
    expect(resolveLanguages("hola mundo")).toEqual(["en", "es"]);
  });

  it("skips a detected language without a list", () => {
    setLanguageDetector(() => "xx");
    expect(resolveLanguages("whatever")).toEqual(["en"]);
  });

  it("lets an explicit lang override detection but keeps English", () => {
    registerLanguage(es);
    setLanguageDetector(() => "fr");
    expect(resolveLanguages("x", "es")).toEqual(["en", "es"]);
  });

  it("strips regions from detected codes", () => {
    setLanguageDetector(() => "ES-mx");
    expect(detectLanguage("hola amigos")).toBe("es");
  });

  it("only runs the detector on texts of at least minLength characters", () => {
    let calls = 0;
    setLanguageDetector(() => (calls++, "es"), { minLength: 10 });
    expect(detectLanguage("hola")).toBeNull();
    expect(detectLanguage("  hola amigos  ")).toBe("es");
    expect(calls).toBe(1);
  });

  it("treats a throwing detector as unsure", () => {
    setLanguageDetector(() => {
      throw new Error("boom");
    });
    expect(detectLanguage("hello there")).toBeNull();
  });
});

describe("registry", () => {
  it("has English available by default", () => {
    expect(availableLanguages()).toContain("en");
  });

  it("registers every bundled language", () => {
    registerLanguage(...all);
    expect(availableLanguages().length).toBe(all.length + 1);
  });

  it("throws for languages that are not registered", () => {
    expect(() => getFilter("xx")).toThrow(/registerLanguage/);
  });

  it("caches combined filters", () => {
    expect(getFilter("en")).toBe(getFilter("en"));
  });
});

describe("tinyld detectors", () => {
  it.each([
    ["normal", tinyldDetector],
    ["light", tinyldLightDetector],
  ])("%s model detects Spanish and English", (_name, det) => {
    expect(det("Hola, ¿cómo estás? Hoy hace un día muy bonito en la ciudad.")).toBe("es");
    expect(det("The weather is lovely today and the park is full of people.")).toBe("en");
  });
});
