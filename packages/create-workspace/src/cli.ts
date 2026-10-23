import { readFile } from 'node:fs/promises';
import { runCli, USAGE, type PackageRelease } from './runCli.ts';

async function readEmbeddedReleases(): Promise<Record<string, PackageRelease>> {
  const file = new URL('../templates/versions.json', import.meta.url);
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, PackageRelease>;
}

runCli(process.argv.slice(2), readEmbeddedReleases).then(
  (message) => process.stdout.write(`${message}\n`),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exitCode = 1;
  },
);
