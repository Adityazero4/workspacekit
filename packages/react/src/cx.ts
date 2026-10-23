import type { ClassNames, Part } from './parts';

/**
 * Join truthy class names with a space. No de-duplication or Tailwind merging.
 *
 * @example
 * ```ts
 * cx('a', false, 'b'); // 'a b'
 * ```
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Props for an element that renders `part`: the `data-fs-part` attribute plus
 * the consumer's `classNames[part]` and an optional extra class. The part union
 * `P` comes from `classNames` (or an explicit type argument), never from `part`,
 * so a part outside the union is a type error.
 *
 * @example
 * ```tsx
 * <button {...partProps('tab', classNames, 'is-active')} />
 * ```
 */
export function partProps<P extends string = Part>(
  part: NoInfer<P>,
  classNames?: ClassNames<P>,
  extra?: string,
): { 'data-fs-part': P; className?: string } {
  const className = cx(classNames?.[part], extra);
  return className ? { 'data-fs-part': part, className } : { 'data-fs-part': part };
}
