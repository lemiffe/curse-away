import { describe, expect, it } from "vitest";

import { cyrToLatin, normalizeWithMap, removeAccents, removeEmoji } from "../src/normalize.js";

describe("normalize", () => {
  it("removes accents and specials", () => {
    expect(removeAccents("Café")).toBe("Cafe");
    expect(removeAccents("straße")).toBe("strasse");
  });

  it("transliterates Cyrillic to Latin", () => {
    expect(cyrToLatin("ж")).toBe("zh");
  });

  it("removes emoji but keeps text", () => {
    expect(removeEmoji("hi 😀 there")).toBe("hi  there");
  });

  it("maps indices back to the source", () => {
    const text = "Café";
    const { normalized, indexMap } = normalizeWithMap(text);
    expect(normalized).toBe("Cafe");
    expect(indexMap.length).toBe(normalized.length);
    // the folded 'e' came from the original 'é' at index 3
    expect(indexMap.at(-1)).toBe(3);
    expect(text[indexMap.at(-1)!]).toBe("é");
  });

  it("expands Cyrillic, mapping both chars back to one source index", () => {
    const { normalized, indexMap } = normalizeWithMap("aжb");
    expect(normalized).toBe("azhb");
    expect(indexMap).toEqual([0, 1, 1, 2]);
  });

  it("drops emoji (UTF-16 offsets: the emoji spans 2 code units)", () => {
    const { normalized, indexMap } = normalizeWithMap("a😀b");
    expect(normalized).toBe("ab");
    expect(indexMap).toEqual([0, 3]);
  });

  it("handles decomposed input (combining marks)", () => {
    expect(normalizeWithMap("Café").normalized).toBe("Cafe");
  });

  it("strips only combining marks, like Python (spacing vowel signs survive)", () => {
    expect(removeAccents("नमस्ते")).toBe("नमस्ते".normalize("NFKD").replace("्", "")); // virama has ccc 9
    expect(removeAccents("สั")).toBe("สั"); // Thai mai han-akat: ccc 0
    expect(removeAccents("का")).toBe("का"); // Devanagari AA sign (Mc)
  });
});
