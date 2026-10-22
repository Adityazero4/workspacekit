'use client';
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { useLatest } from '../useLatest';
import { stepZoom, useElementSize, ZOOM_TOLERANCE, zoomTowards } from '../zoom';

const DOUBLE_CLICK_ZOOM = 2;
const PAN_STEP_PX = 40;
const WHEEL_ZOOM_PER_PIXEL = 0.002;
const WHEEL_LINE_PX = 16;

/**
 * An image's size in CSS px at zoom 1.
 *
 * @example
 * ```ts
 * const size: ImageSize = { width: image.naturalWidth, height: image.naturalHeight };
 * ```
 */
export interface ImageSize {
  width: number;
  height: number;
}

/**
 * The elements `useZoomPan` works on: the scrolling surface, and the stage inside it that is sized to the
 * zoomed, rotated image.
 *
 * @example
 * ```ts
 * const elements: ZoomPanElements = { surface: useRef(null), stage: useRef(null) };
 * ```
 */
export interface ZoomPanElements {
  surface: RefObject<HTMLDivElement | null>;
  stage: RefObject<HTMLDivElement | null>;
}

/**
 * What `useZoomPan` returns: the stage's and image's computed geometry, the zoom state, the surface's
 * event handlers and the toolbar actions.
 *
 * @example
 * ```tsx
 * const zoomPan: ZoomPan = useZoomPan({ width: 800, height: 600 }, elements);
 * ```
 */
export interface ZoomPan {
  stageStyle: CSSProperties;
  imageStyle: CSSProperties;
  scale: number;
  isZoomed: boolean;
  isDragging: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  rotate: () => void;
  surfaceHandlers: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
    onDoubleClick: (event: MouseEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
}

type Zoom = number | 'fit';

interface ClientPoint {
  clientX: number;
  clientY: number;
}

interface Anchor extends ClientPoint {
  fractionX: number;
  fractionY: number;
}

interface Drag extends ClientPoint {
  pointerId: number;
  scrollLeft: number;
  scrollTop: number;
}

interface Pinch extends ClientPoint {
  scale: number;
}

type ZoomGesture = (target: number, at: ClientPoint) => void;

const rotatedSize = ({ width, height }: ImageSize, rotation: number): ImageSize =>
  rotation % 180 === 0 ? { width, height } : { width: height, height: width };

function fitScaleOf(content: ImageSize, viewport: ImageSize): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(1, viewport.width / content.width, viewport.height / content.height);
}

function anchorAt(stage: HTMLElement, { clientX, clientY }: ClientPoint): Anchor {
  const rect = stage.getBoundingClientRect();
  return {
    clientX,
    clientY,
    fractionX: (clientX - rect.left) / rect.width,
    fractionY: (clientY - rect.top) / rect.height,
  };
}

function centerOf(element: HTMLElement): ClientPoint {
  const rect = element.getBoundingClientRect();
  return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
}

function scrollToAnchor(surface: HTMLElement, stage: HTMLElement, anchor: Anchor): void {
  const rect = stage.getBoundingClientRect();
  surface.scrollLeft += rect.left - (anchor.clientX - anchor.fractionX * rect.width);
  surface.scrollTop += rect.top - (anchor.clientY - anchor.fractionY * rect.height);
}

function wheelPixels(event: WheelEvent): number {
  return event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
}

function pinchOf(event: Event): Pinch | undefined {
  if (!('scale' in event) || !('clientX' in event) || !('clientY' in event)) return undefined;
  const { scale, clientX, clientY } = event;
  const isPinch = typeof scale === 'number' && typeof clientX === 'number' && typeof clientY === 'number';
  return isPinch ? { scale, clientX, clientY } : undefined;
}

function usePinchAndModifiedWheelZoom(
  surface: RefObject<HTMLDivElement | null>,
  latestScale: RefObject<number>,
  zoomGesture: RefObject<ZoomGesture>,
): void {
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    let scaleAtPinchStart = latestScale.current;
    const zoomOnModifiedWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomGesture.current(latestScale.current * Math.exp(-wheelPixels(event) * WHEEL_ZOOM_PER_PIXEL), event);
    };
    const startPinch = (event: Event): void => {
      event.preventDefault();
      scaleAtPinchStart = latestScale.current;
    };
    const zoomOnPinch = (event: Event): void => {
      const pinch = pinchOf(event);
      if (!pinch) return;
      event.preventDefault();
      zoomGesture.current(scaleAtPinchStart * pinch.scale, pinch);
    };
    element.addEventListener('wheel', zoomOnModifiedWheel, { passive: false });
    element.addEventListener('gesturestart', startPinch);
    element.addEventListener('gesturechange', zoomOnPinch);
    return () => {
      element.removeEventListener('wheel', zoomOnModifiedWheel);
      element.removeEventListener('gesturestart', startPinch);
      element.removeEventListener('gesturechange', zoomOnPinch);
    };
  }, [surface, latestScale, zoomGesture]);
}

type DragHandlers = Pick<
  ZoomPan['surfaceHandlers'],
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'
>;

function useDragToPan(isZoomed: boolean): Pick<ZoomPan, 'isDragging'> & { handlers: DragHandlers } {
  const drag = useRef<Drag | undefined>(undefined);
  const [isDragging, setIsDragging] = useState(false);
  const endDrag = (event: PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setIsDragging(false);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (!isZoomed || event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const { pointerId, clientX, clientY } = event;
    const { scrollLeft, scrollTop } = element;
    drag.current = { pointerId, clientX, clientY, scrollLeft, scrollTop };
    setIsDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const started = drag.current;
    if (started?.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = started.scrollLeft - (event.clientX - started.clientX);
    event.currentTarget.scrollTop = started.scrollTop - (event.clientY - started.clientY);
  };
  return {
    isDragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
    },
  };
}

const ARROW_PAN: Record<string, ScrollToOptions> = {
  ArrowLeft: { left: -PAN_STEP_PX, top: 0 },
  ArrowRight: { left: PAN_STEP_PX, top: 0 },
  ArrowUp: { left: 0, top: -PAN_STEP_PX },
  ArrowDown: { left: 0, top: PAN_STEP_PX },
};

function keyAction(event: KeyboardEvent<HTMLElement>, zoomPan: ZoomPan): (() => void) | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const pan = ARROW_PAN[event.key];
  if (pan) {
    const element = event.currentTarget;
    return zoomPan.isZoomed ? () => element.scrollBy(pan) : undefined;
  }
  const actions: Record<string, (() => void) | undefined> = {
    '+': zoomPan.zoomIn,
    '=': zoomPan.zoomIn,
    '-': zoomPan.zoomOut,
    '0': zoomPan.fit,
    r: zoomPan.rotate,
    R: zoomPan.rotate,
  };
  return actions[event.key];
}

interface AnchoredZoom {
  zoom: Zoom;
  latestScale: RefObject<number>;
  zoomTo: (next: Zoom, at?: ClientPoint) => void;
  keepCenterThroughRotation: () => void;
}

function useAnchoredZoom(
  { surface, stage }: ZoomPanElements,
  fitScale: number,
  rotation: number,
): AnchoredZoom {
  const pendingAnchor = useRef<Anchor | undefined>(undefined);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const scale = zoom === 'fit' ? fitScale : zoom;
  const latestScale = useRef(scale);
  useLayoutEffect(() => {
    latestScale.current = scale;
    const anchor = pendingAnchor.current;
    pendingAnchor.current = undefined;
    if (anchor && surface.current && stage.current) scrollToAnchor(surface.current, stage.current, anchor);
  }, [scale, rotation, surface, stage]);
  const zoomTo = (next: Zoom, at?: ClientPoint): void => {
    if (!surface.current || !stage.current) return;
    pendingAnchor.current = anchorAt(stage.current, at ?? centerOf(surface.current));
    latestScale.current = next === 'fit' ? fitScale : next;
    setZoom(next);
  };
  const keepCenterThroughRotation = (): void => {
    if (!surface.current || !stage.current) return;
    const { fractionX, fractionY, ...center } = anchorAt(stage.current, centerOf(surface.current));
    pendingAnchor.current = { ...center, fractionX: 1 - fractionY, fractionY: fractionX };
  };
  return { zoom, latestScale, zoomTo, keepCenterThroughRotation };
}

/**
 * Zoom, rotation and panning for an image of `size`, shown on a scrolling `surface`. Zoom runs from 0.1 to
 * 8; `zoomIn` and `zoomOut` move to the next 0.25 step (never past the current zoom the wrong way, so a fit
 * below 0.1 does not grow on zoom out), `fit` (the start) shrinks the image to the surface and never
 * enlarges it. Ctrl or ⌘ with the wheel (a trackpad pinch), or a Safari pinch gesture, zooms at the
 * cursor; a plain wheel scrolls as usual. When zoomed in past fit, a pointer drag pans (with pointer
 * capture; `pointercancel` or a lost capture ends it) and the arrow keys pan 40 px. Double-click toggles
 * between fit and 2× at the cursor. Keys: `+` or `=`, `-`, `0` (fit) and `r` (rotate 90°). Zoom and
 * rotation survive a new `size`.
 *
 * @example
 * ```tsx
 * const zoomPan = useZoomPan({ width: 800, height: 600 }, { surface, stage });
 * <div ref={surface} {...zoomPan.surfaceHandlers}><div ref={stage} style={zoomPan.stageStyle} /></div>;
 * ```
 */
export function useZoomPan(size: ImageSize, elements: ZoomPanElements): ZoomPan {
  const { surface } = elements;
  const [rotation, setRotation] = useState(0);
  const content = rotatedSize(size, rotation);
  const fitScale = fitScaleOf(content, useElementSize(surface));
  const { zoom, latestScale, zoomTo, keepCenterThroughRotation } = useAnchoredZoom(
    elements,
    fitScale,
    rotation,
  );
  const scale = zoom === 'fit' ? fitScale : zoom;
  const isZoomed = scale > fitScale + ZOOM_TOLERANCE;
  const rotate = (): void => {
    keepCenterThroughRotation();
    setRotation((previous) => (previous + 90) % 360);
  };
  const zoomGesture = useLatest<ZoomGesture>((target, at) =>
    zoomTo(zoomTowards(latestScale.current, target), at),
  );
  usePinchAndModifiedWheelZoom(surface, latestScale, zoomGesture);
  const drag = useDragToPan(isZoomed);
  const zoomPan: ZoomPan = {
    stageStyle: { width: content.width * scale, height: content.height * scale },
    imageStyle: {
      width: size.width * scale,
      height: size.height * scale,
      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
    },
    scale,
    isZoomed,
    isDragging: drag.isDragging,
    zoomIn: () => zoomTo(stepZoom(scale, 'in')),
    zoomOut: () => zoomTo(stepZoom(scale, 'out')),
    fit: () => zoomTo('fit'),
    rotate,
    surfaceHandlers: {
      ...drag.handlers,
      onDoubleClick: (event) => zoomTo(isZoomed ? 'fit' : DOUBLE_CLICK_ZOOM, event),
      onKeyDown: (event) => {
        const action = keyAction(event, zoomPan);
        if (!action) return;
        event.preventDefault();
        action();
      },
    },
  };
  return zoomPan;
}
