const getCommitRevision = (ref) => (ref.startsWith(':/') ? ref : `${ref}^{commit}`);

module.exports = { getCommitRevision };
