// Keyword search index (ARCHITECTURE.md §5.6): one document per outline item or glossary
// entry of every Medi-Cal policy.
import MiniSearch from "minisearch";
import { normalizeNumbers } from "../../src/lib/text";
import { SEARCH_OPTIONS, type SearchDoc } from "../../src/lib/searchOptions";
import type { Policy } from "./policies";

const MIN_WORDS = 25;

export function buildSearchDocs(policies: Policy[]): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const p of policies) {
    if (!p.programs.mediCal) continue;
    const firstLine = new Map(p.outline.map((o) => [o.address, o.firstLine]));
    const labelFor = (address: string): string => {
      const parts: string[] = [];
      if (!address.startsWith("Glossary: ")) {
        const segs = address.split(".");
        for (let i = 1; i < segs.length; i++) {
          const anc = segs.slice(0, i).join(".");
          const fl = firstLine.get(anc);
          if (fl) parts.push(fl.slice(0, 80));
        }
      } else parts.push("Glossary");
      return [p.id, p.title, ...parts].join(" · ");
    };

    let last: SearchDoc | null = null;
    let lastWords = 0;
    let prevAddress = "";
    for (const s of p.spans) {
      const text = p.canonicalText.slice(s.start, s.end).trim();
      if (!text) continue;
      const words = text.split(/\s+/).length;
      const sameItem = last && s.address === prevAddress;
      // short body items are folded into the previous document of the same policy
      const fold = last && !sameItem && s.kind !== "glossary" && last.kind === s.kind && lastWords < MIN_WORDS;
      if (sameItem || fold) {
        last!.text += " " + text;
        lastWords += words;
      } else {
        last = { id: docs.length, policyId: p.id, address: s.address, page: s.page, kind: s.kind, text, label: labelFor(s.address) };
        lastWords = words;
        docs.push(last);
      }
      prevAddress = s.address;
    }
  }
  for (const d of docs) d.text = normalizeNumbers(d.text.replace(/\s+/g, " "));
  return docs;
}

export function buildSearchIndex(docs: SearchDoc[]): string {
  const mini = new MiniSearch<SearchDoc>(SEARCH_OPTIONS);
  mini.addAll(docs);
  return JSON.stringify(mini);
}
