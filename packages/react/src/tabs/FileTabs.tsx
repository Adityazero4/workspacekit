'use client';
import { basename, remapPrefix, type Entry } from '@workspacekit/core';
import { docsLink } from '@workspacekit/core/docs';
import {
  createContext,
  memo,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Components } from '../components';
import { partProps } from '../cx';
import { DefaultDialog } from '../dialogs/Dialog';
import type { EditBufferState } from '../editing/editBuffer';
import { Icons } from '../icons';
import type { ClassNames } from '../parts';
import {
  failureMessage,
  useEntryState,
  useFileSystem,
  useUiValue,
  type FileSystemContext,
} from '../provider/hooks';
import { internalsOf } from '../provider/internals';
import { horizontalRovingIndex } from '../rovingIndex';
import { focusIsInsideOrNowhere } from '../tree/rovingFocus';
import {
  activateTab,
  closeTab,
  isDeletedFromTree,
  NO_TABS,
  pinTab,
  remapTabs,
  type Tab,
  type TabsHolder,
  type TabsState,
} from './tabs-store';
import { closeTabsOfDeletedFiles } from './followTree';

/**
 * Props of `FileTabs`.
 *
 * @example
 * ```tsx
 * const props: FileTabsProps = { tabs, onTabsChange: setTabs, renderLabel: (tab) => tab.path };
 * ```
 */
export interface FileTabsProps {
  /** Class of the root element (the `tabs` part, the tab list, which scrolls horizontally). */
  className?: string;
  classNames?: ClassNames;
  /** Default `'Open files'`. */
  'aria-label'?: string;
  /** Makes the strip controlled: it renders these tabs and reports every change through `onTabsChange`. */
  tabs?: TabsState;
  /** The next state after a change, in controlled mode only (see `FileTabs`). */
  onTabsChange?: (state: TabsState) => void;
  /**
   * Replaces the label (the file name); `entry` is missing until the file's folder is loaded, or once it is
   * deleted.
   */
  renderLabel?: (tab: Tab, entry?: Entry) => ReactNode;
  /** Replaces the default (Radix) dialog that confirms closing a tab with unsaved changes. */
  components?: Pick<Components, 'Dialog'>;
  /**
   * For a `role="tabpanel"` rendered per tab: the tab element gets `tabId` as its id (for the panel's
   * `aria-labelledby`) and `aria-controls` set to `panelId`.
   */
  tabPanelIds?: (path: string) => TabPanelIds;
}

/**
 * The element ids that link a tab to its panel.
 *
 * @example
 * ```ts
 * const ids: TabPanelIds = { tabId: 'files-tab-1', panelId: 'files-panel-1' };
 * ```
 */
export interface TabPanelIds {
  tabId: string;
  panelId: string;
}

interface ControlledTabs extends TabsHolder {
  sync: (tabs: TabsState | undefined, onTabsChange: ((state: TabsState) => void) | undefined) => void;
}

function createControlledTabs(): ControlledTabs {
  let latest: TabsState = NO_TABS;
  let report: ((state: TabsState) => void) | undefined;
  return {
    get: () => latest,
    set: (update) => {
      const next = update(latest);
      if (next === latest) return;
      latest = next;
      report?.(next);
    },
    sync: (tabs, onTabsChange) => {
      latest = tabs ?? NO_TABS;
      report = onTabsChange;
    },
  };
}

function useControlledTabsFollowingTheTree(fs: FileSystemContext, controlled: TabsHolder | null): void {
  const { store, root } = fs;
  const { followedMoves } = internalsOf(fs);
  useEffect(() => {
    if (!controlled) return undefined;
    const stopClosing = closeTabsOfDeletedFiles(store, root, controlled, followedMoves);
    const stopRemapping = store.onMove((from, to) => controlled.set((state) => remapTabs(state, from, to)));
    return () => {
      stopClosing();
      stopRemapping();
    };
  }, [store, root, followedMoves, controlled]);
}

function useConfirmingClose(fs: FileSystemContext): [string | null, (path: string | null) => void] {
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null);
  const { store } = fs;
  const isAsking = confirmingClose !== null;
  useEffect(() => {
    if (!isAsking) return undefined;
    return store.onMove((from, to) =>
      setConfirmingClose((path) => (path === null ? null : remapPrefix(path, from, to))),
    );
  }, [store, isAsking]);
  return [confirmingClose, setConfirmingClose];
}

const tabElementsIn = (strip: HTMLElement | null): HTMLElement[] =>
  strip ? [...strip.querySelectorAll<HTMLElement>('[role="tab"]')] : [];

function scrollIntoStrip(strip: HTMLElement, tab: HTMLElement): void {
  const stripBox = strip.getBoundingClientRect();
  const tabBox = tab.getBoundingClientRect();
  if (tabBox.left < stripBox.left) strip.scrollLeft -= stripBox.left - tabBox.left;
  else if (tabBox.right > stripBox.right) strip.scrollLeft += tabBox.right - stripBox.right;
}

function focusWithinStrip(strip: HTMLElement | null, tab: HTMLElement | undefined): void {
  if (!strip || !tab) return;
  tab.focus({ preventScroll: true });
  scrollIntoStrip(strip, tab);
}

function focusTheTabStop(strip: HTMLElement | null, evenIfFocusIsElsewhere: boolean): void {
  if (!evenIfFocusIsElsewhere && !focusIsInsideOrNowhere(strip)) return;
  focusWithinStrip(strip, strip?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]') ?? undefined);
}

function useFocusTheTabStopAfterRender(
  strip: RefObject<HTMLElement | null>,
): (evenIfFocusIsElsewhere: boolean) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (evenIfFocusIsElsewhere) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => focusTheTabStop(strip.current, evenIfFocusIsElsewhere));
  };
}

function useActiveTabScrolledIntoStrip(strip: RefObject<HTMLElement | null>, active: string | null): void {
  useLayoutEffect(() => {
    const element = strip.current;
    const activeTab = element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (element && activeTab) scrollIntoStrip(element, activeTab);
  }, [strip, active]);
}

const MIDDLE_BUTTON = 1;

const keepFocusWhereItIs = (event: MouseEvent): void => event.preventDefault();
const preventMiddleClickAutoscroll = (event: MouseEvent): void => {
  if (event.button === MIDDLE_BUTTON) event.preventDefault();
};

interface FileTabShared {
  classNames?: ClassNames;
  renderLabel?: FileTabsProps['renderLabel'];
  tabPanelIds?: FileTabsProps['tabPanelIds'];
  activate: (path: string) => void;
  pin: (path: string) => void;
  requestClose: (path: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, path: string) => void;
  noteFocus: (path: string) => void;
}

const FileTabContext = createContext<FileTabShared | null>(null);

function useFileTabShared(): FileTabShared {
  const shared = use(FileTabContext);
  if (!shared) {
    throw new Error(
      'A tab was rendered outside <FileTabs>. Render tabs only through <FileTabs>, which provides the state they ' +
        `share. See ${docsLink('concepts/adapter', 'tree-rows-and-tabs')}`,
    );
  }
  return shared;
}

function useIsDeleted(path: string): boolean {
  const { store, root } = useFileSystem();
  const read = (): boolean => isDeletedFromTree(store.getSnapshot(), path, root);
  return useSyncExternalStore(store.subscribe, read, read);
}

function describeTab(tab: Tab, changed: boolean, deleted: boolean): string {
  const states = [
    tab.preview && 'preview',
    tab.dirty && 'unsaved changes',
    changed && 'changed',
    deleted && 'deleted',
  ].filter(Boolean);
  const description = states.join(', ');
  return description.charAt(0).toUpperCase() + description.slice(1);
}

const marker = (on: boolean): '' | undefined => (on ? '' : undefined);

const linkToPanel = (ids: TabPanelIds | undefined): { id?: string; 'aria-controls'?: string } =>
  ids ? { id: ids.tabId, 'aria-controls': ids.panelId } : {};

interface FileTabViewProps {
  tab: Tab;
  isActive: boolean;
  isTabStop: boolean;
}

const FileTab = memo(function FileTab(props: FileTabViewProps) {
  const { tab, isActive, isTabStop } = props;
  const { path } = tab;
  const shared = useFileTabShared();
  const { classNames } = shared;
  const { entry, changed } = useEntryState(path);
  const deleted = useIsDeleted(path);
  const labelId = useId();
  const descriptionId = useId();
  const name = entry?.name ?? basename(path);
  const description = describeTab(tab, changed, deleted);
  return (
    <div
      role="tab"
      {...linkToPanel(shared.tabPanelIds?.(path))}
      aria-selected={isActive}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      aria-keyshortcuts="Delete"
      tabIndex={isTabStop ? 0 : -1}
      title={path}
      {...partProps('tab', classNames)}
      data-selected={marker(isActive)}
      data-preview={marker(tab.preview)}
      data-dirty={marker(tab.dirty)}
      data-changed={marker(changed)}
      data-deleted={marker(deleted)}
      onClick={() => shared.activate(path)}
      onDoubleClick={() => shared.pin(path)}
      onMouseDown={preventMiddleClickAutoscroll}
      onAuxClick={(event) => {
        if (event.button === MIDDLE_BUTTON) shared.requestClose(path);
      }}
      onKeyDown={(event) => shared.onKeyDown(event, path)}
      onFocus={() => shared.noteFocus(path)}
    >
      <span id={labelId} {...partProps('tab-label', classNames)}>
        {shared.renderLabel ? shared.renderLabel(tab, entry) : name}
      </span>
      <span
        aria-hidden="true"
        title={`Close ${name}`}
        {...partProps('tab-close', classNames)}
        onMouseDown={keepFocusWhereItIs}
        onClick={(event) => {
          event.stopPropagation();
          shared.requestClose(path);
        }}
      >
        {tab.dirty ? <Icons.Dot /> : <Icons.Close />}
      </span>
      {description && (
        <span id={descriptionId} hidden>
          {description}
        </span>
      )}
    </div>
  );
});

function useControlledOrProviderTabs(
  fs: FileSystemContext,
  tabs: TabsState | undefined,
  onTabsChange: ((state: TabsState) => void) | undefined,
): { holder: TabsHolder; state: TabsState } {
  const providerState = useUiValue(fs.tabs);
  const [controlledTabs] = useState(createControlledTabs);
  useLayoutEffect(() => controlledTabs.sync(tabs, onTabsChange));
  const isControlled = tabs !== undefined;
  useControlledTabsFollowingTheTree(fs, isControlled ? controlledTabs : null);
  return { holder: isControlled ? controlledTabs : fs.tabs, state: tabs ?? providerState };
}

type CloseAnswer = 'save' | 'discard' | 'cancel';

interface TabClosing {
  confirmingClose: string | null;
  saving: boolean;
  saveFailure: string | null;
  requestClose: (path: string) => void;
  answer: (answer: CloseAnswer) => void;
}

function whyItWasNotSaved(path: string, buffer: EditBufferState | undefined): string {
  const failure = `Couldn't save "${basename(path)}"`;
  if (buffer?.status === 'conflict') return `${failure}: someone else changed it. Open it to pick a version.`;
  if (buffer?.status === 'deleted') return `${failure}: it was deleted. Open it to save it again.`;
  return buffer?.error ? failureMessage(failure, buffer.error) : `${failure}. Try again.`;
}

function useTabClosingThatConfirmsUnsavedChanges(
  fs: FileSystemContext,
  holder: TabsHolder,
  strip: RefObject<HTMLElement | null>,
  onCancel: (path: string | null) => void,
): TabClosing {
  const [confirmingClose, setConfirmingClose] = useConfirmingClose(fs);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { editBuffers } = internalsOf(fs);
  const focusTheTabStopAfterRender = useFocusTheTabStopAfterRender(strip);
  const close = (path: string, focusEvenIfElsewhere: boolean): void => {
    setConfirmingClose(null);
    setSaveFailure(null);
    holder.set((current) => closeTab(current, path));
    focusTheTabStopAfterRender(focusEvenIfElsewhere);
  };
  const saveThenClose = async (path: string): Promise<void> => {
    setSaving(true);
    await editBuffers.flush(path);
    setSaving(false);
    if (editBuffers.isDirty(path)) {
      setSaveFailure(whyItWasNotSaved(path, editBuffers.get(path)));
      return;
    }
    editBuffers.discard(path);
    close(path, true);
  };
  return {
    confirmingClose,
    saving,
    saveFailure,
    requestClose: (path) => {
      if (holder.get().tabs.find((tab) => tab.path === path)?.dirty) setConfirmingClose(path);
      else close(path, false);
    },
    answer: (answer) => {
      const path = confirmingClose;
      if (saving) return;
      if (path === null || answer === 'cancel') {
        onCancel(path);
        setConfirmingClose(null);
        setSaveFailure(null);
        focusTheTabStopAfterRender(true);
      } else if (answer === 'discard') {
        editBuffers.discard(path);
        close(path, true);
      } else void saveThenClose(path);
    },
  };
}

function runTabKey(
  event: KeyboardEvent<HTMLElement>,
  strip: HTMLElement | null,
  path: string,
  commands: { activate: (path: string) => void; requestClose: (path: string) => void },
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const elements = tabElementsIn(strip);
  const current = elements.indexOf(event.currentTarget);
  const target = horizontalRovingIndex(event.key, current, elements.length);
  if (target !== undefined) focusWithinStrip(strip, elements[target]);
  else if (event.key === 'Enter' || event.key === ' ') commands.activate(path);
  else if (event.key === 'Delete' || event.key === 'Backspace') commands.requestClose(path);
  else return false;
  return true;
}

function ConfirmCloseUnsavedTab(props: {
  path: string;
  saving: boolean;
  saveFailure: string | null;
  Dialog: NonNullable<Components['Dialog']>;
  classNames?: ClassNames;
  onAnswer: (answer: CloseAnswer) => void;
}): React.JSX.Element {
  const { path, saving, saveFailure, Dialog, classNames, onAnswer } = props;
  return (
    <Dialog
      role="alertdialog"
      title={`Close "${basename(path)}"?`}
      description="It has unsaved changes."
      classNames={classNames}
      onClose={() => onAnswer('cancel')}
    >
      {saveFailure && (
        <p role="alert" {...partProps('dialog-message', classNames)}>
          {saveFailure}
        </p>
      )}
      <div {...partProps('dialog-actions', classNames)} aria-busy={saving || undefined}>
        <button
          type="button"
          {...partProps('dialog-button', classNames)}
          aria-disabled={saving || undefined}
          onClick={() => onAnswer('cancel')}
        >
          Cancel
        </button>
        <button
          type="button"
          {...partProps('dialog-button-danger', classNames)}
          aria-disabled={saving || undefined}
          onClick={() => onAnswer('discard')}
        >
          Discard
        </button>
        <button
          type="button"
          {...partProps('dialog-button', classNames)}
          aria-disabled={saving || undefined}
          onClick={() => onAnswer('save')}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * The open-file tab strip: a WAI-ARIA tab list over the provider's tabs (see `useTabs`), or over `tabs` when
 * controlled. Preview tabs are marked `data-preview` (italic), dirty ones `data-dirty` (a dot instead of the
 * close cross), the active one `data-selected`, files changed by someone else `data-changed`, and a dirty tab
 * whose file was deleted `data-deleted` (it stays open so its changes are not lost; a clean one closes). Each
 * tab re-renders only when its own tab, active or focus state, or its entry, changes.
 *
 * Keyboard: the strip is one tab stop, and tabbing into it lands on the active tab. Left and Right move focus
 * (wrapping), Home and End go to the ends, Enter or Space activates the focused tab (manual activation, so
 * arrowing past files never opens them), and Delete or Backspace closes it. A click activates a tab, a double
 * click pins a preview tab, and a middle click or the close icon closes one. The close icon is for the mouse
 * only (hidden from assistive technology and never focused): keyboard and screen reader users close the
 * focused tab with Delete. Closing a dirty tab asks first, in the `Dialog` slot: Save (saves the file's
 * edit buffer, then closes; while it saves the buttons are `aria-disabled` and Save reads "Saving…"; if
 * the save fails the tab stays open and the dialog says why), Discard (drops
 * the edits and closes) or Cancel; focus then returns to the strip. The active tab is scrolled into view
 * within the strip only, never the page. The strip renders no tab panel: render the viewer for the active
 * path, or a `role="tabpanel"` per tab linked with `tabPanelIds`.
 *
 * Controlled mode: with `tabs`, the strip renders those tabs and never touches the provider's state, so
 * `useTabs()` keeps returning the provider's (uncontrolled) tabs. Every change the strip makes is reported
 * through `onTabsChange` as the next state: user actions, and the tree following the files (every committed
 * rename or move remaps the paths, a deletion closes clean tabs, except while a `followMove` involving them
 * is in flight). Each change builds on the last state reported, until the next render brings new `tabs`.
 * Without `tabs`, the strip shows the provider's tabs and `onTabsChange` is not called.
 *
 * @example
 * ```tsx
 * const tabs = useTabs();
 * <FileTree onOpenFile={(entry, how) => tabs.open(entry.path, how)} />
 * <FileTabs />
 * {tabs.active && <Viewer path={tabs.active} />}
 * ```
 */
export function FileTabs(props: FileTabsProps): React.JSX.Element {
  const { className, classNames, renderLabel, components, tabPanelIds } = props;
  const fs = useFileSystem();
  const { holder, state } = useControlledOrProviderTabs(fs, props.tabs, props.onTabsChange);
  const strip = useRef<HTMLDivElement>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const closing = useTabClosingThatConfirmsUnsavedChanges(fs, holder, strip, setFocusedPath);
  useActiveTabScrolledIntoStrip(strip, state.active);

  const tabStop = state.tabs.some((tab) => tab.path === focusedPath)
    ? focusedPath
    : (state.active ?? state.tabs[0]?.path ?? null);
  const activate = (path: string): void => holder.set((current) => activateTab(current, path));
  const shared: FileTabShared = {
    classNames,
    renderLabel,
    tabPanelIds,
    activate,
    pin: (path) => holder.set((current) => pinTab(current, path)),
    requestClose: closing.requestClose,
    noteFocus: setFocusedPath,
    onKeyDown: (event, path) => {
      if (runTabKey(event, strip.current, path, { activate, requestClose: closing.requestClose })) {
        event.preventDefault();
      }
    },
  };

  return (
    <FileTabContext value={shared}>
      <div
        ref={strip}
        role="tablist"
        aria-label={props['aria-label'] ?? 'Open files'}
        {...partProps('tabs', classNames, className)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedPath(null);
        }}
      >
        {state.tabs.map((tab) => (
          <FileTab
            key={tab.path}
            tab={tab}
            isActive={tab.path === state.active}
            isTabStop={tab.path === tabStop}
          />
        ))}
      </div>
      {closing.confirmingClose !== null && (
        <ConfirmCloseUnsavedTab
          path={closing.confirmingClose}
          saving={closing.saving}
          saveFailure={closing.saveFailure}
          Dialog={components?.Dialog ?? DefaultDialog}
          classNames={classNames}
          onAnswer={closing.answer}
        />
      )}
    </FileTabContext>
  );
}
