/**
 * MarqueeText — single-line text that auto-scrolls horizontally when it
 * overflows its parent's width.
 *
 * v2.7.6 architecture (Android-aware fix after EAS-build report):
 *   The previous attempt (v2.7.5) put the measurer inside a 9999-wide
 *   absolute wrapper and trusted React Native not to truncate. On real
 *   Android hardware, however, the measurer <Text> was STILL reporting
 *   a width close to the visible row width (≈ 200-260 px) instead of
 *   the true natural width (≈ 380-450 px), so the marquee logic kept
 *   concluding "fits, skip animation" even for clearly overflowing
 *   folder names.
 *
 *   Root causes found:
 *     1) The measurer <Text> did not explicitly nullify
 *        `numberOfLines` / `ellipsizeMode`. Even when the parent
 *        component doesn't pass these props, certain release builds /
 *        Android Text drawables apply a default 1-line truncation when
 *        a parent layout reports a constrained width DURING the same
 *        layout pass that the absolute wrapper is being placed in.
 *        Defensive explicit `numberOfLines={undefined}
 *        ellipsizeMode={undefined}` (AFTER {...rest}) closes that door.
 *
 *     2) The 9999-wide measurer wrapper was a `flexDirection:'column'
 *        alignItems:'stretch'` View, which means the child Text was
 *        being stretched to 9999 wide. On Android the TextView
 *        sometimes resolves its `onLayout` width from the laid-out
 *        view rather than the content. Adding
 *        `flexDirection:'row' alignItems:'flex-start'` to the wrapper
 *        and `alignSelf:'flex-start'` to the Text shrink-wraps it to
 *        its content so `onLayout` reports the *content* width.
 *
 *     3) Parents (e.g. folder rows) didn't always give the Marquee a
 *        clean `overflow:'hidden'` boundary, so the flex sibling could
 *        widen past its container for a tick, making the Marquee
 *        conclude "fits". Now folder rows wrap the Marquee in a
 *        `{ flex:1, minWidth:0, overflow:'hidden' }` View so the
 *        container width is always the real visible width.
 *
 *   Final layout pattern:
 *     <View width=100%, overflow=hidden, onLayout=measureContainer>
 *       <View pointerEvents=none, position=absolute, width=9999,
 *             flexDirection=row, alignItems=flex-start, opacity=0>
 *         <Text alignSelf=flex-start, numberOfLines=undefined,
 *               ellipsizeMode=undefined, onLayout=measureText>
 *           {children}                                  ← measurer
 *         </Text>
 *       </View>
 *
 *       {when ready & overflows:}
 *         <Animated.View width=textWidth, flexDirection=row>
 *           <Text numberOfLines=undefined, ellipsizeMode=undefined>
 *             {children}                                ← marquee
 *           </Text>
 *         </Animated.View>
 *       {when ready & fits:}
 *         <Text numberOfLines=1, ellipsizeMode=tail>... ← static
 *       {while measuring:}
 *         <Text numberOfLines=1, ellipsizeMode=tail>... ← placeholder
 *     </View>
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
const MEASURER_WIDTH = 9999;

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

  const onMeasureLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - textWidth) > 0.5) setTextWidth(w);
  };

  // Reset when the content changes so the new text re-measures fresh.
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
    // 8 px end-margin so the trailing glyph doesn't sit flush against the
    // clipped edge during the end-pause.
    const endX = -(overflowPx + 8);
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
      {/* MEASURER — out of flow, in a 9999-px-wide wrapper so the inner
          <Text> sees no truncation constraint and its onLayout reports
          the true natural width.
          v2.7.6: CRITICAL on Android — we explicitly null out
          `numberOfLines` and `ellipsizeMode` AFTER {...rest} so that
          any parent-passed prop or platform default cannot silently
          truncate the measurer string and report a too-small width
          (which is the symptom the user observed in the EAS build:
          marquee never triggered because measurer == container width).
          alignSelf:'flex-start' lets the Text size to its content
          width even though the wrapper is 9999 wide. */}
      <View pointerEvents="none" style={styles.measurerWrap}>
        <Text
          {...rest}
          style={[style, styles.measurerText]}
          onLayout={onMeasureLayout}
          numberOfLines={undefined}
          ellipsizeMode={undefined}
          allowFontScaling={false}
        >
          {children}
        </Text>
      </View>

      {/* DISPLAY — three states: pre-measurement (placeholder height),
          measured-and-fits (static text), measured-and-overflows (marquee). */}
      {!ready ? (
        <Text {...rest} numberOfLines={1} ellipsizeMode="tail" style={style}>
          {children}
        </Text>
      ) : !overflows ? (
        <Text {...rest} numberOfLines={1} ellipsizeMode="tail" style={style}>
          {children}
        </Text>
      ) : (
        <Animated.View style={[{ width: textWidth, flexDirection: 'row' }, animatedStyle]}>
          {/* v2.7.6: ditto here — the Animated.View has exact textWidth,
              so we must NOT cap to numberOfLines=1 (Android would still
              measure ellipsis layout passes that visually clip glyphs). */}
          <Text
            {...rest}
            numberOfLines={undefined}
            ellipsizeMode={undefined}
            style={style}
            allowFontScaling={false}
          >
            {children}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Outer row container — width comes from the parent flex layout, the
  // overflow:hidden clips the marquee animation past the right edge.
  container: { width: '100%', overflow: 'hidden' },
  // Measurer wrapper — explicit 9999 width is what gives the inner <Text>
  // unbounded horizontal room so it renders at its natural size and
  // onLayout reports the real number.
  // v2.7.6: alignItems:'flex-start' on Android stops the wrapper from
  // stretching the Text to fill the 9999-wide row; combined with
  // alignSelf:'flex-start' on the Text itself, this guarantees that
  // onLayout reports the *content* width and not the wrapper width.
  measurerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: MEASURER_WIDTH,
    opacity: 0,
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  measurerText: {
    alignSelf: 'flex-start',
  },
});

export default MarqueeText;
