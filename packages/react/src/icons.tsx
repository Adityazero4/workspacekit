import type { FC, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Svg(props: IconProps): React.JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

/**
 * Built-in 16px `currentColor` icons. All are `aria-hidden`.
 *
 * @example
 * ```tsx
 * <Icons.Folder className="my-icon" />
 * ```
 */
export const Icons: {
  Folder: FC<IconProps>;
  FolderOpen: FC<IconProps>;
  File: FC<IconProps>;
  Chevron: FC<IconProps>;
  Spinner: FC<IconProps>;
  Alert: FC<IconProps>;
  Dot: FC<IconProps>;
  More: FC<IconProps>;
  Close: FC<IconProps>;
  NewFile: FC<IconProps>;
  NewFolder: FC<IconProps>;
  Upload: FC<IconProps>;
  CollapseAll: FC<IconProps>;
  Sort: FC<IconProps>;
  Eye: FC<IconProps>;
  Follow: FC<IconProps>;
} = {
  Folder: (props) => (
    <Svg {...props}>
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
    </Svg>
  ),
  FolderOpen: (props) => (
    <Svg {...props}>
      <path d="M1.75 12.25v-8a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1v1.5M1.75 12.25l1.6-5h11.4l-1.6 5z" />
    </Svg>
  ),
  File: (props) => (
    <Svg {...props}>
      <path d="M4 1.75h5l3.25 3.25v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1zM9 1.75V5h3.25" />
    </Svg>
  ),
  Chevron: (props) => (
    <Svg {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  ),
  Spinner: (props) => (
    <Svg {...props}>
      <path d="M8 2a6 6 0 1 0 6 6" />
    </Svg>
  ),
  Alert: (props) => (
    <Svg {...props}>
      <path d="M8 2 14.5 13.5h-13zM8 6.5v3M8 11.5v.01" />
    </Svg>
  ),
  Dot: (props) => (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
    </Svg>
  ),
  More: (props) => (
    <Svg {...props}>
      <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.5} />
    </Svg>
  ),
  Close: (props) => (
    <Svg {...props}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Svg>
  ),
  NewFile: (props) => (
    <Svg {...props}>
      <path d="M9 14.25H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1h5l3.25 3.25V9M9 1.75V5h3.25M12.5 10.5v4M10.5 12.5h4" />
    </Svg>
  ),
  NewFolder: (props) => (
    <Svg {...props}>
      <path d="M8 12.75H2.75a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1V8.5M12.5 10.5v4M10.5 12.5h4" />
    </Svg>
  ),
  Upload: (props) => (
    <Svg {...props}>
      <path d="M8 10.5V2.5M4.75 5.75 8 2.5l3.25 3.25M2.5 10.5v2.25a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10.5" />
    </Svg>
  ),
  CollapseAll: (props) => (
    <Svg {...props}>
      <path d="M2.75 2.75h10.5v10.5H2.75zM5.5 8h5" />
    </Svg>
  ),
  Sort: (props) => (
    <Svg {...props}>
      <path d="M4.5 2.5v11M2.25 11.25 4.5 13.5l2.25-2.25M9 4h5M9 8h3.5M9 12h2" />
    </Svg>
  ),
  Eye: (props) => (
    <Svg {...props}>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  ),
  Follow: (props) => (
    <Svg {...props}>
      <circle cx="8" cy="8" r="4.75" />
      <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
    </Svg>
  ),
};
