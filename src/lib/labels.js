export const TRIAGE_LABELS = [
  'triage:pending', 'triage:in-progress', 'triage:needs-info',
  'triage:needs-reproduction', 'triage:ready-for-review', 'triage:complete',
  'triage:stalled', 'triage:ping', 'triage:tests-needed',
];

export const TEAM_LABELS = [
  'team:nodes', 'team:ai', 'team:api', 'team:iam', 'team:chat', 'team:design',
  'team:qa-dx', 'team:lifecycle', 'team:relay', 'team:identity', 'team:cats',
  'team:payday', 'team:adore', 'team:ins', 'team:instance-ai',
];

export const CLOSED_LABELS = [
  'closed:duplicate', 'closed:cant-reproduce', 'closed:working-as-expected',
  'closed:support-issue', 'closed:incomplete-template',
  'closed:enhancement/feature', 'closed:info', 'closed:non-english',
  'closed:requested',
];

export const ALL_FILTER_LABELS = [...TRIAGE_LABELS, ...TEAM_LABELS, ...CLOSED_LABELS];

// Spec section 8 headline: the rejection reasons which say the issue should
// never have been filed as a bug at all. A subset of CLOSED_LABELS. An issue
// carrying two of them is counted once.
export const SHOULD_NOT_HAVE_BEEN_FILED = [
  'closed:incomplete-template', 'closed:support-issue', 'closed:non-english',
];

// Retained deliberately: these matched ZERO issues in the measured population
// because they never co-occur with the 33 filter labels. They cost nothing and
// n8n's labelling may change. Do not delete them assuming they are broken.
export const ADHOC_COMPONENT_LABELS = [
  'core', 'ui', 'dx', 'deployment', 'performance', 'security',
];
