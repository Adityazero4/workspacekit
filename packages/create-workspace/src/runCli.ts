import { parseArgs } from 'node:util';
import { createWorkspace, TEMPLATE_NAMES, type TemplateName } from './copyTemplate.ts';

const DEFAULT_DIRECTORY = 'my-workspace';

/**
 * The usage line printed with every CLI error and by `--help`.
 *
 * @example
 * process.stderr.write(USAGE);
 */
export const USAGE: string = `Usage: create-workspace [directory] [--template ${TEMPLATE_NAMES.join('|')}]`;

/**
 * What the build recorded about one `@scope/*` package.
 *
 * @example
 * const release: PackageRelease = { version: '1.0.0', private: false };
 */
export interface PackageRelease {
  version: string;
  private: boolean;
}

/**
 * Runs the command with the given arguments and returns the text to print.
 *
 * `loadReleases` supplies the versions the build embedded; the command refuses to generate a project
 * whose `@scope/*` dependencies are private or still at `0.0.0`.
 *
 * @example
 * const message = await runCli(['my-files', '--template', 'vite'], async () => ({}));
 */
export async function runCli(
  argv: string[],
  loadReleases: () => Promise<Record<string, PackageRelease>>,
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { template: { type: 'string', default: 'next' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return USAGE;
  const directory = positionals[0] ?? DEFAULT_DIRECTORY;
  const releases = await loadReleases();
  await createWorkspace({
    template: values.template as TemplateName,
    directory,
    versions: Object.fromEntries(Object.entries(releases).map(([name, { version }]) => [name, version])),
    privatePackages: Object.entries(releases)
      .filter(([, release]) => release.private)
      .map(([name]) => name),
  });
  return `Created ${directory}.\n\n  cd ${directory}\n  npm install\n  npm run dev`;
}
