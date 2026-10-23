import babel from '@rolldown/plugin-babel';
import { fileURLToPath } from 'node:url';

const workspaceSource = (file: string): string => fileURLToPath(new URL(`../${file}`, import.meta.url));

const RENDERER_PACKAGES = ['code', 'docx', 'markdown', 'pdf', 'pptx', 'spreadsheet'];

export const testAgainstWorkspaceSourcesWithoutABuild: {
  alias: Array<{ find: RegExp; replacement: string }>;
} = {
  alias: [
    { find: /^@scope\/core\/memory$/, replacement: workspaceSource('core/src/memory/index.ts') },
    { find: /^@scope\/core\/http$/, replacement: workspaceSource('core/src/http/index.ts') },
    { find: /^@scope\/core$/, replacement: workspaceSource('core/src/index.ts') },
    { find: /^@scope\/react\/styles\.css$/, replacement: workspaceSource('react/src/styles.css') },
    {
      find: /^@scope\/react\/(renderers|renderer-kit)$/,
      replacement: workspaceSource('react/src/$1/index.ts'),
    },
    { find: /^@scope\/react$/, replacement: workspaceSource('react/src/index.ts') },
    {
      find: new RegExp(`^@scope/(${RENDERER_PACKAGES.join('|')})/styles\\.css$`),
      replacement: workspaceSource('$1/src/styles.css'),
    },
    {
      find: new RegExp(`^@scope/(${RENDERER_PACKAGES.join('|')})$`),
      replacement: workspaceSource('$1/src/index.ts'),
    },
    { find: /^@scope\/workspace\/styles\.css$/, replacement: workspaceSource('workspace/src/styles.css') },
    { find: /^@scope\/workspace$/, replacement: workspaceSource('workspace/src/index.ts') },
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
].map((dependency) => `@scope/spreadsheet > ${dependency}`);
