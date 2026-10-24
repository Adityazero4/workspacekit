import babel from '@rolldown/plugin-babel';
import { fileURLToPath } from 'node:url';

const workspaceSource = (file: string): string => fileURLToPath(new URL(`../${file}`, import.meta.url));

export const testAgainstWorkspaceSourcesWithoutABuild: {
  alias: Array<{ find: RegExp; replacement: string }>;
} = {
  alias: [
    { find: /^@workspacekit\/core\/memory$/, replacement: workspaceSource('core/src/memory/index.ts') },
    { find: /^@workspacekit\/core$/, replacement: workspaceSource('core/src/index.ts') },
    { find: /^@workspacekit\/react\/styles\.css$/, replacement: workspaceSource('react/src/styles.css') },
    {
      find: /^@workspacekit\/react\/(renderers|renderer-kit)$/,
      replacement: workspaceSource('react/src/$1/index.ts'),
    },
    { find: /^@workspacekit\/react$/, replacement: workspaceSource('react/src/index.ts') },
  ],
};

export const compileReactSourcesLikeTheBuild = (): ReturnType<typeof babel> =>
  babel({
    include: [/[\\/]packages[\\/](react|code)[\\/]src[\\/].*\.tsx?$/],
    plugins: [['babel-plugin-react-compiler', { target: '19' }]],
  });

export const oneSharedCodeMirrorInstance: string[] = [
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/language-data',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/highlight',
];
