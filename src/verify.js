// Verification strategies for redundant task submissions.
// Each takes an array of result strings and returns { result, confidence, agreement }.

export const STRATEGIES = {
  // Majority vote: pick the most common result (exact match).
  // Best for classification, extraction, yes/no answers.
  majority: (results) => {
    const counts = new Map();
    for (const r of results) {
      counts.set(r, (counts.get(r) || 0) + 1);
    }
    let best = results[0];
    let bestCount = 0;
    for (const [r, count] of counts) {
      if (count > bestCount) {
        best = r;
        bestCount = count;
      }
    }
    return {
      result: best,
      confidence: bestCount / results.length,
      agreement: bestCount,
      total: results.length,
    };
  },

  // Consensus: all results must match (exact). Strict mode.
  // Returns null result if no consensus — task gets flagged.
  consensus: (results) => {
    const allSame = results.every((r) => r === results[0]);
    return {
      result: allSame ? results[0] : null,
      confidence: allSame ? 1.0 : 0,
      agreement: allSame ? results.length : 1,
      total: results.length,
    };
  },

  // Fuzzy majority: normalize whitespace, case, and punctuation,
  // then do majority vote. Good for free-text where formatting varies.
  fuzzy: (results) => {
    const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
    const normalized = results.map(normalize);
    const counts = new Map();
    for (let i = 0; i < normalized.length; i++) {
      counts.set(normalized[i], (counts.get(normalized[i]) || 0) + 1);
    }
    let bestNorm = normalized[0];
    let bestCount = 0;
    for (const [n, count] of counts) {
      if (count > bestCount) {
        bestNorm = n;
        bestCount = count;
      }
    }
    // Return the original (un-normalized) version of the winning result
    const winnerIdx = normalized.indexOf(bestNorm);
    return {
      result: results[winnerIdx],
      confidence: bestCount / results.length,
      agreement: bestCount,
      total: results.length,
    };
  },

  // Longest: take the longest result. Assumes more detail = better.
  // No real verification — just picks the most thorough response.
  longest: (results) => {
    let best = results[0];
    for (const r of results) {
      if (r.length > best.length) best = r;
    }
    return {
      result: best,
      confidence: 1 / results.length, // low confidence — no comparison
      agreement: 1,
      total: results.length,
    };
  },
};

// Minimum confidence threshold to accept a result.
// Below this, the task is flagged as disputed.
export const DEFAULT_MIN_CONFIDENCE = 0.5;
