import babel from '@rolldown/plugin-babel';
import { fileURLToPath } from 'node:url';

const workspaceSource = (file: string): string => fileURLToPath(new URL(`../${file}`, import.meta.url));

const RENDERER_PACKAGES = ['code', 'docx', 'markdown', 'pdf', 'pptx', 'spreadsheet'];

export const testAgainstWorkspaceSourcesWithoutABuild: {
  alias: Array<{ find: RegExp; replacement: string }>;
} = {
  alias: [
    { find: /^@workspacekit\/core\/memory$/, replacement: workspaceSource('core/src/memory/index.ts') },
    { find: /^@workspacekit\/core\/http$/, replacement: workspaceSource('core/src/http/index.ts') },
    { find: /^@workspacekit\/core\/docs$/, replacement: workspaceSource('core/src/docs/index.ts') },
    { find: /^@workspacekit\/core$/, replacement: workspaceSource('core/src/index.ts') },
    { find: /^@workspacekit\/react\/styles\.css$/, replacement: workspaceSource('react/src/styles.css') },
    {
      find: /^@workspacekit\/react\/(renderers|renderer-kit)$/,
      replacement: workspaceSource('react/src/$1/index.ts'),
    },
    { find: /^@workspacekit\/react$/, replacement: workspaceSource('react/src/index.ts') },
    {
      find: new RegExp(`^@workspacekit/(${RENDERER_PACKAGES.join('|')})/styles\\.css$`),
      replacement: workspaceSource('$1/src/styles.css'),
    },
    {
      find: new RegExp(`^@workspacekit/(${RENDERER_PACKAGES.join('|')})$`),
      replacement: workspaceSource('$1/src/index.ts'),
    },
    {
      find: /^@workspacekit\/workspace\/styles\.css$/,
      replacement: workspaceSource('workspace/src/styles.css'),
    },
    { find: /^@workspacekit\/workspace$/, replacement: workspaceSource('workspace/src/index.ts') },
  ],
};

export const compileReactSourcesLikeTheBuild = (): ReturnType<typeof babel> =>
  babel({
    include: [
      /[\\/]packages[\\/](react|code|docx|markdown|pdf|pptx|spreadsheet|workspace)[\\/]src[\\/].*\.tsx?$/,
    ],
    plugins: [['babel-plugin-react-compiler', { target: '19' }]],
  });

export const spreadsheetWorkerDependencies: string[] = [
  'fast-formula-parser',
  'numfmt',
  'papaparse',
  'saxes',
].map((dependency) => `@workspacekit/spreadsheet > ${dependency}`);
