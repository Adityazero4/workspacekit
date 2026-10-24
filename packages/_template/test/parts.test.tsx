import {
  StandaloneRoot,
  StaleNotice,
  viewerError,
  type StandaloneRootProps,
} from '@workspacekit/react/renderer-kit';
import { expect, expectTypeOf, test } from 'vitest';
import TemplateText from '../src/TemplateText';
import { TEMPLATE_PARTS, type TemplateClassNames, type TemplatePart } from '../src';

// `pnpm typecheck` checks this file: each `@ts-expect-error` fails the typecheck if the line compiles.
const classNames: TemplateClassNames = { 'template-viewer': 'root' };
const viewer = { classNames };
const loading = { status: 'loading' } as const;

test('the kit components take this package part names', () => {
  expectTypeOf<StandaloneRootProps<TemplatePart>['part']>().toEqualTypeOf<TemplatePart>();
  const root = (
    <StandaloneRoot part="template-viewer" errorPart="template-error" state={loading} viewer={viewer} />
  );
  const notice = <StaleNotice<TemplatePart> error={viewerError('load_error')} part="template-error" />;
  expect([root.props.part, notice.props.part]).toEqual(['template-viewer', 'template-error']);
  expect(TEMPLATE_PARTS).toContain(root.props.part);
});

test('a part outside the package union is a type error', () => {
  const rootWithForeignPart = (): React.JSX.Element =>
    StandaloneRoot({
      // @ts-expect-error -- 'pdf-viewer' is not a template part; the part union comes from viewer.classNames
      part: 'pdf-viewer',
      errorPart: 'template-error',
      state: loading,
      viewer,
    });
  const noticeWithUnknownPart = (): React.JSX.Element =>
    StaleNotice<TemplatePart>({
      error: viewerError('load_error'),
      // @ts-expect-error -- 'template-bogus' is not a template part
      part: 'template-bogus',
    });
  // @ts-expect-error -- classNames keys are limited to the package parts
  const wrongKey: TemplateClassNames = { 'tree-row': 'x' };
  expect([rootWithForeignPart, noticeWithUnknownPart, wrongKey]).toHaveLength(3);
});

test('TemplateText marks its part and merges the consumer class', () => {
  const pre = TemplateText({ text: 'hi', classNames: { 'template-text': 'mine' } });
  expect(pre.props).toMatchObject({ 'data-fs-part': 'template-text', className: 'mine', children: 'hi' });
});
