import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { Image } from 'expo-image';
import {
  moveNormalizedRect,
  resizeNormalizedRect,
  type NormalizedRect,
  type RectCorner,
} from '@scansign/shared';
import { theme } from '../lib/theme';

/**
 * Frame a region of the captured photo.
 *
 * Everything is kept in normalized 0..1 coordinates relative to the photo, so
 * the selection means the same thing to the server as it does on screen, on any
 * iPhone size. The photo shown here has already had its EXIF orientation baked
 * in by the backend, so what the user frames is exactly what gets cropped.
 *
 * IMPORTANT — the PanResponder is created exactly once.
 * PanResponder.create() owns a private gestureState that is seeded by the grant
 * event. If the responder object is rebuilt mid-gesture (which happens as soon
 * as it is memoised on values that change during a drag, or on an inline
 * callback prop), the replacement never saw the grant, so its dx/dy stay 0 and
 * the box silently refuses to move. Everything the handlers need therefore
 * lives in refs, and the responder is built one time in a ref of its own.
 */

/** Visible size of a corner marker. */
const HANDLE_SIZE = 24;
/** Touch radius around a corner — a fingertip is ~44pt, the marker is 24. */
const HANDLE_HIT = 46;

export interface RegionSelectorProps {
  photoUrl: string;
  photoWidth: number;
  photoHeight: number;
  value: NormalizedRect | null;
  onChange: (rect: NormalizedRect) => void;
  /** Lets the parent freeze its ScrollView while a drag is in progress. */
  onInteractionChange?: (active: boolean) => void;
  tint?: string;
  /** Seeds the first box when `value` is null. */
  defaultRect?: NormalizedRect;
}

type Mode = 'move' | 'draw' | RectCorner;

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

export const RegionSelector = ({
  photoUrl,
  photoWidth,
  photoHeight,
  value,
  onChange,
  onInteractionChange,
  tint = theme.color.brand,
  defaultRect = { x: 0.15, y: 0.3, width: 0.7, height: 0.4 },
}: RegionSelectorProps) => {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // Fit the photo inside the available area without distortion. Constraining
  // the height matters for portrait captures, which would otherwise run off the
  // bottom of the screen and put the lower handles out of reach.
  const { boxWidth, boxHeight } = useMemo(() => {
    const maxWidth = screenWidth - 32;
    const maxHeight = screenHeight * 0.44;
    const scale = Math.min(maxWidth / photoWidth, maxHeight / photoHeight);
    return {
      boxWidth: Math.round(photoWidth * scale),
      boxHeight: Math.round(photoHeight * scale),
    };
  }, [screenWidth, screenHeight, photoWidth, photoHeight]);

  const [rect, setRect] = useState<NormalizedRect>(value ?? defaultRect);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);

  // --- everything the gesture handlers read, held in refs -------------------
  const rectRef = useRef(rect);
  const surfaceRef = useRef({ width: boxWidth, height: boxHeight });
  const startRef = useRef<{ rect: NormalizedRect; mode: Mode; x: number; y: number } | null>(null);
  const onChangeRef = useRef(onChange);
  const onInteractionRef = useRef(onInteractionChange);
  const draggingRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
    onInteractionRef.current = onInteractionChange;
  });

  useEffect(() => {
    surfaceRef.current = { width: boxWidth, height: boxHeight };
  }, [boxWidth, boxHeight]);

  const apply = useCallback((next: NormalizedRect) => {
    rectRef.current = next;
    setRect(next);
    onChangeRef.current(next);
  }, []);

  // Adopt a selection supplied by the parent — a restored step, or a region the
  // backend suggested. Ignored mid-drag so it cannot fight the finger.
  useEffect(() => {
    if (!value || draggingRef.current) return;
    const r = rectRef.current;
    if (
      Math.abs(r.x - value.x) < 1e-6 &&
      Math.abs(r.y - value.y) < 1e-6 &&
      Math.abs(r.width - value.width) < 1e-6 &&
      Math.abs(r.height - value.height) < 1e-6
    ) {
      return;
    }
    rectRef.current = value;
    setRect(value);
  }, [value]);

  // Publish the seeded box once, so the "Continuer" button is live immediately.
  useEffect(() => {
    if (!value) onChangeRef.current(rectRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) surfaceRef.current = { width, height };
  };

  // --- the one and only PanResponder ---------------------------------------
  const responder = useRef(
    PanResponder.create({
      // Claim the gesture in the capture phase, before the parent ScrollView
      // can read it as a scroll.
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,

      onPanResponderGrant: (event) => {
        const surface = surfaceRef.current;
        if (surface.width <= 0 || surface.height <= 0) return;

        const { locationX, locationY } = event.nativeEvent;
        const current = rectRef.current;
        const point = { x: locationX / surface.width, y: locationY / surface.height };

        const corners: Array<{ mode: RectCorner; x: number; y: number }> = [
          { mode: 'nw', x: current.x, y: current.y },
          { mode: 'ne', x: current.x + current.width, y: current.y },
          { mode: 'sw', x: current.x, y: current.y + current.height },
          { mode: 'se', x: current.x + current.width, y: current.y + current.height },
        ];

        let picked: Mode = 'draw';
        let closest = Number.POSITIVE_INFINITY;
        for (const corner of corners) {
          const distance = Math.hypot(
            (point.x - corner.x) * surface.width,
            (point.y - corner.y) * surface.height,
          );
          if (distance < HANDLE_HIT && distance < closest) {
            closest = distance;
            picked = corner.mode;
          }
        }

        if (picked === 'draw') {
          const inside =
            point.x >= current.x &&
            point.x <= current.x + current.width &&
            point.y >= current.y &&
            point.y <= current.y + current.height;
          if (inside) picked = 'move';
        }

        startRef.current = { rect: current, mode: picked, x: point.x, y: point.y };
        draggingRef.current = true;
        setDragging(true);
        setMode(picked);
        onInteractionRef.current?.(true);
      },

      onPanResponderMove: (_event, gesture) => {
        const start = startRef.current;
        const surface = surfaceRef.current;
        if (!start || surface.width <= 0 || surface.height <= 0) return;

        const dx = gesture.dx / surface.width;
        const dy = gesture.dy / surface.height;
        const minWidth = Math.max(HANDLE_SIZE * 2, 60) / surface.width;
        const minHeight = Math.max(HANDLE_SIZE * 2, 60) / surface.height;
        const base = start.rect;

        let next: NormalizedRect;
        if (start.mode === 'move') {
          next = moveNormalizedRect(base, dx, dy);
        } else if (start.mode === 'draw') {
          const cx = clamp01(start.x + dx);
          const cy = clamp01(start.y + dy);
          const x = Math.min(start.x, cx);
          const y = Math.min(start.y, cy);
          next = {
            x,
            y,
            width: Math.min(Math.max(Math.abs(cx - start.x), minWidth), 1 - x),
            height: Math.min(Math.max(Math.abs(cy - start.y), minHeight), 1 - y),
          };
        } else {
          // Opposite corner pinned, minimum size enforced, never inverted.
          // Unit-tested in @scansign/shared.
          next = resizeNormalizedRect(base, start.mode, dx, dy, minWidth, minHeight);
        }

        apply(next);
      },

      onPanResponderRelease: () => {
        startRef.current = null;
        draggingRef.current = false;
        setDragging(false);
        setMode(null);
        onInteractionRef.current?.(false);
      },
      onPanResponderTerminate: () => {
        startRef.current = null;
        draggingRef.current = false;
        setDragging(false);
        setMode(null);
        onInteractionRef.current?.(false);
      },
    }),
  ).current;

  const surface = { width: boxWidth, height: boxHeight };
  const left = rect.x * surface.width;
  const top = rect.y * surface.height;
  const width = rect.width * surface.width;
  const height = rect.height * surface.height;

  // Live crop preview: the finger sits on top of the mark being framed, so the
  // result has to be shown somewhere else.
  const previewWidth = Math.min(screenWidth - 32, 250);
  const imageWidth = previewWidth / Math.max(rect.width, 0.001);
  const imageHeight = imageWidth * (photoHeight / photoWidth);
  const previewHeight = Math.max(48, Math.round(rect.height * imageHeight));

  const corners: Array<{ mode: RectCorner; style: object }> = [
    { mode: 'nw', style: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 } },
    { mode: 'ne', style: { right: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 } },
    { mode: 'sw', style: { left: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 } },
    { mode: 'se', style: { right: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 } },
  ];

  return (
    <View>
      <View
        onLayout={onLayout}
        style={[styles.container, { width: boxWidth, height: boxHeight }]}
        {...responder.panHandlers}
      >
        <Image
          source={{ uri: photoUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="fill"
          transition={120}
        />

        {/* Dim everything outside the selection. */}
        <View pointerEvents="none" style={[styles.shade, { left: 0, top: 0, right: 0, height: top }]} />
        <View
          pointerEvents="none"
          style={[styles.shade, { left: 0, top: top + height, right: 0, bottom: 0 }]}
        />
        <View pointerEvents="none" style={[styles.shade, { left: 0, top, width: left, height }]} />
        <View
          pointerEvents="none"
          style={[styles.shade, { left: left + width, top, right: 0, height }]}
        />

        <View
          pointerEvents="none"
          style={[
            styles.selection,
            { left, top, width, height, borderColor: tint },
            dragging && styles.selectionActive,
          ]}
        >
          <View style={[styles.gridLine, { left: '33.33%', top: 0, bottom: 0, width: 1 }]} />
          <View style={[styles.gridLine, { left: '66.66%', top: 0, bottom: 0, width: 1 }]} />
          <View style={[styles.gridLine, { top: '33.33%', left: 0, right: 0, height: 1 }]} />
          <View style={[styles.gridLine, { top: '66.66%', left: 0, right: 0, height: 1 }]} />

          {corners.map((corner) => (
            <View
              key={corner.mode}
              style={[
                styles.handle,
                { backgroundColor: tint },
                corner.style,
                mode === corner.mode && styles.handleActive,
              ]}
            />
          ))}
        </View>

        {!dragging && (
          <View pointerEvents="none" style={styles.hint}>
            <Text style={styles.hintText}>Glissez le cadre · tirez les coins</Text>
          </View>
        )}
      </View>

      <View style={styles.previewRow}>
        <Text style={styles.previewLabel}>Aperçu de la découpe</Text>
        <View
          style={[
            styles.previewBox,
            { width: previewWidth, height: previewHeight, borderColor: tint },
          ]}
        >
          <Image
            source={{ uri: photoUrl }}
            style={{
              position: 'absolute',
              width: imageWidth,
              height: imageHeight,
              left: -rect.x * imageWidth,
              top: -rect.y * imageHeight,
            }}
            contentFit="fill"
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignSelf: 'center',
  },
  shade: { position: 'absolute', backgroundColor: 'rgba(10,16,30,0.55)' },
  selection: { position: 'absolute', borderWidth: 2, borderRadius: 2 },
  selectionActive: { borderWidth: 3 },
  gridLine: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.35)' },
  handle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: HANDLE_SIZE / 2,
    borderWidth: 3,
    borderColor: '#fff',
  },
  handleActive: { transform: [{ scale: 1.3 }] },
  hint: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    backgroundColor: 'rgba(19,29,51,0.8)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  hintText: { color: '#fff', fontSize: 12.5, fontWeight: '500' },
  previewRow: { marginTop: 14, alignItems: 'center', gap: 8 },
  previewLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.color.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  previewBox: {
    borderRadius: theme.radius.sm,
    borderWidth: 2,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
});
