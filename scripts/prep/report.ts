// Acceptance checks for the prep output (ARCHITECTURE.md §5.7).
import { normalize, normalizeWithMap } from "../../src/lib/text";
import type { Apl } from "./apl";
import type { Guide } from "./guide";
import type { Policy } from "./policies";
import type { Questionnaire } from "./questionnaire";

type Check = { name: string; pass: boolean; detail: string };

export function runChecks(input: {
  policies: Policy[];
  apls: Apl[];
  questionnaires: Questionnaire[];
  guides: Guide[];
}): boolean {
  const { policies, apls, questionnaires, guides } = input;
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail = "") => checks.push({ name, pass, detail });
  const byId = new Map(policies.map((p) => [p.id, p]));

  // --- policies
  const medi = policies.filter((p) => p.programs.mediCal).length;
  check("373 policies parsed", policies.length === 373, `${policies.length}`);
  check("373 unique policy IDs", byId.size === 373, `${byId.size}`);
  check("251 policies apply to Medi-Cal", medi === 251, `${medi}`);
  const idMismatch = policies.filter((p) => p.warnings.some((w) => w.includes("differs from file id")));
  check("header ID matches file ID for every policy", idMismatch.length === 0, idMismatch.map((p) => p.id).join(", "));
  const noDate = policies.filter((p) => !p.revisedDate);
  check("every policy has a revised date (with fallbacks)", noDate.length === 0, noDate.map((p) => p.id).join(", "));

  const ma = byId.get("MA.6113");
  check("MA.6113 is not a Medi-Cal policy", !!ma && !ma.programs.mediCal);

  const gg = byId.get("GG.1503");
  if (!gg) check("GG.1503 exists", false);
  else {
    check("GG.1503 applies to Medi-Cal", gg.programs.mediCal);
    check("GG.1503 revised 2024-09-01", gg.revisedDate === "2024-09-01", String(gg.revisedDate));
    check("GG.1503 references APL 13-014", gg.referencedApls.includes("13-014"), gg.referencedApls.join(", "));
    check("GG.1503 has 18 pages", gg.pageCount === 18, String(gg.pageCount));
    const addresses = new Set(gg.spans.map((s) => s.address));
    for (const a of ["II.B", "II.C", "II.C.2", "II.I", "III.F.1"]) check(`GG.1503 has address ${a}`, addresses.has(a));
    const scopeOf = (a: string) => gg.spans.find((s) => s.address === a)?.scope;
    check("GG.1503 II.B is scoped to another program", scopeOf("II.B") === "other", String(scopeOf("II.B")));
    check("GG.1503 II.C is scoped to Medi-Cal", scopeOf("II.C") === "medi-cal", String(scopeOf("II.C")));

    const hospice = gg.spans.filter((s) => s.address === "Glossary: Hospice Care");
    const hospiceText = hospice.map((s) => gg.canonicalText.slice(s.start, s.end)).join(" ");
    check(
      'GG.1503 glossary entry "Hospice Care" is complete (starts correctly, includes item 12)',
      hospiceText.startsWith("Hospice Care: The provision of palliative") && hospiceText.includes("12. Any other palliative item"),
      hospiceText.slice(0, 60),
    );
    check("GG.1503 Hospice Care entry is on page 16", hospice.some((s) => s.page === 16), hospice.map((s) => s.page).join(","));

    const { text, map } = normalizeWithMap(gg.canonicalText);
    const at = text.indexOf(normalize("no later than thirty (30) calendar days"));
    const span = at >= 0 ? gg.spans.find((s) => map[at] >= s.start && map[at] < s.end) : undefined;
    check('GG.1503 "no later than thirty (30) calendar days" is at III.F.1', span?.address === "III.F.1", String(span?.address));
    const certifies = text.indexOf(normalize("certifies the Member’s illness is terminal (life expectancy is six (6) months or less if the disease is to run"));
    const span2 = certifies >= 0 ? gg.spans.find((s) => map[certifies] >= s.start && map[certifies] < s.end) : undefined;
    check("GG.1503 Medi-Cal certification sentence is at II.C.2, page 2", span2?.address === "II.C.2" && span2?.page === 2, `${span2?.address} p${span2?.page}`);
  }

  const hits = policies.filter((p) => normalize(p.canonicalText).includes("transitional rent")).map((p) => p.id);
  check('exact search for "transitional rent" finds nothing', hits.length === 0, hits.join(", "));
  const hits2 = policies.filter((p) => normalize(p.canonicalText).includes("streamlined authorization")).map((p) => p.id);
  check('exact search for "streamlined authorization" finds nothing', hits2.length === 0, hits2.join(", "));

  // --- APL
  const apl = apls.find((a) => a.number === "25-008");
  check("APL 25-008 loaded", !!apl);
  if (apl) {
    check("APL has 17 pages", apl.pageCount === 17, String(apl.pageCount));
    check("APL supersedes 13-014", apl.supersedes.join(",") === "13-014", apl.supersedes.join(","));
    check("APL dated 2025-05-05", apl.date === "2025-05-05", String(apl.date));
    check("APL page 6 mentions the hospice services list", /ensure provision of/.test(apl.pages[5]?.text || ""));
  }

  // --- questionnaire
  const q = questionnaires[0];
  check("questionnaire loaded", !!q);
  if (q) {
    const inOrder = q.questions.every((x, i) => x.number === i + 1);
    check("64 questions, numbered 1–64 in order", q.questions.length === 64 && inOrder, String(q.questions.length));
    check("Q25 refers to APL pages 6–7", JSON.stringify(q.questions[24]?.aplPages) === "[6,7]", JSON.stringify(q.questions[24]?.aplPages));
    check("every question has APL pages", q.questions.every((x) => x.aplPages.length > 0));
    check("form map: 64 citation fields and 64 Yes/No rows", q.formMap?.length === 64, String(q.formMap?.length));
    if (q.formMap) {
      const sides = q.formMap.every((r) => r.yesNo.some((w) => w.side === "yes") && r.yesNo.some((w) => w.side === "no"));
      check("form map: every row has a Yes and a No widget", sides);
      // The form's radio states are named Yes_<n>; where present they must agree with our numbering.
      let agree = 0;
      let disagree = 0;
      for (const r of q.formMap)
        for (const w of r.yesNo) {
          const m = w.onState.match(/^(?:Yes|No)_(\d+)$/);
          if (!m) continue;
          if (Number(m[1]) === r.number) agree++;
          else disagree++;
        }
      check("form map: field state names agree with question numbers", disagree === 0 && agree > 100, `${agree} agree, ${disagree} disagree`);
    }
  }

  // --- guide
  const g = guides[0];
  check("policy guide loaded", !!g);
  if (g) {
    check("guide has between 120 and 200 sections", g.sections.length >= 120 && g.sections.length <= 200, String(g.sections.length));
    check("guide has at least 20 sections flagged Updated", g.stats.updatedSections >= 20, String(g.stats.updatedSections));
    const cs = g.sections.find((s) => /^\(Updated January 2026\) Community Supports/.test(s.title) && s.pageStart === 17);
    check('guide has "(Updated January 2026) Community Supports" on page 17 containing "Transitional Rent"', !!cs && cs.text.includes("Transitional Rent"));
    check("every guide heading was located in the text", g.stats.notLocated === 0, String(g.stats.notLocated));
    const sa = g.sections.find((s) => /ECM Streamlined Authorization/.test(s.title));
    check("guide has the ECM Streamlined Authorization section", !!sa, sa ? `p${sa.pageStart}` : "");
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  console.log("\nAcceptance checks");
  for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => !c.pass).length;
  console.log(failed ? `\n${failed} of ${checks.length} checks FAILED` : `\nAll ${checks.length} checks passed`);
  return failed === 0;
}
