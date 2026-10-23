import { PdfViewer, type PdfViewerProps } from '@scope/pdf';
import '@scope/react/styles.css';
import '@scope/pdf/styles.css';

/**
 * Props of `StandalonePdfExample`: `src` is a URL string, or the file's bytes or a `Blob`.
 *
 * @example
 * const fromUrl: StandalonePdfExampleProps = { src: '/files/report.pdf', fileName: 'report.pdf' };
 * const fromBytes: StandalonePdfExampleProps = { src: new Uint8Array(buffer), fileName: 'report.pdf' };
 */
export interface StandalonePdfExampleProps {
  src: PdfViewerProps['src'];
  fileName?: string;
}

/**
 * `PdfViewer` on its own: no provider, adapter or workspace. It needs a parent with a height, because the
 * pages scroll inside the viewer. A string `src` is handed to pdf.js as a URL: a root-relative path such
 * as `/files/report.pdf` resolves against the page's origin, and `http(s):` and `blob:` URLs work. Never
 * pass a URL from untrusted input without checking its scheme first. pdf.js loads the first time it
 * renders, so importing this stays cheap.
 *
 * @example
 * <StandalonePdfExample src="/files/report.pdf" fileName="report.pdf" />
 */
export function StandalonePdfExample({ src, fileName }: StandalonePdfExampleProps): React.JSX.Element {
  return (
    <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
      <PdfViewer src={src} fileName={fileName} />
    </div>
  );
}
