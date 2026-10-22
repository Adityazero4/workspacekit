'use client';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import type { SaveStatusKind } from './autosaver';

/**
 * What the user can do about a conflict or a deletion.
 *
 * @example
 * ```ts
 * const choices: ConflictChoices = { keepMine, takeTheirs, saveCopy, recreate, discard };
 * ```
 */
export interface ConflictChoices {
  keepMine: () => void;
  takeTheirs: () => void;
  saveCopy: () => void;
  recreate: () => void;
  discard: () => void;
}

/**
 * Props of `ConflictBanner`.
 *
 * @example
 * ```tsx
 * const props: ConflictBannerProps = { status: 'conflict', fileName: 'notes.md', choices };
 * ```
 */
export interface ConflictBannerProps {
  status: SaveStatusKind;
  fileName: string;
  choices: ConflictChoices;
  classNames?: ClassNames;
}

interface Choice {
  label: string;
  choose: () => void;
}

function Banner(props: { message: string; choices: Choice[]; classNames?: ClassNames }): React.JSX.Element {
  const { message, choices, classNames } = props;
  return (
    <div role="alert" {...partProps('save-banner', classNames)}>
      <p {...partProps('save-banner-message', classNames)}>{message}</p>
      {choices.map((choice) => (
        <button
          key={choice.label}
          type="button"
          {...partProps('save-banner-button', classNames)}
          onClick={choice.choose}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The banner over an edited file that someone else changed or deleted, as a `role="alert"` (the
 * `save-banner` part). A conflict offers Keep mine, Take theirs and Save mine as a copy; a deletion offers
 * Save (which creates the file again) and Discard. Renders nothing for any other status.
 *
 * @example
 * ```tsx
 * <ConflictBanner status={status} fileName={entry.name} choices={choices} />
 * ```
 */
export function ConflictBanner(props: ConflictBannerProps): React.JSX.Element | null {
  const { status, fileName, choices, classNames } = props;
  if (status === 'conflict') {
    return (
      <Banner
        message={`"${fileName}" was changed by someone else while you were editing it.`}
        choices={[
          { label: 'Keep mine', choose: choices.keepMine },
          { label: 'Take theirs', choose: choices.takeTheirs },
          { label: 'Save mine as a copy', choose: choices.saveCopy },
        ]}
        classNames={classNames}
      />
    );
  }
  if (status === 'deleted') {
    return (
      <Banner
        message={`"${fileName}" was deleted. Your unsaved changes are still here.`}
        choices={[
          { label: 'Save', choose: choices.recreate },
          { label: 'Discard', choose: choices.discard },
        ]}
        classNames={classNames}
      />
    );
  }
  return null;
}
