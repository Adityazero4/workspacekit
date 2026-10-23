import { ServerCodeBlock } from 'fumadocs-ui/components/codeblock.rsc';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INCLUDE_LANGUAGES, resolveIncludePath } from '../lib/includePath.mjs';

function repositoryRoot(): string {
  let folder = process.cwd();
  while (!existsSync(path.join(folder, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(folder);
    if (parent === folder) {
      throw new Error('Include could not find the repository root (pnpm-workspace.yaml).');
    }
    folder = parent;
  }
  return folder;
}

const REPOSITORY_ROOT = repositoryRoot();

/**
 * Props of `Include`: the repository-relative path of a file under `examples/`.
 *
 * @example
 * const props: IncludeProps = { file: 'examples/recipes/src/theming.css' };
 */
export interface IncludeProps {
  file: string;
}

/**
 * Embeds an example file from the repository as a highlighted code block, read when the site builds, so a
 * recipe page can never drift from the tested source.
 *
 * @example
 * ```mdx
 * <Include file="examples/recipes/src/theming.css" />
 * ```
 */
export async function Include({ file }: IncludeProps): Promise<React.JSX.Element> {
  const code = (await readFile(await resolveIncludePath(REPOSITORY_ROOT, file), 'utf8')).trimEnd();
  const lang = INCLUDE_LANGUAGES[path.extname(file) as keyof typeof INCLUDE_LANGUAGES];
  return (
    <>
      <p>
        <code>{file}</code>
      </p>
      <ServerCodeBlock code={code} lang={lang} themes={{ light: 'github-light', dark: 'github-dark' }} />
    </>
  );
}
