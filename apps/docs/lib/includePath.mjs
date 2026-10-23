import { realpathSync } from 'node:fs';
import path from 'node:path';

const EMBEDDABLE_FOLDER = 'examples';

/**
 * The language of each file extension that `Include` may embed.
 *
 * @example
 * INCLUDE_LANGUAGES['.tsx']; // 'tsx'
 */
export const INCLUDE_LANGUAGES = { '.ts': 'ts', '.tsx': 'tsx', '.css': 'css' };

function hasPlainShape(file) {
  const segments = file.split('/');
  return (
    !file.includes('\\') &&
    segments.length > 1 &&
    segments[0] === EMBEDDABLE_FOLDER &&
    segments.every((segment) => segment !== '' && !segment.startsWith('.'))
  );
}

/**
 * Says why `Include` must refuse `file`, or returns `null` when it may embed it: a plain repository-relative
 * path to an existing `.ts`, `.tsx` or `.css` file whose real path is inside `examples/`.
 *
 * @example
 * includeRefusal(process.cwd(), '../../.env'); // 'only plain paths under examples/ are embedded'
 */
export function includeRefusal(repositoryRoot, file) {
  if (!hasPlainShape(file)) {
    return 'only plain paths under examples/ are embedded (no dot segments or backslashes)';
  }
  if (!(path.extname(file) in INCLUDE_LANGUAGES)) return 'only .ts, .tsx and .css files are embedded';
  try {
    const examplesRoot = realpathSync(path.join(repositoryRoot, EMBEDDABLE_FOLDER));
    const real = realpathSync(path.join(repositoryRoot, file));
    return real.startsWith(examplesRoot + path.sep) ? null : 'the file is not inside examples/';
  } catch {
    return 'the file does not exist under examples/';
  }
}

/**
 * Resolves `file` to the real path to read, or throws when `Include` must refuse it. Every place that reads
 * a file named by an `<Include>` tag goes through this check.
 *
 * @example
 * const absolute = await resolveIncludePath(process.cwd(), 'examples/recipes/src/theming.css');
 */
export async function resolveIncludePath(repositoryRoot, file) {
  const refusal = includeRefusal(repositoryRoot, file);
  if (refusal !== null) throw new Error(`Include refuses "${file}": ${refusal}.`);
  return realpathSync(path.join(repositoryRoot, file));
}
