'use client';
import { viewerError, type ViewerError } from '@scope/react/renderer-kit';
import { PasswordResponses } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useEffect, useEffectEvent, useState, type Dispatch, type SetStateAction } from 'react';
import {
  byteSizeOf,
  closeDocument,
  openDocument,
  pageSizeOf,
  type LoadedDocument,
  type OpenDocument,
  type PdfEngineOptions,
  type PdfFile,
} from './loadDocument';
import type { PageNavigation } from './linkService';
import type { PasswordRequest } from './PasswordPrompt';
import { PDF_MAX_BYTES } from './pdfRenderer';

/**
 * The document on screen: the loaded document and its page sizes, and the opened handle that tears it down.
 *
 * @example
 * ```ts
 * const pageCount = (shown: ShownDocument): number => shown.document.numPages;
 * ```
 */
export interface ShownDocument extends LoadedDocument {
  opened: OpenDocument;
}

/**
 * What `useShownDocument` reads from the view: the file and pdf.js options, and where errors go (with
 * whether pages of an earlier version are still shown).
 *
 * @example
 * ```ts
 * const source: DocumentSource = { file, options: {}, onError: (error) => console.error(error.message) };
 * ```
 */
export interface DocumentSource {
  file: PdfFile;
  options: PdfEngineOptions;
  onError: (error: ViewerError, isStillShowingPages: boolean) => void;
}

interface OwnedDocuments {
  add: (opened: OpenDocument) => void;
  close: (opened: OpenDocument) => void;
  closeAll: () => void;
}

function createOwnedDocuments(): OwnedDocuments {
  const owned = new Set<OpenDocument>();
  return {
    add: (opened) => void owned.add(opened),
    close: (opened) => {
      owned.delete(opened);
      closeDocument(opened);
    },
    closeAll: () => {
      for (const opened of owned) closeDocument(opened);
      owned.clear();
    },
  };
}

function useDocumentsClosedOnUnmount(): OwnedDocuments {
  const [documents] = useState(createOwnedDocuments);
  useEffect(() => documents.closeAll, [documents]);
  return documents;
}

interface LoadingEvents {
  loaded: (shown: ShownDocument) => void;
  passwordNeeded: (request: PasswordRequest) => void;
  failed: (error: ViewerError) => void;
}

function followLoading(opened: OpenDocument, documents: OwnedDocuments, events: LoadingEvents): () => void {
  let isWanted = true;
  let isSettled = false;
  const cancel = (): void => {
    isWanted = false;
    documents.close(opened);
    events.failed(viewerError('password_protected'));
  };
  opened.task.onPassword = (submit: (password: string) => void, reason: number) =>
    events.passwordNeeded({ isRetry: reason === PasswordResponses.INCORRECT_PASSWORD, submit, cancel });
  opened.loaded.then(
    (loaded) => {
      isSettled = true;
      if (isWanted) events.loaded({ ...loaded, opened });
    },
    (thrown: unknown) => {
      isSettled = true;
      documents.close(opened);
      if (isWanted) events.failed(viewerError('load_error', thrown));
    },
  );
  return () => {
    isWanted = false;
    if (!isSettled) documents.close(opened);
  };
}

function useOpenedDocument(
  file: PdfFile,
  openFile: (file: PdfFile) => OpenDocument,
  events: LoadingEvents,
): OwnedDocuments {
  const documents = useDocumentsClosedOnUnmount();
  const open = useEffectEvent(openFile);
  const onLoaded = useEffectEvent(events.loaded);
  const onPasswordNeeded = useEffectEvent(events.passwordNeeded);
  const onFailed = useEffectEvent(events.failed);
  useEffect(() => {
    if (byteSizeOf(file) > PDF_MAX_BYTES) {
      onFailed(viewerError('too_large'));
      return;
    }
    const opened = open(file);
    documents.add(opened);
    return followLoading(opened, documents, {
      loaded: onLoaded,
      passwordNeeded: onPasswordNeeded,
      failed: onFailed,
    });
  }, [file, documents]);
  return documents;
}

const ignoreClosedDocument = (): void => {};

function pageSizeLearner(
  shown: ShownDocument | undefined,
  setShown: Dispatch<SetStateAction<ShownDocument | undefined>>,
): (index: number) => void {
  return (index) => {
    if (!shown || shown.sizes.has(index)) return;
    shown.document.getPage(index + 1).then((page) => {
      setShown((current) =>
        current?.document === shown.document
          ? { ...current, sizes: new Map(current.sizes).set(index, pageSizeOf(page)) }
          : current,
      );
    }, ignoreClosedDocument);
  };
}

/**
 * The document a view shows, and the password request for the file being opened. A new `file` opens beside
 * the shown document and replaces it once loaded; the replaced one is then closed, and every document still
 * open is closed on unmount. `learnPageSize` reads a page's size when it comes near the viewport.
 *
 * @example
 * ```ts
 * const { shown, password, learnPageSize } = useShownDocument(props, navigation);
 * ```
 */
export function useShownDocument(
  source: DocumentSource,
  navigation: PageNavigation,
): {
  shown: ShownDocument | undefined;
  password: PasswordRequest | undefined;
  learnPageSize: (index: number) => void;
} {
  const { file } = source;
  const [shown, setShown] = useState<ShownDocument>();
  const [password, setPassword] = useState<PasswordRequest & { file: PdfFile }>();
  const documents = useOpenedDocument(file, (opening) => openDocument(opening, source.options, navigation), {
    loaded: (loaded) => {
      setShown(loaded);
      setPassword(undefined);
    },
    passwordNeeded: (request) => setPassword({ ...request, file }),
    failed: (error) => source.onError(error, shown !== undefined),
  });
  const shownOpened = shown?.opened;
  useEffect(() => {
    if (shownOpened) return () => documents.close(shownOpened);
  }, [shownOpened, documents]);
  return {
    shown,
    password: password?.file === file ? password : undefined,
    learnPageSize: pageSizeLearner(shown, setShown),
  };
}
