export const meta = {
  name: 'agent-bug-hunt',
  description: 'Drive many design apps through realistic human iteration, find edits the agent cannot complete, verify and consolidate them',
  phases: [
    { title: 'Session', detail: 'design each app then iterate on it like a human, capture failures' },
    { title: 'Verify', detail: 'adversarially confirm each candidate bug is real (not infra/taste)' },
    { title: 'Consolidate', detail: 'cluster by root cause, rank severity, propose fixes' },
  ],
}

// Resolve the app dir relative to this workflow file (.claude/workflows/ -> app/).
const APP = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const RUN = `npm --prefix ${APP} run -s session --`

// Realistic apps. Each initial prompt asks for a COMPLETE screen so there are real
// elements (rows, cards, bars) for the iteration turns to select and edit.
const APPS = [
  { key: 'login', design: "Design a polished mobile login screen: app logo at top, an email field, a password field, a primary 'Sign In' button, and a 'Forgot password?' link below." },
  { key: 'chat', design: "Design a mobile chat conversation screen: a top bar with the contact's avatar and name, a scrollable list of message bubbles alternating incoming (left) and outgoing (right), and a bottom input bar with a text field and a send button." },
  { key: 'weather', design: "Design an iOS weather home screen: large current temperature and condition at the top, an hourly forecast row of cards, and a daily forecast list with one row per day showing day name, a weather icon, and a high/low temperature." },
  { key: 'facebook', design: "Design a Facebook-style social feed: a top nav bar with logo and icons, a 'What's on your mind?' composer row, and three feed posts each with an avatar, name, body text, a photo, and a like / comment / share action row." },
  { key: 'instagram', design: "Design an Instagram profile screen: a header with a circular avatar, username, a stats row (posts / followers / following), a bio, an Edit Profile button, and a 3-column grid of square photo thumbnails." },
  { key: 'youtube', design: "Design a YouTube home screen: a top bar with a search field, a horizontal row of category chips, and a vertical list of video cards each with a thumbnail, a title, a channel name, and a view count." },
  { key: 'spotify', design: "Design a Spotify now-playing screen: large album art, a track title and artist, a progress bar with elapsed/total times, and a playback control row (shuffle, previous, play, next, repeat)." },
  { key: 'settings', design: "Design an iOS Settings screen: a search field, then grouped lists of setting rows where each row has a left icon, a label, and a right-side chevron or toggle." },
]

const BUG_SCHEMA = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    designOk: { type: 'boolean', description: 'Did the initial design turn complete and produce a plausible screen?' },
    infraErrors: {
      type: 'array', description: 'Turns that failed for INFRA reasons (429/rate/overloaded/timeout/ECONN/Run threw) — NOT product bugs.',
      items: { type: 'object', properties: { turn: { type: 'number' }, reason: { type: 'string' } }, required: ['turn', 'reason'] },
    },
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          turnIndex: { type: 'number' },
          intent: { type: 'string', description: "The human edit request that the agent mishandled." },
          selection: { type: 'string', description: 'What was selected (names) or "none".' },
          category: { type: 'string', enum: ['restyle', 'alternating-fills', 'align-distribute', 'move-resize', 'delete', 'add-content', 'reparent', 'global-theme', 'other'] },
          failKind: { type: 'string', enum: ['hardFail', 'silentNoop', 'wrongResult'], description: 'hardFail = escalated "cant complete"; silentNoop = claimed done but changed nothing; wrongResult = done+ops but did NOT do what was asked.' },
          evidence: { type: 'string', description: 'The escalation reason, OR the op-list / final-tree facts proving the result is wrong/empty.' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          severityWhy: { type: 'string' },
        },
        required: ['app', 'turnIndex', 'intent', 'selection', 'category', 'failKind', 'evidence', 'severity', 'severityWhy'],
      },
    },
  },
  required: ['app', 'designOk', 'infraErrors', 'bugs'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isRealBug: { type: 'boolean', description: 'TRUE only if this is a genuine product defect: the agent failed or did the wrong thing on a reasonable canvas-edit request. FALSE for infra flakes, ambiguous/unreasonable requests, or outcomes that are actually acceptable.' },
    rootCause: { type: 'string', description: 'Your best hypothesis of the underlying cause (e.g. "planner drops malformed flattened tool input", "no delete tool", "selectNameLike matched title text not a button", "verify rejects valid alternating restyle").' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string' },
  },
  required: ['isRealBug', 'rootCause', 'confidence', 'note'],
}

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rootCause: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          affectedApps: { type: 'array', items: { type: 'string' } },
          bugCount: { type: 'number' },
          exampleIntents: { type: 'array', items: { type: 'string' } },
          proposedFix: { type: 'string', description: 'Concrete code-level fix: which file/function and what change. Be specific.' },
          fixRisk: { type: 'string', description: 'Risk of the fix (esp. PLAN_TOOL prompt fragility for align/restyle).' },
        },
        required: ['title', 'rootCause', 'severity', 'affectedApps', 'bugCount', 'exampleIntents', 'proposedFix', 'fixRisk'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['clusters', 'summary'],
}

phase('Session')
log(`Driving ${APPS.length} apps through design + human iteration…`)

const perApp = await pipeline(
  APPS,
  // STAGE 1: design the app, learn its real node names, then run a full human-like
  // iteration session and self-classify every turn.
  (appSpec) => agent(
    `You are stress-testing an agentic design-canvas tool by acting as a human user who designs an app, then iterates on it. ` +
    `Your job is to find edit requests the agent CANNOT complete (or completes wrongly).\n\n` +
    `APP: ${appSpec.key}\nINITIAL DESIGN PROMPT:\n${appSpec.design}\n\n` +
    `The harness: \`${RUN} <specFile.json>\` runs a MULTI-TURN session against ONE persistent canvas and prints a JSON object on stdout ` +
    `(human trace on stderr). Spec shape:\n` +
    `{ "app": "${appSpec.key}", "seed": "empty", "turns": [ { "intent": "<edit request>", "selectNameLike": "<optional: selects every node whose NAME contains this substring, case-insensitive>" }, ... ] }\n\n` +
    `selectNameLike mimics a human clicking an element before editing it — but it matches by NODE NAME, so you must know the real names first.\n\n` +
    `STEP A — learn the real node names. Write /tmp/wf-${appSpec.key}-design.json with app/seed and a SINGLE turn (the initial design prompt). Run:\n` +
    `  ${RUN} /tmp/wf-${appSpec.key}-design.json > /tmp/wf-${appSpec.key}-design.out 2> /tmp/wf-${appSpec.key}-design.err\n` +
    `Read the .out file's finalTree and note the actual node names (e.g. "Daily Row", "Sign In Button", "Video Card").\n\n` +
    `STEP B — design 6 realistic human iteration turns that TARGET those real names and STRESS the editable-canvas tools. Cover a spread of categories — include at least:\n` +
    `  • one alternating-fills / "make each row or card more distinct" restyle on a repeated element (select the repeated element by name),\n` +
    `  • one other restyle or recolor of a selected element,\n` +
    `  • one align / distribute / "even out the spacing" / "make these a row",\n` +
    `  • one move or resize ("make the avatar bigger", "move X"),\n` +
    `  • one delete ("remove the X"),\n` +
    `  • one add-content ("add a search bar", "add a tab bar at the bottom"),\n` +
    `  • optionally one global theme change ("switch to dark mode", "round all the corners").\n` +
    `Phrase them the way a real user would — short, natural, sometimes a little loose. Use selectNameLike whenever the edit targets a specific element.\n\n` +
    `STEP C — write /tmp/wf-${appSpec.key}-iter.json containing the SAME initial design turn FOLLOWED BY your 6 iteration turns (one coherent session from empty). Run:\n` +
    `  ${RUN} /tmp/wf-${appSpec.key}-iter.json > /tmp/wf-${appSpec.key}-iter.out 2> /tmp/wf-${appSpec.key}-iter.err\n` +
    `Read the .out JSON.\n\n` +
    `STEP D — classify EVERY iteration turn (index >= 1) using its terminal + ops + the finalTree:\n` +
    `  • hardFail: terminal.kind == "escalated" (or threw). The agent told the user it couldn't make the edit. This is the PRIMARY bug class.\n` +
    `  • silentNoop: terminal.kind == "done" but changed==false / opCount==0. Agent claimed success but the canvas did not change.\n` +
    `  • wrongResult: terminal.kind == "done" with ops, but the ops + finalTree show it did NOT do what the intent asked (e.g. "alternating fills" but all rows ended the same color; "delete X" but X still present; "move" but nothing moved; recolored the wrong node because selection matched a title not a button).\n` +
    `  EXCLUDE infra failures: if an escalation reason contains 429 / rate / overloaded / timeout / ECONN / "Run threw" with a network message, record it under infraErrors, NOT bugs. Re-run the session ONCE if MOST turns infra-failed.\n\n` +
    `For each real bug, assign severity: critical = core edit class totally broken (e.g. cannot recolor/align at all); high = common edit reliably fails or does the wrong thing; medium = works but mishandles a plausible variant; low = minor/cosmetic. Give a one-line severityWhy.\n\n` +
    `Return the structured result. If an iteration turn worked correctly, do not invent a bug for it — only report genuine failures/wrong-results. It is fine for an app to yield zero bugs.`,
    { label: `session:${appSpec.key}`, phase: 'Session', schema: BUG_SCHEMA },
  ),
  // STAGE 2: adversarially verify each candidate bug from this app, concurrently.
  (res, appSpec) => {
    if (!res || !res.bugs || res.bugs.length === 0) return []
    return parallel(res.bugs.map((b) => () =>
      agent(
        `Adversarially verify whether this reported design-agent bug is REAL — default to skepticism.\n\n` +
        `App: ${b.app}\nHuman request: "${b.intent}"\nSelection: ${b.selection}\nReported failKind: ${b.failKind}\nCategory: ${b.category}\nEvidence: ${b.evidence}\n\n` +
        `The reproduction lives in /tmp/wf-${appSpec.key}-iter.out (full session JSON, incl. per-turn ops + finalTree) and /tmp/wf-${appSpec.key}-iter.json (the spec). ` +
        `Read them. Confirm turn ${b.turnIndex} really shows what's claimed. ` +
        `Source for root-cause is under ${APP}/src — esp. src/agent/llm-adapter.ts (planner emit_plan parsing + PLAN_TOOL), src/agent/loop.ts (the loop + escalation messages), src/agent/verify.ts (criterion checks), src/shared/tools.ts (the tool registry — which tools EXIST). Grep there to ground your rootCause.\n\n` +
        `Mark isRealBug=false if: the failure was infra (429/timeout/network), the request was genuinely ambiguous or asked for something out of scope, OR the outcome is actually acceptable and the reporter misjudged it. Otherwise isRealBug=true with a concrete code-level rootCause.`,
        { label: `verify:${appSpec.key}:t${b.turnIndex}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((v) => (v ? { ...b, verdict: v } : null))
    ))
  },
)

const allBugs = perApp.filter(Boolean).flat().filter(Boolean)
const realBugs = allBugs.filter((b) => b.verdict && b.verdict.isRealBug)
log(`Candidate bugs: ${allBugs.length}; confirmed real: ${realBugs.length}`)

phase('Consolidate')
const consolidation = await agent(
  `You are consolidating verified bugs from an agentic design-canvas tool into root-cause clusters with fixes.\n\n` +
  `Here are the confirmed bugs (each has app, intent, category, failKind, evidence, severity, and a verifier verdict with rootCause):\n` +
  JSON.stringify(realBugs.map((b) => ({
    app: b.app, intent: b.intent, selection: b.selection, category: b.category,
    failKind: b.failKind, severity: b.severity, evidence: b.evidence,
    rootCause: b.verdict?.rootCause, confidence: b.verdict?.confidence,
  })), null, 2) + `\n\n` +
  `Cluster these by SHARED root cause (not by app). For each cluster: title, the underlying root cause, a severity (max across its bugs weighted by frequency), which apps it hit, how many bugs, 2-3 example intents, a CONCRETE proposed fix (name the file/function in ${APP}/src and the change), and the fix's risk. ` +
  `IMPORTANT context: a known-fragile spot is the planner's PLAN_TOOL prompt (src/agent/llm-adapter.ts) — prompt edits there destabilize simple align/restyle planning, so prefer ROBUST PARSER/CODE fixes (like the recent flattened-steps recovery) over more prompt text when possible. ` +
  `Order clusters by fix priority (severity × frequency × fix-confidence). Then write a 3-4 sentence summary of the dominant failure modes.`,
  { label: 'consolidate', phase: 'Consolidate', schema: CLUSTER_SCHEMA, effort: 'high' },
)

return { totalCandidates: allBugs.length, confirmedReal: realBugs.length, perAppCounts: perApp.map((r, i) => ({ app: APPS[i].key, bugs: (r || []).length })), clusters: consolidation.clusters, summary: consolidation.summary, realBugs }
