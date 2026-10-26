import type { ReactElement } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTheme } from "@/ui/theme";

interface Glyph {
  readonly viewBox: number;
  readonly render: (color: string) => ReactElement;
}

const stroke = (color: string, width: number) => ({
  fill: "none",
  stroke: color,
  strokeWidth: width,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

const glyphs = {
  back: { viewBox: 22, render: (color) => <Path d="M13.5 5 7.5 11l6 6" {...stroke(color, 1.8)} /> },
  forward: { viewBox: 22, render: (color) => <Path d="m8.5 5 6 6-6 6" {...stroke(color, 1.8)} /> },
  chevron: { viewBox: 16, render: (color) => <Path d="m6 4 4 4-4 4" {...stroke(color, 1.8)} /> },
  expand: { viewBox: 16, render: (color) => <Path d="m4 6 4 4 4-4" {...stroke(color, 1.8)} /> },
  collapse: { viewBox: 16, render: (color) => <Path d="m4 10 4-4 4 4" {...stroke(color, 1.8)} /> },
  check: { viewBox: 20, render: (color) => <Path d="m4 10.5 4 4 8-9" {...stroke(color, 2.2)} /> },
  close: { viewBox: 22, render: (color) => <Path d="m6 6 10 10M16 6 6 16" {...stroke(color, 1.8)} /> },
  plus: { viewBox: 22, render: (color) => <Path d="M11 5v12M5 11h12" {...stroke(color, 1.8)} /> },
  reorder: { viewBox: 18, render: (color) => <Path d="M3.5 6h11M3.5 9h11M3.5 12h11" {...stroke(color, 1.7)} /> },
  backspace: {
    viewBox: 24,
    render: (color) => (
      <>
        <Path d="M9 5h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z" {...stroke(color, 1.8)} />
        <Path d="m12 9.5 5 5M17 9.5l-5 5" {...stroke(color, 1.8)} />
      </>
    ),
  },
  settings: {
    viewBox: 22,
    render: (color) => (
      <>
        <Path d="M3.5 6h9M16.5 6h2M3.5 11h3M10.5 11h8M3.5 16h11" {...stroke(color, 1.7)} />
        <Circle cx={14.5} cy={6} r={2} {...stroke(color, 1.7)} />
        <Circle cx={8.5} cy={11} r={2} {...stroke(color, 1.7)} />
        <Circle cx={16.5} cy={16} r={2} {...stroke(color, 1.7)} />
      </>
    ),
  },
  search: {
    viewBox: 22,
    render: (color) => (
      <>
        <Circle cx={10} cy={10} r={6} {...stroke(color, 1.7)} />
        <Path d="m14.5 14.5 4 4" {...stroke(color, 1.7)} />
      </>
    ),
  },
  agent: { viewBox: 22, render: (color) => <Path d="M8 3.5v4M14 3.5v4M5.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM11 16v2.5" {...stroke(color, 1.7)} /> },
  more: {
    viewBox: 22,
    render: (color) => (
      <>
        <Circle cx={5} cy={11} r={1.7} fill={color} />
        <Circle cx={11} cy={11} r={1.7} fill={color} />
        <Circle cx={17} cy={11} r={1.7} fill={color} />
      </>
    ),
  },
  sun: {
    viewBox: 20,
    render: (color) => (
      <>
        <Circle cx={10} cy={10} r={3.6} {...stroke(color, 1.7)} />
        <Path d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M4.2 15.8l1.5-1.5M14.3 5.7l1.5-1.5" {...stroke(color, 1.7)} />
      </>
    ),
  },
  edit: { viewBox: 18, render: (color) => <Path d="M11.8 3.2 14.8 6.2 6.4 14.6 2.8 15.2 3.4 11.6z" {...stroke(color, 1.9)} /> },
  lock: {
    viewBox: 18,
    render: (color) => (
      <>
        <Rect x={3.5} y={8} width={11} height={7.5} rx={1.5} {...stroke(color, 1.7)} />
        <Path d="M6 8V5.8a3 3 0 0 1 6 0V8" {...stroke(color, 1.7)} />
      </>
    ),
  },
  play: { viewBox: 18, render: (color) => <Path d="M5 3.2v11.6a.6.6 0 0 0 .9.5l9.2-5.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" fill={color} /> },
  tabToday: {
    viewBox: 22,
    render: (color) => (
      <>
        <Circle cx={11} cy={11} r={7.5} {...stroke(color, 1.7)} />
        <Circle cx={11} cy={11} r={2.5} {...stroke(color, 1.7)} />
      </>
    ),
  },
  tabJournal: { viewBox: 22, render: (color) => <Path d="M4 5.5h14M4 11h14M4 16.5h9" {...stroke(color, 1.7)} /> },
  tabBody: {
    viewBox: 22,
    render: (color) => (
      <>
        <Rect x={3.5} y={3.5} width={15} height={15} rx={3.5} {...stroke(color, 1.7)} />
        <Path d="M7.5 9a4.5 4.5 0 0 1 7 0M11 9.8l1.4-1.8" {...stroke(color, 1.7)} />
      </>
    ),
  },
  tabPrograms: {
    viewBox: 22,
    render: (color) => (
      <>
        <Path d="M17.6 8.2A7 7 0 0 0 4.7 7M4.4 13.8a7 7 0 0 0 12.9 1.2" {...stroke(color, 1.7)} />
        <Path d="M4.2 3.6V7h3.4M17.8 18.4V15h-3.4" {...stroke(color, 1.7)} />
      </>
    ),
  },
} as const satisfies Record<string, Glyph>;

export type IconName = keyof typeof glyphs;

interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: string;
}

export function Icon({ name, size, color }: IconProps) {
  const { colors } = useTheme();
  const glyph: Glyph = glyphs[name];
  const side = size ?? glyph.viewBox;
  return (
    <Svg width={side} height={side} viewBox={`0 0 ${glyph.viewBox} ${glyph.viewBox}`}>
      {glyph.render(color ?? colors.text)}
    </Svg>
  );
}
