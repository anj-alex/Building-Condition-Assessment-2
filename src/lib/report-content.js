// The report's fixed prose, labels and section order, in one place.
//
// Word (.docx) is the only report the app produces — see docs/word-export.md.
// The on-screen report page renders the generated DOCX bytes, so this module is
// the Word builder's one source for prose, framing, and legal notices.
//
// The wording is the client's, supplied as a rewritten report-text template —
// see docs/report-wording.md, which records the deviations and the reasons.
//
// A block is one of:
//   { type: 'heading', level: 1 | 2 | 3, text, legal?: true }
//   { type: 'paragraph', text, legal?: true }
//   { type: 'bullets', items: [text] }
//   { type: 'callout', text }
//   { type: 'formula', text }
//
// `legal: true` marks the dense small-print of the notices and the limitations
// appendix, which both renderers set in a smaller face. On a heading it also
// means "this heading and the small print under it are one titled notice".
//
// A `callout` is the standing visual-observation caveat, set apart from the
// body around it. A `formula` is the FCI expression, set on its own line.

;(function () {
// The nine executive-summary narratives, in report order. The second element is
// the `executive_summary` column the AI writes into — see docs/executive-summary.md.
const SUMMARY_SECTIONS = [
  ['Accessibility Executive Summary', 'accessibility'],
  ['Designated Substance Survey Executive Summary', 'designated_substance_survey'],
  ['Architectural & Structural Executive Summary', 'architectural_structural'],
  ['Plumbing Executive Summary', 'plumbing'],
  ['Mechanical Executive Summary', 'mechanical'],
  ['Electrical Executive Summary', 'electrical'],
  ['Fire and Life Safety Executive Summary', 'fire_life_safety'],
  ['Site Executive Summary', 'site'],
  ['Code Compliance Executive Summary', 'code_compliance'],
]

// The narrative sections are grouped to create deliberate Word page breaks.
const SUMMARY_SECTION_GROUPS = [
  SUMMARY_SECTIONS.slice(0, 2),
  SUMMARY_SECTIONS.slice(2, 5),
  SUMMARY_SECTIONS.slice(5, 8),
  SUMMARY_SECTIONS.slice(8),
]

/**
 * Every heading, table caption, column head and field label the report prints.
 *
 * A single map keeps every document section consistent and makes the next
 * rewording one edit.
 */
const LABELS = {
  // Cover.
  assessmentType: 'Building Condition Assessment',
  assessmentTypePlural: 'Building Condition Assessments',
  confidentiality: 'Confidential – Client Use',
  facilityPhotograph: 'Facility Photograph',
  preparedFor: 'Prepared for',
  preparedBy: 'Prepared by',
  propertyId: 'Property ID',

  // Front matter.
  tableOfContents: 'Report Contents',
  figuresAndTables: 'Figures and Tables Index',
  figures: 'Figures',
  tables: 'Tables',
  noFigures: 'No standalone figures are included in this report section.',
  facilityInformation: 'Facility Information Summary',
  majorSystemCapitalSummary: 'Major System Capital Summary',

  // Executive summary and the facility capital sections.
  executiveSummary: 'Executive Summary',
  capitalRenewalSummary: 'Capital Renewal Summary',
  componentSummary: 'Component Summary',
  componentSummaryTotal: 'Total Budget Allowance',
  buildingSystem: 'Building System',
  totalPlannedCapitalRenewal: 'Total Planned Capital Renewal',
  crvImplementationTable: 'CRV Project Delivery Allowances',
  crvAllowanceCategory: 'Cost Allowance Category',
  crvPlanningAllowance: 'Planning Allowance',
  fciClassification: 'FCI Condition Classification',
  facilityConditionIndex: 'Facility Condition Index',

  // Facility Scorecard — the one-page management view.
  facilityScorecard: 'Facility Scorecard',
  overallCondition: 'Overall Condition',
  scorecardPriorities: 'Priority Capital Items (0–5 Years)',
  scorecardNoPriorities:
    'No capital work is scheduled for this facility within the next five years.',
  conditionSnapshot: 'Condition Snapshot',

  // Body.
  facilityProfile: 'Facility Profile',
  facilityOverview: 'Facility Overview',
  propertyPhotos: 'Property Photos',
  conditionAssessmentFindings: 'Condition Assessment Findings',
  noPhoto: 'Photograph Not Available',

  // Project (portfolio) level.
  portfolioOverview: 'Portfolio Capital Overview',
  portfolioCapitalRequirements: 'Portfolio Capital Requirements by Building System',
  portfolioForecast: 'Portfolio Capital Expenditure Forecast',
  portfolioCrvFci: 'Portfolio Replacement Value and Facility Condition Index',
}

/**
 * The four headline numbers on the Facility Scorecard, in the order they print.
 *
 * They are deliberately the same four an owner is asked for at a budget
 * meeting: what the facility is worth, what condition it is in, what it needs
 * soon, and how many components drive that need.
 */
const SCORECARD_TILES = {
  crv: 'Current Replacement Value',
  fci: 'Facility Condition Index',
  nearTermNeed: '0–5 Year Capital Need',
  nearTermCount: 'Priority Components',
}

/** Column heads for the scorecard's near-term priority grid. */
const SCORECARD_PRIORITY_COLUMNS = {
  element: 'Uniformat',
  name: 'Component',
  condition: 'Condition',
  horizon: 'Action Horizon',
  cost: 'Budget Allowance',
}

/** Column heads for the scorecard's condition distribution. */
const CONDITION_SNAPSHOT_COLUMNS = {
  band: 'Condition Band',
  count: 'Components',
  share: 'Share of Assessed',
}

/**
 * The Component Summary column heads, in order.
 *
 * Deliberately shorter than the `ASSET_FIELDS` labels the asset pages use:
 * seven columns across a portrait page cannot carry "Budget Allowance /
 * Opinion of Probable Cost" as a heading without wrapping the grid to
 * uselessness. The rows underneath are the same values those pages print.
 */
const COMPONENT_SUMMARY_COLUMNS = {
  name: 'Asset / Component',
  system: 'Building System',
  condition: 'Condition',
  priority: 'Priority',
  action: 'Intervention',
  year: 'Action Year',
  cost: 'Budget Allowance',
}

/** The Facility Information Summary rows, in report order. */
const FACILITY_FIELDS = {
  client: 'Client',
  property: 'Facility / Property',
  propertyId: 'Property ID',
  address: 'Address',
  grossFloorArea: 'Approximate Gross Floor Area',
  storeys: 'Number of Storeys',
  yearBuilt: 'Original Construction Year',
  assessmentDate: 'Site Assessment Date',
}

/** The per-asset field labels, in the order the asset card prints them. */
const ASSET_FIELDS = {
  assetName: 'Asset / Component',
  vintage: 'Installed / Approximate Vintage',
  serviceLife: 'Typical Service Life',
  level1: 'Major Building System',
  level2: 'Element Classification',
  description: 'Observed Condition / Description',
  recommendation: 'Recommended Action',
  conditionRating: 'Condition',
  conditionGrade: 'Condition Grade',
  priority: 'Priority Level',
  action: 'Intervention Type',
  term: 'Planning Horizon',
  conservationLens: 'Energy / Water Opportunity',
  unitMeasure: 'Unit',
  quantity: 'Assessed Quantity',
  adjustedUnitCost: 'Planning Unit Cost',
  actionYear: 'Recommended Action Year',
  opinionOfProbableCost: 'Budget Allowance / Opinion of Probable Cost',
}

/**
 * What a missing attribute prints instead of a dash. The client asked for words
 * rather than punctuation so a reader can tell "we looked and it wasn't
 * recorded" from "this cell is blank".
 */
const NOT_PROVIDED = 'Not Provided'

// `pageBreakBefore` starts the heading's page rather than emitting a separate
// break paragraph in front of it; see heading() in docx-report.js for why the
// distinction matters.
const heading = (text, level = 1, options = {}) => ({ type: 'heading', level, text, ...options })
const legalHeading = (text) => ({ type: 'heading', level: 2, text, legal: true })
const paragraph = (text) => ({ type: 'paragraph', text })
const legal = (text) => ({ type: 'paragraph', text, legal: true })
const bullets = (items) => ({ type: 'bullets', items })
const callout = (text) => ({ type: 'callout', text })
const formula = (text) => ({ type: 'formula', text })

/**
 * Executive Summary opening — who was retained, what the assessment was for,
 * and the planning periods the costs are bucketed into.
 *
 * The framing is deliberately softer than it was: the assessment is described
 * as being carried out "in general accordance with" the project's framework
 * rather than as certifying compliance with every applicable code, which is not
 * something a visual walk-through can establish.
 */
function executiveSummaryIntroBlocks(ctx, { pageBreakBefore = false } = {}) {
  const { firm, client, property, address, visitDate, assessmentType, startYear, immediateConcerns } = ctx
  const blocks = [
    heading(LABELS.executiveSummary, 1, { pageBreakBefore }),
    paragraph(
      `${firm} was retained by ${client} to complete a ${assessmentType} of ${property}, located at ${address}. A visual, non-destructive walk-through assessment was completed on ${visitDate}. The review was carried out in general accordance with the assessment framework identified for the assignment, including ASTM E2018 where applicable to the project scope.`,
    ),
    paragraph(
      'The assessment is intended to provide the client with a practical understanding of the current condition of major building and site components, identify observed deficiencies and renewal needs, and support development of a long-term capital plan for the facility portfolio.',
    ),
    paragraph('The assessment supports the client in:'),
    bullets([
      'identifying conditions that may require immediate or near-term attention;',
      'understanding the anticipated timing of major repair and replacement work;',
      'prioritizing capital renewal by building system and risk;',
      'forecasting future reserve requirements; and',
      'maintaining facilities in a serviceable, functional, and safe condition.',
    ]),
    paragraph(
      `Observed conditions, available background information, estimated service life, and professional judgement are used to assign recommended actions over a long-range planning horizon. Opinions of probable cost are expressed in ${startYear} dollars unless noted otherwise and are intended for capital-planning purposes.`,
    ),
    paragraph('Recommended expenditures are assigned to the following planning periods:'),
    bullets([
      'Immediate – work requiring prompt attention or action in the base year;',
      'Short Term – work anticipated within approximately 1 to 2 years;',
      'Medium Term – work anticipated within approximately 3 to 5 years;',
      'Long Term – work anticipated within approximately 6 to 10 years; and',
      'Extended / End-of-Life Term – work anticipated within approximately 11 to 25 years.',
    ]),
    paragraph(
      'Where appropriate, budget ranges may be used rather than a single value when the scope cannot reasonably be defined without further investigation. Immediate concerns are identified with the recommended response, anticipated timing, and an order-of-magnitude cost allowance.',
    ),
  ]
  if (immediateConcerns) {
    blocks.push(
      paragraph('Our concerns recommended for action in the immediate are as follows:'),
      paragraph(immediateConcerns),
    )
  }
  return blocks
}

/**
 * Commentary that introduces the Level I capital needs table in the summary,
 * opening with the standing note that the plan is for prioritization rather
 * than a fixed construction sequence.
 */
function capitalNeedsCommentaryBlocks() {
  return [
    heading('Capital Planning Context', 3),
    paragraph(
      'The capital plan is intended to support prioritization rather than prescribe a fixed construction sequence. Action years should be reviewed periodically and may be advanced or deferred based on observed deterioration, operational needs, funding availability, coordination with other projects, and changes in facility strategy.',
    ),
    paragraph(
      'The following table organizes the recommended capital work by major building system and planning period. The totals provide a high-level view of the facility’s anticipated renewal requirements over the assessment horizon.',
    ),
  ]
}

/** Commentary printed under the capital needs table. */
function capitalNeedsDefinitionBlocks() {
  return [
    paragraph(
      'For the purposes of this report, a building system is a group of related components or assemblies that together perform a particular function within the facility or site. Typical systems include structural components, exterior enclosure, roofing, interior construction, plumbing, heating and cooling, electrical distribution, fire protection, equipment, and site improvements.',
    ),
    paragraph(
      'Each recommendation is assigned an action type and planning period based on the observed condition, anticipated remaining service life, operational considerations, and the relative importance of the affected component. Where a recommendation could reasonably fall into more than one category, the report uses the category considered most representative of the required action and its priority.',
    ),
  ]
}

/**
 * Intro to the Facility Scorecard.
 *
 * The scorecard is a summary of the pages behind it, not a second opinion: every
 * figure on it is read from the same capital plan the capital renewal, CRV and
 * FCI tables print. Saying so here is what stops a reader treating a headline
 * number that has been rounded for display as a disagreement with the detail.
 */
function facilityScorecardBlocks() {
  return [
    heading(LABELS.facilityScorecard, 1),
    paragraph(
      'A one-page management view of this facility. Every figure below is drawn from the capital plan detailed later in this report, and is presented here for decision-making convenience rather than as a separate analysis.',
    ),
  ]
}

/**
 * Intro to the component-level roll-up the client asked for.
 *
 * The capital table above it reports by building system, which answers what the
 * facility needs but not which components drive it. Without this the only
 * component-level view is the findings section, one asset per page.
 */
function componentSummaryBlocks() {
  return [
    heading(LABELS.componentSummary, 2),
    paragraph(
      'The table below lists each component included in this assessment, its observed condition, the recommended intervention and anticipated timing, and the associated budget allowance. It summarizes the detailed findings that follow, in the order those findings are presented.',
    ),
    paragraph(
      'Each allowance is the cost of one occurrence of the recommended action, as reported on that component’s page. Where a component is scheduled to renew more than once within the planning horizon, the capital renewal table above counts every occurrence, so its total is the higher of the two. Components listed for completeness but not assessed during this review are identified as such and carry no cost.',
    ),
  ]
}

/**
 * The standing caveat on visual-only observation. Printed under the capital
 * needs table in the summary and again under the conclusions.
 */
function visualObservationBlocks() {
  return [
    callout(
      'The findings in this report are based primarily on conditions that were visible and reasonably accessible at the time of the site review, together with information made available to the assessment team. Recommendations represent professional opinions formed from the information available during the assignment. Concealed, inaccessible, or unreviewed areas may contain conditions that could not be identified through a visual walk-through assessment.',
    ),
  ]
}

/** Intro to the year-by-year capital reserve schedule. */
function reserveScheduleIntroBlocks() {
  return [
    paragraph(
      'The schedule below shows the forecast timing of the capital expenditures identified during the assessment. Values are grouped by year to assist with reserve planning and multi-year budgeting.',
    ),
  ]
}

/** CRV definition and what the replacement value is taken to include. */
function crvIntroBlocks(ctx) {
  return [
    paragraph(
      `Current Replacement Value (CRV) represents an order-of-magnitude estimate of the cost, in ${ctx.startYear} dollars, to replace the existing facility and associated site assets with a functionally comparable facility using contemporary construction practices, materials, labour rates, and applicable project delivery allowances.`,
    ),
    paragraph(
      'Depending on the project and the information available, the replacement value may include allowances for both direct construction costs and indirect project costs. Typical components may include:',
    ),
    bullets([
      'architectural and engineering services, investigations, surveys, and permit-related costs;',
      'labour, materials, equipment, and normal construction activities;',
      'typical site preparation associated with replacement construction;',
      'excavation, grading, foundations, and backfilling where applicable;',
      'utility connections and related site servicing allowances;',
      'contractor supervision, overhead, profit, insurance, and similar project costs;',
      'commissioning and project close-out activities;',
      'site improvements and restoration; and',
      'demolition and removal of the existing facility or affected assets, where applicable.',
    ]),
    paragraph(
      'The project implementation allowances shown below provide a planning framework for converting component-level construction values into an overall replacement-value estimate. The percentages are budgeting assumptions and should be adjusted where project-specific information supports a different approach.',
    ),
  ]
}

/** The sentence that closes the CRV allowances table and leads into the totals. */
function crvClosingBlocks() {
  return [
    paragraph(
      'The estimated CRV summarized in the following table is an opinion of probable replacement cost developed for asset-planning purposes and incorporates the applicable project-delivery allowances used for this assessment.',
    ),
  ]
}

/**
 * The FCI definition, formula, condition bands and the caveats on reading them.
 *
 * The bands match `fci.grade_scales.ifma` in data/capital_planning_rules.json,
 * which is what actually grades the 0–2, 0–10 and 0–25 windows. The 0–5 column
 * grades on a different scale (`revised_0_5`) that this prose does not
 * describe — see docs/report-wording.md.
 */
function fciBlocks() {
  return [
    heading(LABELS.facilityConditionIndex, 2),
    paragraph(
      'The Facility Condition Index (FCI) is a planning indicator used to compare the cost of identified near-term renewal needs with the estimated Current Replacement Value of a facility. For this report, FCI is calculated using the immediate, Year 1, and Year 2 capital requirements divided by the facility CRV:',
    ),
    formula('FCI = (Immediate + Year 1 + Year 2 Capital Requirements) / Current Replacement Value'),
    paragraph(
      'A lower percentage generally indicates fewer near-term renewal needs relative to the value of the facility, while a higher percentage indicates a greater level of required reinvestment.',
    ),
    bullets([
      'Very Good: 0.0%–2.5%',
      'Good: 2.6%–5.0%',
      'Fair: greater than 5.0% up to 10.0%',
      'Poor: greater than 10.0% up to 30.0%',
      'Critical: greater than 30.0%',
    ]),
    paragraph(
      'FCI should be considered together with asset age, observed deficiencies, operational importance, planned redevelopment, and lifecycle timing. A facility with a favourable current FCI may still contain individual components requiring action, while a facility with a higher FCI may have planned renewal work concentrated within a particular future period. Regular condition reviews help confirm priorities and keep the capital plan current.',
    ),
    heading('Interpreting the FCI', 3),
    paragraph(
      'FCI is one indicator within the overall asset-management process. It should not be used on its own to determine whether a facility should be retained, renewed, replaced, or disposed of. Individual life-safety, regulatory, operational, or mission-critical deficiencies may warrant action regardless of the overall FCI score.',
    ),
  ]
}

/** The note that closes the Facility Information Summary table. */
function dataQualityBlocks() {
  return [
    heading('Data Quality Note', 3),
    paragraph(
      `Facility information in this section is based on the records available for the assignment. Where dimensions, age, area, or other attributes were not confirmed, the report shows “${NOT_PROVIDED}” rather than a value.`,
    ),
  ]
}

/** Opening of the per-asset findings section, and the basis for the ratings. */
function conditionAssessmentIntroBlocks() {
  return [
    heading(LABELS.conditionAssessmentFindings),
    paragraph(
      'This section documents the assessed building and site assets, their observed or reported condition, identified deficiencies, recommended actions, anticipated timing, and associated opinions of probable cost.',
    ),
    heading('Assessment Basis', 3),
    paragraph(
      'Condition and remaining service life reflect field observations first, supported by known installation dates, maintenance history, manufacturer information, and typical industry service-life ranges where available.',
    ),
  ]
}

/** Front-matter notices: copyright, third-party use, engagement. */
function disclaimerBlocks(ctx) {
  const { firm, client, property, assessmentType } = ctx
  return [
    heading('Report Use and Reliance'),
    legalHeading('Copyright and Confidential Information'),
    legal(
      `This report, including its written content, organization, graphics, schedules, tables, and project-specific methodology, has been prepared by ${firm} for the purpose identified in this document. Except where third-party material is used under permission or licence, the report content is the property of ${firm}. It may not be reproduced, distributed, adapted, or used for another purpose without prior written authorization, except as permitted under the agreement with the client.`,
    ),
    legal(
      'Project methods, internal workflows, calculation approaches, and other proprietary information contained in this report are provided for the client’s use in connection with this assignment. Such information is not intended for unrestricted distribution or reuse by others.',
    ),
    legalHeading('Third-Party Use'),
    legal(
      `This report was prepared for ${client} in connection with ${property} and is intended to support the client’s asset-management and capital-planning requirements. It does not constitute professional advice to any other person or organization.`,
    ),
    legal(
      `Any third party that receives or reviews this report does so at its own risk unless ${firm} has provided specific written authorization allowing that party to rely on the report. To the extent permitted by law, ${firm} does not accept responsibility for loss, damage, cost, or consequence arising from unauthorized third-party reliance. Nothing in this statement limits liability that cannot legally be excluded.`,
    ),
    legalHeading('Client and Assignment Reference'),
    legal(
      `${firm} was retained by ${client} to complete a ${assessmentType} for ${property}. The professional services described in this report were performed for the client under the terms of the applicable agreement.`,
    ),
  ]
}

/** Closing appendix: scope of the visual review, warranties, cost opinions. */
function limitationsBlocks(ctx) {
  const { firm, client } = ctx
  return [
    heading('Appendix – Scope Limitations and Basis of Assessment'),
    legal(
      `This report has been prepared for the use of ${client} in connection with the facility and project identified in the report. No other party is entitled to rely on the report unless ${firm} provides written authorization for such reliance.`,
    ),
    legal(
      `A party that uses this report without written authorization assumes responsibility for that use and for any decisions made from the information contained herein. To the extent permitted by law, ${firm} is not responsible for loss, damage, or cost arising from unauthorized reliance by others.`,
    ),
    legal(
      'The assessment was completed using a visual, walk-through and generally non-destructive approach consistent with the agreed scope of services. The report describes conditions observed or otherwise identified at the time of the assessment. Building and site conditions may change after the assessment date.',
    ),
    legal(
      'Unless specifically included elsewhere in the agreement or report, the assessment did not include legal or boundary surveys, destructive testing, soil investigations, environmental investigations, hazardous-material surveys, geotechnical studies, seismic evaluations, detailed structural calculations, detailed code-compliance reviews, full accessibility audits, commissioning tests, concealed-condition investigations, or quantity-surveying services.',
    ),
    legal(
      'The assessment is a professional opinion based on the information reasonably available during the assignment. It is not a warranty, guarantee, certification of all building conditions, or representation that every defect or deficiency has been identified. The presence of concealed or inaccessible conditions cannot be ruled out.',
    ),
    legal(
      `Where information was provided by the client, facility staff, contractors, occupants, records, drawings, or other sources, ${firm} relied on that information where it appeared reasonable to do so. Unless specifically stated, such information was not independently verified in full. If new or conflicting information becomes available, the conclusions and recommendations may require revision.`,
    ),
    legal(
      'Recommendations are based on the conditions observed at the time of the review, the reported history of components, typical service-life expectations, and professional judgement. A detailed investigation may be required before design, procurement, repair, or replacement work proceeds.',
    ),
    legal(
      'References to codes, standards, or regulatory requirements are made for general assessment and planning purposes unless the report specifically states that a detailed compliance review was completed. The assessment should not be interpreted as confirmation that the entire property complies with every applicable code, by-law, regulation, or standard.',
    ),
    legal(
      'Building systems continue to age and may deteriorate, fail, be repaired, or be altered after the assessment date. Accordingly, the report represents a snapshot of the facility based on the information and conditions available at the time of the review.',
    ),
    heading('Basis of Cost Allowances', 2),
    legal(
      'The cost values presented in this report are opinions of probable cost prepared for capital-planning and budgeting purposes. They are not contractor quotations, tender prices, or guarantees of the final cost of the work.',
    ),
    legal('Actual project costs may vary due to factors such as:'),
    bullets([
      'the final scope and design solution;',
      'hidden or unforeseen conditions;',
      'construction phasing and site access;',
      'occupied-building requirements and operational constraints;',
      'material and labour market conditions;',
      'contractor availability and procurement method;',
      'escalation between the assessment date and construction;',
      'permits, approvals, taxes, and owner requirements; and',
      'the level of investigation and documentation completed before tender.',
    ]),
    legal('Unless specifically stated otherwise, taxes are excluded from the reported cost allowances.'),
    legal(
      'Before major repair or replacement work is authorized, the affected component should be reviewed in greater detail and the scope should be confirmed through appropriate design, specifications, quantity verification, and procurement. Tendered or negotiated contractor pricing will provide a more reliable indication of actual construction cost.',
    ),
    legal(
      'Because this assessment is visual and non-destructive, additional deficiencies may be discovered during future investigation or construction. Such findings may require changes to the recommendations, timing, or budget allowances.',
    ),
  ]
}

/** Closing section that restates the engagement and repeats the Level I table. */
function conclusionsIntroBlocks(ctx) {
  const { firm, property, address, assessmentType } = ctx
  return [
    heading('Assessment Conclusions and Capital Priorities'),
    paragraph(
      `${firm} completed a ${assessmentType} for ${property} at ${address}. The assessment was undertaken to document the condition of major accessible building and site components and to support long-term repair, renewal, and capital-planning decisions.`,
    ),
    paragraph(
      'The recommended work and associated budget allowances are intended to help the client plan for the continued serviceability of the facility. The capital forecast considers observed condition, expected lifecycle, timing of renewal, and the information available at the time of the assessment.',
    ),
    paragraph(
      'The table below summarizes the forecast capital requirements by major building system and planning period.',
    ),
  ]
}

/** The paragraph that closes the conclusions, after the capital table. */
function conclusionsClosingBlocks() {
  return [
    paragraph(
      'The conclusions are based on a visual, non-destructive review of reasonably accessible areas and on information available to the project team. Conditions concealed by finishes, equipment, stored materials, restricted access, or other obstructions were not verified unless specifically noted. If additional information or previously concealed conditions become available, the recommendations and cost allowances should be reviewed and updated as appropriate.',
    ),
  ]
}

// ---------------------------------------------------------------------------
// Portfolio (multi-building) prose.
// ---------------------------------------------------------------------------

/** Opening of the consolidated portfolio section of a multi-building report. */
function portfolioOverviewBlocks(ctx) {
  return [
    heading(LABELS.portfolioOverview),
    paragraph(
      `This section presents a consolidated financial overview of the facilities included in ${ctx.projectName}. The summary brings together the estimated Current Replacement Value, near-term capital requirements, and Facility Condition Index for each assessed property. Detailed findings for every facility are provided later in the report.`,
    ),
  ]
}

/** Intro to the portfolio-wide capital needs table. */
function portfolioCapitalBlocks() {
  return [
    heading(LABELS.portfolioCapitalRequirements, 2),
    paragraph(
      'The table below combines the recommended capital expenditures for all assessed facilities and groups them by major building system and planning horizon.',
    ),
  ]
}

/** Intro to the portfolio-wide year-by-year forecast. */
function portfolioForecastBlocks() {
  return [
    heading(LABELS.portfolioForecast, 2),
    paragraph(
      'The following schedule distributes the identified capital requirements across the assessment horizon. Amounts are organized by year to support reserve planning, budgeting, and long-range asset-management decisions.',
    ),
  ]
}

/** The "not assessed" note printed in place of an unassessed asset's findings. */
const NOT_ASSESSED_NOTE =
  'This component is listed for completeness but was not assessed during this review. No condition rating, recommendation, or cost estimate is available.'

const reportContent = {
  SUMMARY_SECTIONS,
  SUMMARY_SECTION_GROUPS,
  LABELS,
  COMPONENT_SUMMARY_COLUMNS,
  SCORECARD_TILES,
  SCORECARD_PRIORITY_COLUMNS,
  CONDITION_SNAPSHOT_COLUMNS,
  FACILITY_FIELDS,
  ASSET_FIELDS,
  NOT_PROVIDED,
  NOT_ASSESSED_NOTE,
  executiveSummaryIntroBlocks,
  capitalNeedsCommentaryBlocks,
  capitalNeedsDefinitionBlocks,
  componentSummaryBlocks,
  facilityScorecardBlocks,
  visualObservationBlocks,
  reserveScheduleIntroBlocks,
  crvIntroBlocks,
  crvClosingBlocks,
  fciBlocks,
  dataQualityBlocks,
  conditionAssessmentIntroBlocks,
  disclaimerBlocks,
  limitationsBlocks,
  conclusionsIntroBlocks,
  conclusionsClosingBlocks,
  portfolioOverviewBlocks,
  portfolioCapitalBlocks,
  portfolioForecastBlocks,
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = reportContent
} else if (typeof window !== 'undefined') {
  window.reportContent = reportContent
}
})()
