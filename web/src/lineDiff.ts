export type DiffLine = { op: ' ' | '+' | '-'; text: string };

const MAX_CELLS = 4_000_000;

/** Line diff via LCS, trimmed to changed hunks with `context` lines around them. */
export function lineDiff(oldText: string, newText: string, context = 3): (DiffLine | null)[] {
  const split = (t: string) => (t ? t.replace(/\n$/, '').split('\n') : []);
  const a = split(oldText);
  const b = split(newText);

  // Strip the common prefix/suffix first; it keeps the table small for typical edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let mid: DiffLine[];
  if (midA.length * midB.length > MAX_CELLS) {
    mid = [...midA.map((text) => ({ op: '-' as const, text })), ...midB.map((text) => ({ op: '+' as const, text }))];
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        mid.push({ op: ' ', text: midA[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        mid.push({ op: '-', text: midA[i++] });
      } else {
        mid.push({ op: '+', text: midB[j++] });
      }
    }
  }

  const all: DiffLine[] = [
    ...a.slice(0, start).map((text) => ({ op: ' ' as const, text })),
    ...mid,
    ...a.slice(endA).map((text) => ({ op: ' ' as const, text })),
  ];

  // Keep only lines within `context` of a change; null marks an elided gap.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, idx) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(all.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  all.forEach((l, idx) => {
    if (keep[idx]) out.push(l);
    else if (out.length && out[out.length - 1] !== null) out.push(null);
  });
  if (out[out.length - 1] === null) out.pop();
  return out;
}
