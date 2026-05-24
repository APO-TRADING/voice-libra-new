/**
 * MarqueeText — single-line text that auto-scrolls horizontally when it
 * overflows its container. Mimics the lockscreen / Spotify-style "ticker"
 * animation: the text pauses at its starting position, slides left until
 * the END is visible at the right edge, pauses again, then resets and
 * repeats.
 *
 * Usage:
 *   <MarqueeText style={{ fontSize: 16 }} numberOfLines={1}>
 *     Storia romana - Volume primo - Dalle origini alla Repubblica
 *   </MarqueeText>
 *
 * If the rendered text fits inside the container, the component renders
 * a plain <Text> with no animation — zero overhead for short names.
 *
 * Notes:
 *  - We measure container width via onLayout (one-shot) and text width via
 *    onTextLayout (also one-shot per content change).
 *  - The animation only starts AFTER both measurements arrive AND
 *    textWidth > containerWidth.
 *  - The driver is react-native-reanimated v4 — runs on the UI thread so
 *    JS-thread jank doesn't stutter the scroll.
 *  - Animation parameters are tuned for legibility, not raw speed: ~40 px/s
 *    sliding pace, 1.2s pauses at each end. Adjust SPEED_PX_PER_SEC and
 *    PAUSE_MS below if you want a faster/slower marquee.
 */
import React, { useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, TextProps, TextStyle, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, cancelAnimation } from 'react-native-reanimated';

type Props = TextProps & {
  children: string;
  style?: StyleProp<TextStyle>;
  /** Pixels per second the text slides. Default 40. */
  speed?: number;
  /** Pause at each end of the slide, in ms. Default 1200. */
  pauseMs?: number;
};

const DEFAULT_SPEED_PX_PER_SEC = 40;
const DEFAULT_PAUSE_MS = 1200;

export function MarqueeText({ children, style, speed = DEFAULT_SPEED_PX_PER_SEC, pauseMs = DEFAULT_PAUSE_MS, ...rest }: Props) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const translateX = useSharedValue(0);
  const lastChildrenRef = useRef(children);

  const onContainerLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w !== containerWidth) setContainerWidth(w);
  };

  // We use onTextLayout to read the natural width of the (un-clipped) text.
  // We render the measuring <Text> with no width constraint so it reports
  // its true content width.
  const onTextLayout = (e: any) => {
    const lines = e.nativeEvent.lines;
    if (lines && lines.length > 0) {
      // For a single-line marquee we only care about line 0's width.
      const w = lines[0].width;
      if (Math.abs(w - textWidth) > 1) setTextWidth(w);
    }
  };

  useEffect(() => {
    // Reset on content change so the marquee re-evaluates and restarts.
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
    // Slide duration is proportional to the actual overflow distance, so a
    // slightly-too-long name slides briefly and a very long one slides for
    // a longer time at the SAME comfortable px/s pace.
    const slideMs = Math.max(800, Math.round((overflowPx / speed) * 1000));
    // We add a tiny end margin (4 px) so the last letter doesn't sit
    // flush against the edge while paused.
    const endX = -(overflowPx + 4);
    translateX.value = 0;
    translateX.value = withRepeat(
      withSequence(
        // initial pause so the user can read the start of the name
        withTiming(0, { duration: pauseMs, easing: Easing.linear }),
        // slide to the end
        withTiming(endX, { duration: slideMs, easing: Easing.inOut(Easing.ease) }),
        // pause at the end so the user can read the tail
        withTiming(endX, { duration: pauseMs, easing: Easing.linear }),
        // snap back to start (instant)
        withTiming(0, { duration: 0, easing: Easing.linear }),
      ),
      -1, // repeat forever
      false,
    );
    // Cleanup if the component unmounts mid-animation.
    return () => { cancelAnimation(translateX); };
  }, [textWidth, containerWidth, speed, pauseMs, translateX]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  // Short text — no need to clip or animate. Render a plain ellipsis-aware
  // <Text> to keep the layout stable.
  const overflows = textWidth > 0 && containerWidth > 0 && textWidth > containerWidth;
  if (!overflows) {
    return (
      <View onLayout={onContainerLayout} style={styles.container}>
        <Text {...rest} numberOfLines={1} ellipsizeMode="tail" onTextLayout={onTextLayout} style={style}>
          {children}
        </Text>
      </View>
    );
  }

  return (
    <View onLayout={onContainerLayout} style={styles.container}>
      <Animated.View style={[styles.scrollerWrap, animatedStyle]}>
        <Text {...rest} numberOfLines={1} style={style} onTextLayout={onTextLayout}>
          {children}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', overflow: 'hidden' },
  scrollerWrap: { flexDirection: 'row' },
});

export default MarqueeText;
