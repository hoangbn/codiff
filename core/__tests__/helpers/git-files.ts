type FileContentResult = {
  available: boolean;
  binary: boolean;
  file?: {
    cacheKey: string;
    contents: string;
    name: string;
  };
  fingerprint?: string;
  loadState?: string;
  summary?: {
    canLoad?: boolean;
    size?: number;
  };
};

type GitFilesModule = {
  readGitFiles: (
    repoRoot: string,
    ref: string,
    paths: ReadonlyArray<string>,
    options?: { refScopedEmptyCacheKey?: boolean },
  ) => Promise<Map<string, FileContentResult>>;
};

import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);

export const git = async (repository: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

export const fastImport = async (repository: string, input: Buffer) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', repository, 'fast-import', '--quiet'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `git fast-import exited with code ${code}.`));
      }
    });
    child.stdin.end(input);
  });
};

export const createGitHistory = async (repository: string) => {
  const chunks: Array<Buffer> = [];
  let nextMark = 1;
  const addBlob = (contents: string | Uint8Array) => {
    const mark = nextMark;
    nextMark += 1;
    const buffer = Buffer.from(contents);
    chunks.push(
      Buffer.from(`blob\nmark :${mark}\ndata ${buffer.length}\n`),
      buffer,
      Buffer.from('\n'),
    );
    return mark;
  };
  const addCommit = (
    ref: string,
    message: string,
    commands: ReadonlyArray<string>,
    parent?: number,
  ) => {
    const mark = nextMark;
    nextMark += 1;
    chunks.push(
      Buffer.from(
        [
          `commit ${ref}`,
          `mark :${mark}`,
          'committer Codiff Test <codiff@example.com> 0 +0000',
          `data ${Buffer.byteLength(message)}`,
          message,
          ...(parent == null ? [] : [`from :${parent}`]),
          ...commands,
          '',
        ].join('\n'),
      ),
    );
    return mark;
  };

  const baseCommands = [
    `M 100644 :${addBlob('')} empty.txt`,
    `M 100644 :${addBlob('before\n')} modified.txt`,
    `M 100644 :${addBlob('rename before\n')} renamed-old.txt`,
    `M 100644 :${addBlob('deleted\n')} deleted.txt`,
    `M 100644 :${addBlob(Uint8Array.from([0, 1, 2, 3]))} binary.bin`,
    `M 100644 :${addBlob('literal before\n')} literal-:(name).txt`,
    ...Array.from(
      { length: 500 },
      (_, index) =>
        `M 100644 :${addBlob(`base ${index}\n`)} src/file-${index.toString().padStart(3, '0')}.ts`,
    ),
  ];
  const baseCommit = addCommit('refs/heads/base', 'base', baseCommands);
  const headCommands = [
    `M 100644 :${addBlob('after\n')} modified.txt`,
    'D renamed-old.txt',
    `M 100644 :${addBlob('rename after\n')} renamed-new.txt`,
    'D deleted.txt',
    `M 100644 :${addBlob('added\n')} added.txt`,
    `M 100644 :${addBlob(Uint8Array.from([0, 4, 5, 6]))} binary.bin`,
    `M 100644 :${addBlob('literal after\n')} literal-:(name).txt`,
    `M 100644 :${addBlob('m'.repeat(1024 * 1024 + 1))} medium.txt`,
    `M 100644 :${addBlob('h'.repeat(2 * 1024 * 1024 + 1))} huge.txt`,
    ...Array.from(
      { length: 500 },
      (_, index) =>
        `M 100644 :${addBlob(`head ${index}\n`)} src/file-${index.toString().padStart(3, '0')}.ts`,
    ),
  ];
  addCommit('refs/heads/head', 'head', headCommands, baseCommit);
  chunks.push(Buffer.from('done\n'));
  await fastImport(repository, Buffer.concat(chunks));
};

export const { readGitFiles } =
  require('../../../electron/git-state/git-files.cjs') as GitFilesModule;
