// npm run prep — turns source/Readily into the static data the app loads (ARCHITECTURE.md §5).
import fs from "node:fs";
import path from "node:path";
import { APL_DIR, DATA, GUIDES, PDFS, PLAN_NAME, POLICIES_DIR, QUESTIONNAIRES, SOURCE } from "./config";
import { parseApl, type Apl } from "./apl";
import { parseGuide, type Guide } from "./guide";
import { listPolicyFiles, parsePolicy, type Policy } from "./policies";
import { parseQuestionnaire, type Questionnaire } from "./questionnaire";
import { runChecks } from "./report";
import { buildSearchDocs, buildSearchIndex } from "./searchIndex";

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function copy(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source folder not found: ${SOURCE}\nCopy the Readily folder to source/Readily and run again.`);
    process.exit(1);
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(PDFS, { recursive: true, force: true });

  // --- policies
  const files = listPolicyFiles(POLICIES_DIR);
  console.log(`Parsing ${files.length} policies…`);
  const policies: Policy[] = [];
  for (const f of files) {
    const p = parsePolicy(f.file, f.folder);
    policies.push(p);
    const { warnings, sourceFile, ...stored } = p;
    writeJson(path.join(DATA, "policies", `${p.id}.json`), stored);
    copy(f.file, path.join(PDFS, "policies", `${p.id}.pdf`));
    for (const w of warnings) console.warn(`  warning ${p.id}: ${w}`);
  }

  // --- APLs
  const apls: Apl[] = [];
  if (fs.existsSync(APL_DIR)) {
    for (const f of fs.readdirSync(APL_DIR).filter((x) => x.toLowerCase().endsWith(".pdf")).sort()) {
      const apl = parseApl(path.join(APL_DIR, f));
      apls.push(apl);
      writeJson(path.join(DATA, "apl", `${apl.id}.json`), apl);
      copy(path.join(APL_DIR, f), path.join(PDFS, "apl", `${apl.id}.pdf`));
    }
  }
  console.log(`Parsed ${apls.length} APL(s): ${apls.map((a) => a.number).join(", ")}`);

  // --- questionnaires
  const questionnaires: Questionnaire[] = [];
  for (const q of QUESTIONNAIRES) {
    const file = path.join(SOURCE, q.file);
    const parsed = await parseQuestionnaire(file, q.id, q.aplId);
    questionnaires.push(parsed);
    const { warnings, ...stored } = parsed;
    writeJson(path.join(DATA, "questionnaires", `${q.id}.json`), stored);
    copy(file, path.join(PDFS, "questionnaires", `${q.id}.pdf`));
    for (const w of warnings) console.warn(`  warning ${q.id}: ${w}`);
  }
  console.log(`Parsed ${questionnaires.length} questionnaire(s)`);

  // --- guides
  const guides: Guide[] = [];
  for (const g of GUIDES) {
    const file = path.join(SOURCE, g.file);
    const parsed = await parseGuide(file, g.id, g.title, g.date);
    guides.push(parsed);
    writeJson(path.join(DATA, "guides", `${g.id}.json`), parsed);
    copy(file, path.join(PDFS, "guides", `${g.id}.pdf`));
  }
  console.log(`Parsed ${guides.length} guide(s): ${guides.map((g) => `${g.sections.length} sections`).join(", ")}`);

  // --- search index
  const docs = buildSearchDocs(policies);
  const index = buildSearchIndex(docs);
  fs.writeFileSync(path.join(DATA, "search-index.json"), index);
  console.log(`Search index: ${docs.length} documents, ${(index.length / 1e6).toFixed(1)} MB`);

  // --- library
  const mediCal = policies.filter((p) => p.programs.mediCal);
  writeJson(path.join(DATA, "library.json"), {
    planName: PLAN_NAME,
    counts: {
      policies: policies.length,
      mediCalPolicies: mediCal.length,
      pages: policies.reduce((a, p) => a + p.pageCount, 0),
      mediCalTokens: mediCal.reduce((a, p) => a + p.tokenEstimate, 0),
    },
    policies: policies.map((p) => ({
      id: p.id,
      title: p.title,
      department: p.department,
      section: p.section,
      effectiveDate: p.effectiveDate,
      revisedDate: p.revisedDate,
      programs: p.programs,
      pageCount: p.pageCount,
      referencedApls: p.referencedApls,
      tokenEstimate: p.tokenEstimate,
      folder: p.folder,
    })),
    apls: apls.map((a) => ({ id: a.id, number: a.number, subject: a.subject, date: a.date, supersedes: a.supersedes, pageCount: a.pageCount })),
    questionnaires: questionnaires.map((q) => ({ id: q.id, title: q.title, aplId: q.aplId, aplNumber: q.aplNumber, subject: q.subject, questionCount: q.questions.length, hasFormMap: !!q.formMap })),
    guides: guides.map((g) => ({ id: g.id, title: g.title, date: g.date, pageCount: g.pageCount, sectionCount: g.sections.length, updatedSections: g.stats.updatedSections })),
  });

  const ok = runChecks({ policies, apls, questionnaires, guides });
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
