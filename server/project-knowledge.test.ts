import assert from "node:assert/strict"
import { test } from "node:test"
import { describeProjectKnowledge, knowledgeSections, parseProjectKnowledge } from "./project-knowledge.js"

const document = (knowledge: Record<string, unknown>) => JSON.stringify({ version: 1, knowledge })

test("accepts a full knowledge document", () => {
  const parsed = parseProjectKnowledge(document({
    summary: "A sensor front end for the bench supply.",
    functional_requirements: ["Measure 0 to 24 V with 1 percent accuracy."],
    electrical_assumptions: ["The divider sees a source impedance below 1 kOhm."],
    design_decisions: [{ decision: "22k over 10k divider", rationale: "Keeps the divider load under 250 uA.", date: "2026-10-21" }],
    mechanical_constraints: ["Fits a 40 by 20 mm enclosure bay."],
    manufacturing_preferences: { fabricator: "jlcpcb", assembler: "jlcpcb", notes: ["Two-layer, 1 oz copper."] },
    known_issues: [{ issue: "Autorouted vias are below the JLCPCB minimum.", severity: "high", workaround: "Specify larger vias before ordering." }],
    pending_decisions: [{ question: "Add reverse-polarity protection?", options: ["Series diode", "P-channel MOSFET"], owner: "hardware" }],
  }))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.knowledge.design_decisions?.[0]?.rationale, "Keeps the divider load under 250 uA.")
  assert.equal(parsed.knowledge.known_issues?.[0]?.severity, "high")
})

test("rejects malformed, unknown, and oversized content", () => {
  assert.throws(() => parseProjectKnowledge("not json"), /must be valid JSON/)
  assert.throws(() => parseProjectKnowledge(document({ unknown_section: ["x"] })), /Invalid project knowledge/)
  assert.throws(() => parseProjectKnowledge(JSON.stringify({ version: 2, knowledge: {} })), /Invalid project knowledge/)
  assert.throws(() => parseProjectKnowledge(document({ known_issues: [{ issue: "x", severity: "critical" }] })), /severity/)
  assert.throws(() => parseProjectKnowledge(document({ functional_requirements: [""] })), /Invalid project knowledge/)
  assert.throws(() => parseProjectKnowledge(document({ design_decisions: [{ rationale: "no decision" }] })), /decision/)
  // An empty document is valid: a project may document nothing yet.
  assert.deepEqual(parseProjectKnowledge(document({})).knowledge, {})
})

test("reports which sections carry content and what the document does not prove", () => {
  const described = describeProjectKnowledge(parseProjectKnowledge(document({
    summary: "A sensor front end.",
    known_issues: [{ issue: "Vias are too small for the chosen fabricator." }],
    pending_decisions: [{ question: "Protection diode?" }, { question: "Connector choice?" }],
    functional_requirements: [],
  })))
  assert.deepEqual(described.populatedSections, ["summary", "known_issues", "pending_decisions"])
  assert.ok(described.emptySections.includes("functional_requirements"), "an empty array counts as empty")
  assert.ok(described.emptySections.includes("electrical_assumptions"))
  assert.equal(described.openQuestions, 2)
  assert.equal(described.knownIssues, 1)
  assert.deepEqual(described.sections, [...knowledgeSections])
  // The document is prose, so the limitations must say it is never checked against the design.
  assert.ok(described.limitations.some((note) => note.includes("not derived from the design")))
  assert.ok(described.limitations.some((note) => note.includes("requirements.json")))
  assert.ok(described.limitations.some((note) => note.includes("not applied to builds")))
})
