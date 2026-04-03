export const REDUCERS = {
  concat: (results, opts = {}) => {
    const sep = opts.separator || "\n";
    return results
      .sort((a, b) => a.index - b.index)
      .map((r) => r.result)
      .join(sep);
  },

  "json-array": (results) => {
    const sorted = results.sort((a, b) => a.index - b.index);
    return JSON.stringify(
      sorted.map((r) => {
        try {
          return JSON.parse(r.result);
        } catch {
          return r.result;
        }
      }),
      null,
      2
    );
  },

  "json-merge": (results) => {
    const merged = {};
    for (const r of results.sort((a, b) => a.index - b.index)) {
      try {
        Object.assign(merged, JSON.parse(r.result));
      } catch {
        // skip non-JSON results
      }
    }
    return JSON.stringify(merged, null, 2);
  },

  none: (results) => {
    return results
      .sort((a, b) => a.index - b.index)
      .map((r) => r.result)
      .join("\n===RESULT_BOUNDARY===\n");
  },
};
