'use client';
import { useEffect, useRef, useState } from 'react';

const ANNOUNCEMENT_DELAY_MS = 300;

/**
 * Returns `text` for a live region once it has stopped changing for 300 ms, so a gesture that changes it
 * many times (a zoom, a scroll through pages) is announced once, at its end. Starts empty, so the first
 * value is not announced on mount.
 *
 * @example
 * ```tsx
 * <span role="status">{useSettledAnnouncement(`Page ${page} of ${pageCount}`)}</span>
 * ```
 */
export function useSettledAnnouncement(text: string): string {
  const [announcement, setAnnouncement] = useState('');
  const lastAnnounced = useRef(text);
  useEffect(() => {
    if (text === lastAnnounced.current) return;
    const timer = setTimeout(() => {
      lastAnnounced.current = text;
      setAnnouncement(text);
    }, ANNOUNCEMENT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return announcement;
}
