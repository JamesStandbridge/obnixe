import { useId, useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent, StyleProp, ViewProps, ViewStyle } from "react-native";
import Svg, { ClipPath, Defs, G, Path, Polygon, Rect } from "react-native-svg";
import { radii } from "@/ui/tokens";

export type BevelCorner = "topRight" | "bottomRight";

interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Band {
  readonly color: string;
  readonly height: number;
}

/** A rounded rectangle with one corner cut at 45 degrees, the angle of the logo. */
export function bevelPath(width: number, height: number, cut: number, radius: number, corner: BevelCorner): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const c = Math.max(0, Math.min(cut, width - r, height - r));
  const arc = (x: number, y: number): string => `A ${r} ${r} 0 0 1 ${x} ${y}`;
  switch (corner) {
    case "topRight":
      return [`M ${r} 0`, `H ${width - c}`, `L ${width} ${c}`, `V ${height - r}`, arc(width - r, height), `H ${r}`, arc(0, height - r), `V ${r}`, arc(r, 0), "Z"].join(" ");
    case "bottomRight":
      return [`M ${r} 0`, `H ${width - r}`, arc(width, r), `V ${height - c}`, `L ${width - c} ${height}`, `H ${r}`, arc(0, height - r), `V ${r}`, arc(r, 0), "Z"].join(" ");
    default: {
      const unreachable: never = corner;
      throw new Error(`Unhandled corner ${String(unreachable)}`);
    }
  }
}

interface BevelViewProps extends Omit<ViewProps, "style"> {
  readonly fill: string;
  readonly cut: number;
  readonly corner?: BevelCorner;
  readonly radius?: number;
  readonly stroke?: string;
  readonly band?: Band;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

export function BevelView({ fill, cut, corner = "topRight", radius = radii.panel, stroke, band, style, children, onLayout, ...rest }: BevelViewProps) {
  const clipId = `bevel${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [size, setSize] = useState<Size | null>(null);
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (size === null || size.width !== width || size.height !== height) setSize({ width, height });
    onLayout?.(event);
  };
  const shape = size === null ? "" : bevelPath(size.width, size.height, cut, radius, corner);
  return (
    <View {...rest} onLayout={measure} style={style}>
      {size === null ? null : (
        <Svg pointerEvents="none" width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
          {band === undefined ? (
            <Path d={shape} fill={fill} {...(stroke === undefined ? {} : { stroke, strokeWidth: 1.5 })} />
          ) : (
            <>
              <Defs>
                <ClipPath id={clipId}>
                  <Path d={shape} />
                </ClipPath>
              </Defs>
              <G clipPath={`url(#${clipId})`}>
                <Rect width={size.width} height={size.height} fill={fill} />
                <Rect width={size.width} height={band.height} fill={band.color} />
              </G>
            </>
          )}
        </Svg>
      )}
      {children}
    </View>
  );
}

interface SlashProps {
  readonly color: string;
  readonly width?: number;
  readonly height?: number;
}

/** The slanted tick that marks brand headings, cut at the logo's angle. */
export function Slash({ color, width = 12, height = 16 }: SlashProps) {
  const skew = height * 0.45;
  return (
    <Svg width={width} height={height} pointerEvents="none">
      <Polygon points={`${skew},0 ${width},0 ${width - skew},${height} 0,${height}`} fill={color} />
    </Svg>
  );
}
