import type { ReactElement } from "react";
import { G, Path, Polygon, Rect } from "react-native-svg";
import { Figure, poses } from "@/ui/illustrations/figure";
import type { SportKey } from "@obnixe/schema";
import { SceneFrame, useSceneTones } from "@/ui/illustrations/SportScene";
import type { SceneTones } from "@/ui/illustrations/SportScene";
import { bevelPath } from "@/ui/Shapes";
import { useTheme } from "@/ui/theme";
import type { Palette } from "@/ui/tokens";
import { wash } from "@/ui/tokens";

export type EmptyKind = "journal" | "program" | "body" | "agent" | "photos" | "progress" | "cheer";

const markDark = "M228.00 237.84 L447.00 180.90 L517.00 250.70 L316.00 302.96 L316.00 664.96 L552.00 603.60 L552.00 563.60 L640.00 540.72 L640.00 668.72 L228.00 775.84 Z M796.00 786.16 L577.00 843.10 L507.00 773.30 L708.00 721.04 L708.00 359.04 L472.00 420.40 L472.00 460.40 L384.00 483.28 L384.00 355.28 L796.00 248.16 Z";
const markLight = "M384.00 480.28 L472.00 457.40 L472.00 478.40 L640.00 434.72 L640.00 543.72 L552.00 566.60 L552.00 545.60 L384.00 589.28 Z";

/** The Obnixe mark, drawn in a 1024 box. */
export function LogoMark({ ink, accent }: { readonly ink: string; readonly accent: string }) {
  return (
    <G>
      <Path d={markLight} fill={accent} />
      <Path d={markDark} fill={ink} />
    </G>
  );
}

function neutralTones(colors: Palette): SceneTones {
  return { main: colors.text2, deep: colors.text3, accent: colors.brand, ink: colors.text, line: wash(colors.text, 0.12) };
}

function cell(x: number, y: number, fill: string): ReactElement {
  return <Rect key={`${x}-${y}`} x={x} y={y} width={22} height={18} rx={4} fill={fill} />;
}

function journal(colors: Palette, tones: SceneTones): ReactElement {
  const filled: Readonly<Record<string, string>> = {
    "0-1": colors.sport.strength,
    "2-1": colors.sport.run,
    "1-2": colors.sport.climb,
    "3-2": colors.sport.strength,
    "0-3": colors.sport.hike,
    "2-3": colors.sport.strength,
  };
  const cells: ReactElement[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      cells.push(cell(52 + column * 26, 74 + row * 24, filled[`${column}-${row}`] ?? wash(tones.ink, 0.1)));
    }
  }
  return (
    <G>
      <Polygon points="30,40 170,26 180,172 40,186" fill={wash(tones.ink, 0.05)} />
      <Path d={bevelPath(120, 132, 20, 12, "topRight")} fill={wash(tones.ink, 0.08)} transform="translate(40 36)" />
      <Path d={bevelPath(120, 26, 20, 12, "topRight")} fill={tones.accent} transform="translate(40 36)" />
      {cells}
    </G>
  );
}

function program(colors: Palette): ReactElement {
  const card = (x: number, y: number, fill: string, line: string): ReactElement => (
    <G key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
      <Polygon points="16,0 120,0 104,56 0,56" fill={fill} />
      <Rect x={18} y={16} width={56} height={7} rx={3.5} fill={line} />
      <Rect x={14} y={32} width={36} height={7} rx={3.5} fill={line} opacity={0.6} />
    </G>
  );
  return (
    <G>
      {card(58, 38, colors.sport.climb, colors.sportInk)}
      {card(44, 78, colors.sport.run, colors.sportInk)}
      {card(30, 118, colors.sport.strength, colors.sportInk)}
      <Polygon points="150,120 176,120 158,150 132,150" fill={colors.brand} />
      <Path d="M141 135 l6 6 l12 -12" stroke={colors.brandInk} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </G>
  );
}

function body(tones: SceneTones): ReactElement {
  return (
    <G>
      <Polygon points="26,34 178,16 188,170 36,188" fill={wash(tones.main, 0.1)} />
      <Polygon points="56,170 146,170 138,182 48,182" fill={wash(tones.ink, 0.25)} />
    </G>
  );
}

function bodyRider(tones: SceneTones): ReactElement {
  return (
    <G>
      <Figure pose={poses.stand} colors={tones} />
      <Polygon points="78,96 124,92 124,102 78,106" fill={tones.accent} />
      <Rect x={98} y={92} width={3} height={12} fill={tones.deep} />
    </G>
  );
}

function agent(colors: Palette, tones: SceneTones): ReactElement {
  return (
    <G>
      <Polygon points="26,34 178,16 188,170 36,188" fill={wash(colors.sport.strength, 0.1)} />
      <Path d={bevelPath(64, 112, 16, 12, "topRight")} fill={wash(tones.ink, 0.12)} transform="translate(30 50)" />
      <G transform="translate(38 74) scale(0.047)">
        <LogoMark ink={tones.ink} accent={colors.brand} />
      </G>
      <Path d="M100 106 L118 96 L130 110 L148 98" stroke={colors.brand} strokeWidth={5} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 10" />
      <Path d={bevelPath(46, 46, 12, 10, "topRight")} fill={colors.sport.strength} transform="translate(140 70)" />
      <Path d="M163 80 l4 10 l10 3 l-10 3 l-4 10 l-4 -10 l-10 -3 l10 -3 z" fill={colors.sportInk} />
    </G>
  );
}

function photos(colors: Palette, tones: SceneTones): ReactElement {
  return (
    <G>
      <Path d={bevelPath(132, 112, 20, 12, "topRight")} fill={wash(tones.ink, 0.08)} transform="translate(34 46)" />
      <Path d="M34 70 V58 Q34 46 46 46 H60 M152 158 H156 Q166 158 166 146 V132" stroke={colors.brand} strokeWidth={5} fill="none" strokeLinecap="round" />
      <Polygon points="48,150 88,100 112,128 128,112 156,150" fill={wash(colors.sport.climb, 0.7)} />
      <Polygon points="124,64 140,64 132,80" fill={colors.brand} />
    </G>
  );
}

function progress(colors: Palette): ReactElement {
  const bars: readonly [number, number, string][] = [
    [40, 46, colors.sport.strength],
    [70, 70, colors.sport.run],
    [100, 92, colors.sport.climb],
    [130, 118, colors.sport.strength],
  ];
  return (
    <G>
      <Polygon points="26,34 178,16 188,170 36,188" fill={wash(colors.sport.strength, 0.1)} />
      {bars.map(([x, height, fill]) => (
        <Polygon key={x} points={`${x + 8},${170 - height} ${x + 26},${170 - height} ${x + 18},170 ${x},170`} fill={fill} />
      ))}
      <Polygon points="40,118 140,40 146,52 46,130" fill={colors.brand} />
      <Polygon points="128,32 160,30 150,60" fill={colors.brand} />
    </G>
  );
}

function cheer(colors: Palette, tones: SceneTones): ReactElement {
  return (
    <G>
      <Polygon points="26,34 178,16 188,170 36,188" fill={wash(colors.brand, 0.14)} />
      <Polygon points="100,6 112,40 148,40 120,62 130,96 100,76 70,96 80,62 52,40 88,40" fill={wash(colors.brand, 0.3)} />
      <Polygon points="56,176 146,176 138,184 48,184" fill={tones.line} />
    </G>
  );
}

/** The cheering athlete, drawn in ink for a backdrop filled with the sport colour. */
export function CheerScene({ sport, size }: { readonly sport: SportKey; readonly size: number }) {
  const { colors } = useTheme();
  const tones = useSceneTones(sport, true);
  return <SceneFrame size={size} tones={tones} back={cheer(colors, tones)} rider={<Figure pose={poses.cheer} colors={tones} />} />;
}

interface EmptySceneProps {
  readonly kind: EmptyKind;
  readonly size: number;
}

export function EmptyScene({ kind, size }: EmptySceneProps) {
  const { colors } = useTheme();
  const tones = neutralTones(colors);
  const cheerTones: SceneTones = { ...tones, main: colors.brand, deep: colors.brandDeep, accent: colors.sport.run };
  switch (kind) {
    case "journal":
      return <SceneFrame size={size} tones={tones} back={<G />} rider={journal(colors, tones)} />;
    case "program":
      return <SceneFrame size={size} tones={tones} back={<G />} rider={program(colors)} />;
    case "body":
      return <SceneFrame size={size} tones={tones} back={body(tones)} rider={bodyRider(tones)} />;
    case "agent":
      return <SceneFrame size={size} tones={tones} back={<G />} rider={agent(colors, tones)} streaks />;
    case "photos":
      return <SceneFrame size={size} tones={tones} back={<G />} rider={photos(colors, tones)} />;
    case "progress":
      return <SceneFrame size={size} tones={tones} back={<G />} rider={progress(colors)} />;
    case "cheer":
      return <SceneFrame size={size} tones={cheerTones} back={cheer(colors, cheerTones)} rider={<Figure pose={poses.cheer} colors={cheerTones} />} />;
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled scene ${String(unreachable)}`);
    }
  }
}
