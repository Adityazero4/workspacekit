'use client';
import { partProps } from '@workspacekit/react/renderer-kit';
import { useEffect, useId, useRef, type FormEvent } from 'react';
import type { PdfClassNames } from './parts';

/**
 * One request from pdf.js for a password: whether the last one was wrong, where to send the next one, and
 * how to give up. pdf.js makes a new request for each attempt.
 *
 * @example
 * ```ts
 * const request: PasswordRequest = { isRetry: false, submit: (password) => update(password), cancel };
 * ```
 */
export interface PasswordRequest {
  isRetry: boolean;
  submit: (password: string) => void;
  cancel: () => void;
}

/**
 * Props of `PasswordPrompt`: the file's `name`, the current `request`, and the package's class names.
 *
 * @example
 * ```tsx
 * const props: PasswordPromptProps = { name: 'a.pdf', request, classNames };
 * ```
 */
export interface PasswordPromptProps {
  name: string;
  request: PasswordRequest;
  classNames: PdfClassNames | undefined;
}

/**
 * Asks for the password of an encrypted PDF: a form with a labelled password input, Submit and Cancel. The
 * input takes focus for every request. After a wrong password the input is cleared, marked invalid, and
 * described by an "Incorrect password" alert.
 *
 * @example
 * ```tsx
 * <PasswordPrompt name="a.pdf" request={request} classNames={classNames} />
 * ```
 */
export function PasswordPrompt(props: PasswordPromptProps): React.JSX.Element {
  const { name, request, classNames } = props;
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  useEffect(() => input.current?.focus(), [request]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = new FormData(form).get('password');
    request.submit(typeof password === 'string' ? password : '');
    form.reset();
  };
  return (
    <form {...partProps('pdf-password', classNames)} onSubmit={submit}>
      <label {...partProps('pdf-password-label', classNames)} htmlFor={inputId}>
        Password for {name}
      </label>
      <input
        {...partProps('pdf-password-input', classNames)}
        ref={input}
        id={inputId}
        name="password"
        type="password"
        autoComplete="off"
        aria-invalid={request.isRetry || undefined}
        aria-describedby={request.isRetry ? errorId : undefined}
      />
      {request.isRetry && (
        <p {...partProps('pdf-password-error', classNames)} id={errorId} role="alert">
          Incorrect password
        </p>
      )}
      <button {...partProps('pdf-button', classNames)} type="submit">
        Submit
      </button>
      <button {...partProps('pdf-button', classNames)} type="button" onClick={request.cancel}>
        Cancel
      </button>
    </form>
  );
}
