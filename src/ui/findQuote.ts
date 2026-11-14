// Locating a quote among the text pieces of a PDF page, for the highlight in the PDF pane.

/** Letters and digits only, so line breaks, hyphens and quote styles cannot spoil a match. */
const bare = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which text pieces of the page hold the quote (or its first eight words). */
export function findQuote(pieces: string[], quote: string): number[] {
  let all = "";
  const owner: number[] = [];
  pieces.forEach((piece, i) => {
    const b = bare(piece);
    all += b;
    for (let k = 0; k < b.length; k++) owner.push(i);
  });
  const whole = bare(quote);
  const start = bare(quote.split(/\s+/).slice(0, 8).join(" "));
  for (const needle of [whole, start]) {
    if (needle.length < 12) continue;
    const at = all.indexOf(needle);
    if (at >= 0) return [...new Set(owner.slice(at, at + needle.length))];
  }
  return [];
}
