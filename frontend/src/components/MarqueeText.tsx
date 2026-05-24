/**
 * MarqueeText — single-line text that auto-scrolls horizontally when it
 * overflows its container. Spotify-style ticker animation: text pauses
 * at the start, slides left to reveal the end, pauses, then snaps back
 * and repeats.
 *
 * v2.7.1 architecture (after the v2.7 bug fix):
 *   <View width=100%, overflow=hidden, onLayout=measureContainer>
 *     <Animated.View flexDirection=row, style=translateX>
 *       <Text numberOfLines=1, ellipsizeMode=clip, onLayout=measureText>
 *         {children}
 *       </Text>
 *     </Animated.View>
 *   </View>
 *
 * Key insight (the bug we fixed):
 *   When the inner <Text> sits inside a parent that has NO width constraint
 *   (the Animated.View is sized by its content, not by its parent), React
 *   Native gives the Text effectively-infinite horizontal space, so
 *   `numberOfLines={1}` does NOT truncate and `onLayout` reports the
 *   text's TRUE rendered width. The previous version put the Text inside
 *   a width-constrained View, which meant the Text was always truncated
 *   to fit and `onTextLayout` reported the (post-ellipsis) width — so
 *   we never detected an overflow and never started the animation.
 *
 *   The OUTER <View> still has the parent's allotted width (e.g. flex:1
 *   inside a FlatList row) and `overflow: 'hidden'` clips whatever sticks
 *   out the right edge. Result: long names visibly scroll, short names
 *   render as static text with zero animation cost.
 *
 * Usage:
 *   <MarqueeText style={{ fontSize: 16 }}>Some very long folder name…</MarqueeText>
 */
import React, { useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, TextProps, TextStyle, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, cancelAnimation } from 'react-native-reanimated';

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
    if (w !== containerWidth) setContainerWidth(w);
  };

  // The <Text> sits in a parent with no width constraint, so this layout
  // event reports the natural rendered width of the text.
  const onTextLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - textWidth) > 0.5) setTextWidth(w);
  };

  // Reset when the content changes so we re-measure and restart cleanly.
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
    // Slide duration scales with the actual overflow distance so a slightly-
    // too-long name slides briefly and a very long one slides longer, all
    // at the same comfortable px/s pace.
    const slideMs = Math.max(800, Math.round((overflowPx / speed) * 1000));
    // A 4-pixel end margin keeps the last glyph from sitting flush against
    // the right edge while paused.
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

  return (
    <View onLayout={onContainerLayout} style={styles.container}>
      <Animated.View style={[styles.scroller, animatedStyle]}>
        <Text
          {...rest}
          numberOfLines={1}
          ellipsizeMode="clip"
          onLayout={onTextLayout}
          style={style}
        >
          {children}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow:'hidden' is what makes the long text get clipped at the edge
  // of its parent column instead of pushing the trailing icons (3-dot
  // menu, chevron) off the row.
  container: { width: '100%', overflow: 'hidden' },
  // No width constraint here so the <Text> can size itself naturally and
  // onLayout reports its true rendered width.
  scroller: { flexDirection: 'row' },
});

export default MarqueeText;
