// @ts-check

const { z } = require('zod');
const { validateProviderPath } = require('./common.cjs');

const shaSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i);
const pathSchema = z.string().refine((path) => {
  try {
    return validateProviderPath(path) === path;
  } catch {
    return false;
  }
}, 'Invalid repository path.');
const repositorySchema = z.object({
  full_name: z.string().optional(),
  name: z.string().optional(),
  owner: z.object({ login: z.string().optional() }).optional(),
});
const revisionSchema = z.object({
  ref: z.string().min(1).optional(),
  repo: repositorySchema.nullable().optional(),
  sha: shaSchema.optional(),
});
const githubMetadataSchema = z.object({
  base: revisionSchema.optional(),
  body: z.string().nullable().optional(),
  head: revisionSchema.extend({ sha: shaSchema }),
  title: z.string().optional(),
  user: z
    .object({
      avatar_url: z.url().optional(),
      html_url: z.url().optional(),
      login: z.string().optional(),
    })
    .optional(),
});
const githubFilesSchema = z.array(
  z.array(
    z.object({
      filename: pathSchema,
      patch: z.string().optional(),
      previous_filename: pathSchema.optional(),
      status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
    }),
  ),
);
const gitlabMetadataSchema = z.object({
  author: z
    .object({
      avatar_url: z.url().nullable().optional(),
      name: z.string().optional(),
      username: z.string().optional(),
      web_url: z.url().optional(),
    })
    .nullable()
    .optional(),
  description: z.string().nullable().optional(),
  diff_refs: z
    .object({
      base_sha: shaSchema.optional(),
      head_sha: shaSchema.optional(),
      start_sha: shaSchema.optional(),
    })
    .nullable()
    .optional(),
  sha: shaSchema,
  target_branch: z.string().min(1).optional(),
  title: z.string().optional(),
  web_url: z.url().optional(),
});
const gitlabDiffsSchema = z.array(
  z.object({
    deleted_file: z.boolean(),
    diff: z.string(),
    new_file: z.boolean(),
    new_path: pathSchema,
    old_path: pathSchema,
    renamed_file: z.boolean(),
  }),
);
const snapshotSchema = z.object({
  baseSha: shaSchema.optional(),
  headSha: shaSchema.optional(),
});

/** @param {{baseSha?: string; headSha?: string}} requested @param {{baseSha?: string; headSha?: string}} current @param {string} provider */
const assertProviderSnapshot = (requested, current, provider) => {
  const snapshot = snapshotSchema.parse(requested);
  if (
    (snapshot.headSha && snapshot.headSha !== current.headSha) ||
    (snapshot.baseSha && snapshot.baseSha !== current.baseSha)
  ) {
    throw new Error(`${provider} review changed. Refresh the review before loading file contents.`);
  }
};

module.exports = {
  assertProviderSnapshot,
  githubFilesSchema,
  githubMetadataSchema,
  gitlabDiffsSchema,
  gitlabMetadataSchema,
};
