export interface TaskProposal {
  question: string;
  options: string[];
  pick: string;
  why: string;
}

const REQUIRED = ['question', 'options', 'pick', 'why'] as const;

export function parseTaskProposal(raw: string): { proposal: TaskProposal } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    return { error: `Malformed proposal: ${reason}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Malformed proposal: expected a JSON object' };
  }
  const row = value as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (!(key in row)) return { error: `Malformed proposal: missing ${key}` };
  }
  if (typeof row.question !== 'string' || !row.question.trim()) {
    return { error: 'Malformed proposal: question must be a nonempty string' };
  }
  if (typeof row.why !== 'string' || !row.why.trim()) {
    return { error: 'Malformed proposal: why must be a nonempty string' };
  }
  if (typeof row.pick !== 'string' || !row.pick) {
    return { error: 'Malformed proposal: pick must be a nonempty string' };
  }
  if (!Array.isArray(row.options)) {
    return { error: 'Malformed proposal: options must be an array' };
  }
  if (row.options.length === 0) {
    return { error: 'Malformed proposal: options must not be empty' };
  }
  if (row.options.some((item) => typeof item !== 'string' || !item)) {
    return { error: 'Malformed proposal: options must be nonempty strings' };
  }
  const options = row.options as string[];
  if (!options.includes(row.pick)) {
    return { error: 'Malformed proposal: pick is not one of the options' };
  }
  return {
    proposal: {
      question: row.question.trim(),
      options,
      pick: row.pick,
      why: row.why.trim(),
    },
  };
}

export function isProposalChoice(proposal: TaskProposal, choice: string): boolean {
  return choice === 'discuss' || choice === 'reject' || proposal.options.includes(choice);
}
