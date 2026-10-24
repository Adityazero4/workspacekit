import { highlight } from 'fumadocs-core/highlight';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';

/**
 * A highlighted, copyable code block, rendered on the server so the landing page ships no highlighter.
 *
 * @example
 * ```tsx
 * <Code lang="ts" label="The server route" code={SERVER_SNIPPET} />
 * ```
 */
export async function Code(props: {
  code: string;
  lang: string;
  title?: string;
  label: string;
}): Promise<React.JSX.Element> {
  const rendered = await highlight(props.code, {
    lang: props.lang,
    themes: { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' },
    components: {
      pre: (pre) => (
        <CodeBlock title={props.title} className="my-0" viewportProps={{ 'aria-label': props.label }}>
          <Pre {...pre} />
        </CodeBlock>
      ),
    },
  });
  return <>{rendered}</>;
}
