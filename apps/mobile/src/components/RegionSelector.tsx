import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import type { NormalizedRect } from '@scansign/shared';
import { theme } from '../lib/theme';

const MIN_SIZE = 0.03;

/**
 * Drag a rectangle over the captured photo.
 *
 * The rectangle is reported in normalized 0..1 coordinates relative to the
 * photo, never in screen pixels — the backend crops the stored image with the
 * same fractions, so the selection means the same thing on any iPhone size.
 *
 * The photo the backend stores has already had its EXIF orientation baked in,
 * and this view renders that same image, so what the user frames is what gets
 * cropped.
 */
export const RegionSelector = ({
  photoUrl,
  photoWidth,
  photoHeight,
  onChange,
  value,
  tint = theme.color.brand,
}: {
  photoUrl: string;
  photoWidth: number;
  photoHeight: number;
  value: NormalizedRect | null;
  onChange: (rect: NormalizedRect | null) => void;
  tint?: string;
}) => {
  const { width: screenWidth } = useWindowDimensions();
  const boxWidth = screenWidth - 32;
  const boxHeight = Math.round((boxWidth * photoHeight) / photoWidth);

  const [preview, setPreview] = useState<NormalizedRect | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          origin.current = { x: clamp(locationX / boxWidth), y: clamp(locationY / boxHeight) };
          setPreview(null);
        },
        onPanResponderMove: (event, gesture) => {
          if (!origin.current) return;
          const current = {
            x: clamp(origin.current.x + gesture.dx / boxWidth),
            y: clamp(origin.current.y + gesture.dy / boxHeight),
          };
          setPreview({
            x: Math.min(origin.current.x, current.x),
            y: Math.min(origin.current.y, current.y),
            width: Math.abs(current.x - origin.current.x),
            height: Math.abs(current.y - origin.current.y),
          });
        },
        onPanResponderRelease: () => {
          setPreview((rect) => {
            // A tap should clear the selection rather than leave a sliver behind.
            if (rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) onChange(rect);
            else onChange(null);
            return null;
          });
          origin.current = null;
        },
      }),
    [boxWidth, boxHeight, onChange],
  );

  const shown = preview ?? value;

  return (
    <View style={[styles.container, { width: boxWidth, height: boxHeight }]}>
      <Image
        source={{ uri: photoUrl }}
        style={StyleSheet.absoluteFill}
        contentFit="fill"
        transition={120}
      />
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
        {shown && shown.width > 0 && (
          <View
            pointerEvents="none"
            style={[
              styles.selection,
              {
                borderColor: tint,
                backgroundColor: `${tint}22`,
                left: shown.x * boxWidth,
                top: shown.y * boxHeight,
                width: shown.width * boxWidth,
                height: shown.height * boxHeight,
              },
            ]}
          />
        )}
      </View>
      {!shown && (
        <View pointerEvents="none" style={styles.hint}>
          <Text style={styles.hintText}>Tracez un cadre avec le doigt</Text>
        </View>
      )}
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
  selection: { position: 'absolute', borderWidth: 2, borderRadius: 4 },
  hint: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(19,29,51,0.75)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  hintText: { color: '#fff', fontSize: 13, fontWeight: '500' },
});
