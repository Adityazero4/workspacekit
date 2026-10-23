import babel from '@rolldown/plugin-babel';
import { fileURLToPath } from 'node:url';

const workspaceSource = (file: string): string => fileURLToPath(new URL(`../${file}`, import.meta.url));

export const testAgainstWorkspaceSourcesWithoutABuild: {
  alias: Array<{ find: RegExp; replacement: string }>;
} = {
  alias: [
    { find: /^@scope\/core\/memory$/, replacement: workspaceSource('core/src/memory/index.ts') },
    { find: /^@scope\/core$/, replacement: workspaceSource('core/src/index.ts') },
    { find: /^@scope\/react\/styles\.css$/, replacement: workspaceSource('react/src/styles.css') },
    {
      find: /^@scope\/react\/(renderers|renderer-kit)$/,
      replacement: workspaceSource('react/src/$1/index.ts'),
    },
    { find: /^@scope\/react$/, replacement: workspaceSource('react/src/index.ts') },
  ],
};

export const compileReactSourcesLikeTheBuild = (): ReturnType<typeof babel> =>
  babel({
    include: [/[\\/]packages[\\/](react|docx)[\\/]src[\\/].*\.tsx?$/],
    plugins: [['babel-plugin-react-compiler', { target: '19' }]],
  });
