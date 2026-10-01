const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { getCommitRevision } = require('./git-revision.cjs');

const validateSourceFlags = (tokens) => {
  const names = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option' || !['commit', 'branch'].includes(token.name)) {
      continue;
    }
    if (typeof token.value !== 'string' || !token.value.trim() || token.value.startsWith('-')) {
      throw new Error(`--${token.name} requires a nonempty revision.`);
    }
    if (names.has(token.name)) {
      throw new Error('Choose only one review source: commit, branch, range, or provider.');
    }
    names.add(token.name);
  }
};

const gitSucceeds = (repositoryPath, args) => {
  try {
    execFileSync('git', ['-C', repositoryPath, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const getReviewPositionals = (positionals) => {
  if (positionals.some((value) => !value.trim())) {
    throw new Error('Review source and repository path must be nonempty.');
  }
  const explicitPaths = positionals.filter(
    (value) => value.startsWith('/') || value.startsWith('./') || value.startsWith('../'),
  );
  if (explicitPaths.length > 1) {
    throw new Error('Choose only one repository path for the review source.');
  }
  if (
    explicitPaths.length === 0 &&
    positionals.length === 1 &&
    gitSucceeds(process.cwd(), ['rev-parse', '--verify', getCommitRevision(positionals[0])])
  ) {
    return { repositoryPath: undefined, sourceCandidates: positionals };
  }
  const implicitPaths = positionals.filter(
    (value) => !value.includes('..') && existsSync(resolve(value)),
  );
  const repositoryPath =
    explicitPaths[0] ??
    implicitPaths.findLast((value) =>
      gitSucceeds(resolve(value), ['rev-parse', '--show-toplevel']),
    ) ??
    implicitPaths.at(-1);
  const repositoryIndex = positionals.indexOf(repositoryPath);
  const sourceCandidates = positionals.filter((_value, index) => index !== repositoryIndex);
  if (
    !repositoryPath &&
    sourceCandidates.length === 1 &&
    !sourceCandidates[0].includes('..') &&
    !gitSucceeds(process.cwd(), ['rev-parse', '--show-toplevel'])
  ) {
    return { repositoryPath: sourceCandidates[0], sourceCandidates: [] };
  }
  return { repositoryPath, sourceCandidates };
};

const validateReviewSelectors = ({
  commitRef,
  branchRef,
  positionalSources,
  providerSourceCount,
}) => {
  if (
    [commitRef, branchRef].filter(Boolean).length + positionalSources.length + providerSourceCount >
    1
  ) {
    throw new Error('Choose only one review source: commit, branch, range, or provider.');
  }
};

module.exports = { getReviewPositionals, validateReviewSelectors, validateSourceFlags };
