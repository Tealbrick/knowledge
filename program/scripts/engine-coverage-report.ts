/**
 * Memory-engine coverage report.
 *
 *   tsx scripts/engine-coverage-report.ts                 # markdown
 *   tsx scripts/engine-coverage-report.ts --json <partition>  # agent-path plan (used by the edge coverage test)
 *
 * Exits non-zero when any upstream operation is unaccounted for.
 */
import { agentPathPlan, engineCoverage, engineExposures, markdownReport } from "./engine-coverage.js";

const json = process.argv.indexOf("--json");
if (json >= 0) process.stdout.write(`${JSON.stringify(agentPathPlan(process.argv[json + 1] ?? "fixture-company"))}\n`);
else process.stdout.write(markdownReport());
const gaps = engineExposures().map(engineCoverage).filter(c => c.unaccounted.length || c.inconsistent.length);
if (gaps.length) { console.error(`Unaccounted upstream operations: ${JSON.stringify(gaps)}`); process.exitCode = 1; }
