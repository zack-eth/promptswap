import { readFileSync } from "fs";

export const SPLITTERS = {
  lines: (input) => input.split("\n").filter((l) => l.trim()),

  chunks: (input, opts = {}) => {
    const size = opts.chunk_size || 2000;
    const overlap = opts.overlap || 0;
    const step = Math.max(1, size - overlap);
    const chunks = [];
    for (let i = 0; i < input.length; i += step) {
      chunks.push(input.slice(i, i + size));
    }
    return chunks;
  },

  "json-array": (input) => {
    const arr = JSON.parse(input);
    if (!Array.isArray(arr)) throw new Error("Input is not a JSON array");
    return arr.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  },

  "csv-rows": (input) => {
    const lines = input.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return [];
    const header = lines[0];
    return lines.slice(1).map((row) => `${header}\n${row}`);
  },

  "file-list": (input) => {
    return input
      .split("\n")
      .filter((l) => l.trim())
      .map((path) => readFileSync(path.trim(), "utf-8"));
  },
};

export function applyTemplate(template, chunk) {
  if (!template) return chunk;
  return template.replace(/\{\{input\}\}/g, chunk);
}
