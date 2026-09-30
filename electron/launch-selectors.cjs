const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

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
  const repositoryPath =
    explicitPaths[0] ??
    positionals.find(
      (value) =>
        existsSync(resolve(value)) &&
        !gitSucceeds(process.cwd(), ['rev-parse', '--verify', `${value}^{commit}`]),
    );
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

const validateReviewSelectors = ({ commitRef, branchRef, positionalSources, providerSource }) => {
  if (
    [commitRef, branchRef, providerSource].filter(Boolean).length + positionalSources.length >
    1
  ) {
    throw new Error('Choose only one review source: commit, branch, range, or provider.');
  }
};

module.exports = { getReviewPositionals, validateReviewSelectors, validateSourceFlags };
