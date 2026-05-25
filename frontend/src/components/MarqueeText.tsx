/**
 * MarqueeText — single-line text that auto-scrolls horizontally when it
 * overflows its parent's width. Spotify-style ticker animation:
 *   start pause → slide to reveal the end → end pause → snap-back → repeat.
 *
 * v2.7.3 architecture (after measuring bug fixes):
 *   <View width=100%, overflow=hidden, onLayout=measureContainer>
 *     <Text style=measurer absolute, opacity=0, onLayout=measureText/>
 *     <Animated.View style={[width: textWidth, flexDirection: row, translate]}>
 *       <Text numberOfLines=1 ellipsizeMode=clip>{children}</Text>
 *     </Animated.View>
 *   </View>
 *
 * Why this layout works:
 *  - The OUTER <View> inherits its width from the parent flex layout (e.g.
 *    inside a FlatList row with siblings). `overflow:'hidden'` clips
 *    whatever sticks out the right edge.
 *  - The MEASURER <Text> is absolutely positioned so it's OUT of the flex
 *    flow — RN gives it effectively-infinite horizontal space, so its
 *    `onLayout` reports the TRUE rendered width of the content (the
 *    previous v2.7 version put the measuring Text inside an in-flow
 *    Animated.View, which inherited the parent's width constraint and
 *    therefore reported the post-truncation width — useless for the
 *    overflow check).
 *  - The VISIBLE <Animated.View> has an explicit `width: textWidth` so
 *    the inner Text has exactly the natural-width box it needs — no
 *    truncation, no wrap.
 *  - When textWidth ≤ containerWidth (short content), the Animated.View
 *    is narrower than the parent → no overflow, no animation needed.
 *  - When textWidth > containerWidth (long content), the Animated.View
 *    overflows; the outer View clips and the translateX animation slides
 *    the content left so the user can read the tail.
 *
 * Performance:
 *  - Reanimated v4 runs the translateX interpolation on the UI thread.
 *  - The measurer Text renders ONCE per content change. After that it
 *    re-measures only if the device font size / locale changes (RN
 *    re-fires onLayout in those cases).
 *  - The component returns a plain in-flow <Text> when textWidth has
 *    NOT YET been measured (first render), so the row keeps its proper
 *    height while the off-flow measurer settles.
 */
import React, { useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, TextProps, TextStyle, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

type Props = TextProps & {
  children: string;
  style?: StyleProp<TextStyle>;
  /** Pixels per second the text slides while scrolling. Default 40. */
  speed?: number;
  /** Pause at each end of the slide, in milliseconds. Default 1200. */
  pauseMs?: number;
};

const DEFAULT_SPEED_PX_PER_SEC = 40;
const DEFAULT_PAUSE_MS = 1200;

export function MarqueeText({
  children,
  style,
  speed = DEFAULT_SPEED_PX_PER_SEC,
  pauseMs = DEFAULT_PAUSE_MS,
  ...rest
}: Props) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const translateX = useSharedValue(0);
  const lastChildrenRef = useRef(children);

  const onContainerLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - containerWidth) > 0.5) setContainerWidth(w);
  };

  // The measurer <Text> lives in absolute-position land (no width constraint
  // from the parent), so onLayout reports the TRUE rendered width.
  const onMeasureLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - textWidth) > 0.5) setTextWidth(w);
  };

  // Reset when content changes so the new text re-measures and the
  // animation restarts from a clean state.
  useEffect(() => {
    if (lastChildrenRef.current !== children) {
      lastChildrenRef.current = children;
      cancelAnimation(translateX);
      translateX.value = 0;
      setTextWidth(0);
    }
  }, [children, translateX]);

  useEffect(() => {
    const overflowPx = textWidth - containerWidth;
    if (overflowPx <= 0 || containerWidth === 0 || textWidth === 0) {
      cancelAnimation(translateX);
      translateX.value = 0;
      return;
    }
    const slideMs = Math.max(800, Math.round((overflowPx / speed) * 1000));
    const endX = -(overflowPx + 4);
    translateX.value = 0;
    translateX.value = withRepeat(
      withSequence(
        withTiming(0, { duration: pauseMs, easing: Easing.linear }),
        withTiming(endX, { duration: slideMs, easing: Easing.inOut(Easing.ease) }),
        withTiming(endX, { duration: pauseMs, easing: Easing.linear }),
        withTiming(0, { duration: 0, easing: Easing.linear }),
      ),
      -1,
      false,
    );
    return () => { cancelAnimation(translateX); };
  }, [textWidth, containerWidth, speed, pauseMs, translateX]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const ready = textWidth > 0;
  const overflows = ready && containerWidth > 0 && textWidth > containerWidth;

  return (
    <View onLayout={onContainerLayout} style={styles.container}>
      {/* MEASURER — out of flow, opacity 0. Always present so we re-measure
          when the font/locale/dimensions change. The inline `style.width`
          override is critical: position:'absolute' alone isn't enough on
          some RN versions to fully escape the flex parent's intrinsic
          width hint. We pin top/left and let width grow with the content. */}
      <Text
        {...rest}
        style={[style, styles.measurer]}
        onLayout={onMeasureLayout}
      >
        {children}
      </Text>

      {/* DISPLAY — until we have a measurement, render a plain in-flow Text
          so the parent FlatList row gets its proper height. After
          measurement, switch to either a static Text (fits) or the
          marquee Animated.View (overflows). */}
      {!ready ? (
        // First render: in-flow Text gives the row its height.
        <Text {...rest} numberOfLines={1} ellipsizeMode="tail" style={style}>
          {children}
        </Text>
      ) : !overflows ? (
        // Static — fits.
        <Text {...rest} numberOfLines={1} ellipsizeMode="tail" style={style}>
          {children}
        </Text>
      ) : (
        // Marquee — overflows.
        <Animated.View style={[{ width: textWidth, flexDirection: 'row' }, animatedStyle]}>
          <Text {...rest} numberOfLines={1} ellipsizeMode="clip" style={style}>
            {children}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow:'hidden' clips the marquee when its content sticks past the
  // parent column's right edge (where the 3-dot menu and chevron live).
  container: { width: '100%', overflow: 'hidden' },
  // The measurer sits at the same baseline as the visible row but contributes
  // nothing to the layout (opacity 0, absolute position, no clipping width).
  measurer: {
    position: 'absolute',
    top: 0,
    left: 0,
    opacity: 0,
    // pointerEvents:'none' — the measurer should never intercept taps.
    // (We can't apply it on Text directly; the absolute positioning is
    // enough to keep it out of the way for hit-testing in this context.)
  },
});

export default MarqueeText;
