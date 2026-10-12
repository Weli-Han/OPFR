// Model routing: the user-approved table plus the escalation ladder.
// simple = haiku high; normal = haiku xhigh (1-2 files, existing pattern) or sonnet medium;
// complex = sonnet high (sonnet xhigh for security/data/concurrency); critical = opus high.
const LADDER = [
  ['haiku', 'high'],
  ['haiku', 'xhigh'],
  ['sonnet', 'medium'],
  ['sonnet', 'high'],
  ['sonnet', 'xhigh'],
  ['opus', 'high'],
];

function startRung(t) {
  if (t.model) {
    const i = LADDER.findIndex(([m, e]) => m === t.model && e === (t.effort || e));
    if (i >= 0) return i;
  }
  switch (t.tier) {
    case 'simple': return 0;
    case 'complex': return t.risky ? 4 : 3;
    case 'critical': return 5;
    default: return t.small ? 1 : 2; // normal
  }
}

function pick(t) {
  // An explicit model outside the ladder (for example the conductor model for the report) is used as is.
  if (t.model && t.rung == null) return { model: t.model, effort: t.effort || 'high' };
  const [model, effort] = LADDER[Math.min(t.rung, LADDER.length - 1)];
  return { model, effort };
}

function escalate(t) {
  t.rung = Math.min((t.rung ?? startRung(t)) + 1, LADDER.length - 1);
  return pick(t);
}

module.exports = { LADDER, startRung, pick, escalate };
