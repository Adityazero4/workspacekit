import babel from '@rolldown/plugin-babel';
import { fileURLToPath } from 'node:url';

const coreSource = (file: string): string => fileURLToPath(new URL(`../core/src/${file}`, import.meta.url));

export const testAgainstWorkspaceSourcesWithoutABuild: {
  alias: Array<{ find: RegExp; replacement: string }>;
} = {
  alias: [
    { find: /^@scope\/core\/(http|memory)$/, replacement: coreSource('$1/index.ts') },
    { find: /^@scope\/core$/, replacement: coreSource('index.ts') },
  ],
};

export const compileReactSourcesLikeTheBuild = (): ReturnType<typeof babel> =>
  babel({
    include: [/[\\/]packages[\\/]react[\\/]src[\\/].*\.tsx?$/],
    plugins: [['babel-plugin-react-compiler', { target: '19' }]],
  });
