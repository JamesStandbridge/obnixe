import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Polygon, Rect } from "react-native-svg";
import type { SportKey } from "@obnixe/schema";
import { Figure, poses, segment } from "@/ui/illustrations/figure";
import type { FigureColors } from "@/ui/illustrations/figure";
import { Drift, Shard, Streak } from "@/ui/illustrations/motion";
import type { ShardShape } from "@/ui/illustrations/motion";
import { useTheme } from "@/ui/theme";
import { wash } from "@/ui/tokens";

const box = 200;

export interface SceneTones extends FigureColors {
  readonly ink: string;
  readonly line: string;
}

export interface ShardSpot {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly shape: ShardShape;
  readonly color: (tones: SceneTones) => string;
}

const shardSpots: readonly ShardSpot[] = [
  { x: 14, y: 18, size: 18, shape: "triangle", color: (tones) => tones.accent },
  { x: 168, y: 30, size: 15, shape: "slab", color: (tones) => tones.main },
  { x: 160, y: 150, size: 10, shape: "diamond", color: (tones) => tones.ink },
];

interface SportArt {
  readonly back: (tones: SceneTones) => ReactElement;
  readonly rider: (tones: SceneTones) => ReactElement;
  readonly front?: (tones: SceneTones) => ReactElement;
  readonly streaks: boolean;
}

const shadow = (tones: SceneTones, cx = 100, rx = 58) => <Ellipse cx={cx} cy={176} rx={rx} ry={6} fill={tones.line} />;

const slab = (tones: SceneTones) => <Polygon points="26,34 178,16 188,170 36,188" fill={wash(tones.main, 0.14)} />;

const arts: Readonly<Record<SportKey, SportArt>> = {
  run: {
    streaks: true,
    back: (tones) => (
      <G>
        {slab(tones)}
        {shadow(tones)}
      </G>
    ),
    rider: (tones) => <Figure pose={poses.run} colors={tones} />,
  },
  climb: {
    streaks: false,
    back: (tones) => (
      <G>
        <Polygon points="48,0 198,0 180,200 30,200" fill={wash(tones.main, 0.16)} />
        <Polygon points="66,0 112,0 52,200 30,200" fill={wash(tones.main, 0.08)} />
        {[
          [60, 92, tones.main],
          [150, 70, tones.accent],
          [164, 118, tones.main],
          [58, 140, tones.accent],
          [144, 182, tones.ink],
        ].map(([x, y, color]) => (
          <Polygon key={`${x}-${y}`} points={`${Number(x) - 6},${Number(y) + 4} ${x},${Number(y) - 6} ${Number(x) + 7},${Number(y) + 2} ${Number(x) + 2},${Number(y) + 7}`} fill={String(color)} />
        ))}
      </G>
    ),
    rider: (tones) => (
      <G>
        <Polygon points="126,22 136,16 144,26 134,32" fill={tones.accent} />
        <Polygon points="72,36 82,30 88,40 78,46" fill={tones.main} />
        <Figure pose={poses.climb} colors={tones} />
      </G>
    ),
  },
  strength: {
    streaks: false,
    back: (tones) => (
      <G>
        {slab(tones)}
        {shadow(tones, 100, 46)}
      </G>
    ),
    rider: (tones) => (
      <G>
        <Figure pose={poses.strength} colors={tones} />
        <Rect x={30} y={25} width={140} height={6} rx={3} fill={tones.ink} />
        <Rect x={34} y={6} width={12} height={44} rx={3} fill={tones.deep} />
        <Rect x={48} y={12} width={7} height={32} rx={2} fill={tones.accent} />
        <Rect x={154} y={6} width={12} height={44} rx={3} fill={tones.deep} />
        <Rect x={145} y={12} width={7} height={32} rx={2} fill={tones.accent} />
      </G>
    ),
  },
  swim: {
    streaks: true,
    back: (tones) => <G>{slab(tones)}</G>,
    rider: (tones) => <Figure pose={poses.swim} colors={tones} />,
    front: (tones) => (
      <G>
        <Path d="M0 112 Q 25 102 50 112 T 100 112 T 150 112 T 200 112 V 200 H 0 Z" fill={wash(tones.main, 0.22)} />
        <Path d="M10 126 Q 30 118 50 126 T 90 126" stroke={tones.ink} strokeOpacity={0.5} strokeWidth={3} fill="none" strokeLinecap="round" />
        <Path d="M110 144 Q 130 136 150 144 T 190 144" stroke={tones.accent} strokeWidth={3} fill="none" strokeLinecap="round" />
      </G>
    ),
  },
  hike: {
    streaks: false,
    back: (tones) => (
      <G>
        <Polygon points="0,168 46,96 82,140 128,62 200,160 200,200 0,200" fill={wash(tones.main, 0.16)} />
        <Polygon points="128,62 146,88 134,84 122,96 112,88" fill={wash(tones.ink, 0.5)} />
        <Polygon points="0,180 200,150 200,200 0,200" fill={wash(tones.main, 0.12)} />
      </G>
    ),
    rider: (tones) => (
      <G>
        <Polygon points={segment({ x: 136, y: 96 }, { x: 150, y: 170 }, 3.5)} fill={tones.ink} />
        <Polygon points={segment({ x: 88, y: 100 }, { x: 76, y: 172 }, 3.5)} fill={tones.ink} />
        <Polygon points={segment({ x: 98, y: 62 }, { x: 90, y: 98 }, 26, 22)} fill={tones.accent} />
        <Figure pose={poses.hike} colors={tones} />
      </G>
    ),
  },
  bike: {
    streaks: true,
    back: (tones) => (
      <G>
        {slab(tones)}
        {shadow(tones, 104, 70)}
      </G>
    ),
    rider: (tones) => (
      <G>
        <Circle cx={56} cy={146} r={27} stroke={tones.ink} strokeWidth={6} fill="none" />
        <Circle cx={154} cy={146} r={27} stroke={tones.ink} strokeWidth={6} fill="none" />
        <Polygon points={segment({ x: 56, y: 146 }, { x: 102, y: 144 }, 5)} fill={tones.accent} />
        <Polygon points={segment({ x: 102, y: 144 }, { x: 90, y: 98 }, 5)} fill={tones.accent} />
        <Polygon points={segment({ x: 90, y: 102 }, { x: 142, y: 96 }, 5)} fill={tones.accent} />
        <Polygon points={segment({ x: 102, y: 144 }, { x: 142, y: 96 }, 5)} fill={tones.accent} />
        <Polygon points={segment({ x: 142, y: 92 }, { x: 154, y: 146 }, 5)} fill={tones.accent} />
        <Figure pose={poses.bike} colors={tones} />
      </G>
    ),
  },
  yoga: {
    streaks: false,
    back: (tones) => (
      <G>
        <Circle cx={100} cy={84} r={70} fill={wash(tones.main, 0.14)} />
        <Polygon points="30,166 182,166 172,178 20,178" fill={wash(tones.accent, 0.55)} />
      </G>
    ),
    rider: (tones) => <Figure pose={poses.yoga} colors={tones} />,
  },
};

export function useSceneTones(sport: SportKey, onBand = false): SceneTones {
  const { colors } = useTheme();
  if (onBand) return { main: colors.sportInk, deep: colors.sportDeep[sport], accent: colors.brand, ink: colors.sportInk, line: wash(colors.sportInk, 0.16) };
  return { main: colors.sport[sport], deep: colors.sportDeep[sport], accent: colors.brand, ink: colors.text, line: wash(colors.text, 0.12) };
}

interface SceneFrameProps {
  readonly size: number;
  readonly tones: SceneTones;
  readonly back: ReactElement;
  readonly rider: ReactElement;
  readonly front?: ReactElement;
  readonly streaks?: boolean;
  readonly shards?: readonly ShardSpot[];
}

/** Lays out a 200 by 200 scene: static backdrop, floating athlete, speed lines and drifting shards. */
export function SceneFrame({ size, tones, back, rider, front, streaks = false, shards = shardSpots }: SceneFrameProps) {
  const scale = size / box;
  const layer = { width: size, height: size };
  return (
    <View pointerEvents="none" style={layer}>
      <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`} style={StyleSheet.absoluteFill}>
        {back}
      </Svg>
      {streaks ? (
        <Streak duration={1100} travel={18 * scale} style={StyleSheet.absoluteFill}>
          <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`}>
            <Polygon points="18,70 62,70 58,76 14,76" fill={tones.main} />
            <Polygon points="4,96 50,96 46,102 0,102" fill={tones.accent} />
            <Polygon points="22,122 58,122 54,128 18,128" fill={tones.main} opacity={0.6} />
          </Svg>
        </Streak>
      ) : null}
      <Drift duration={2400} lift={2.5 * scale} style={StyleSheet.absoluteFill}>
        <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`}>
          {rider}
        </Svg>
      </Drift>
      {front === undefined ? null : (
        <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`} style={StyleSheet.absoluteFill}>
          {front}
        </Svg>
      )}
      {shards.map((spot, index) => (
        <Drift key={`${spot.x}-${spot.y}`} duration={2600 + index * 500} delay={index * 300} lift={5 * scale} turn={10} style={[styles.shard, { left: spot.x * scale, top: spot.y * scale }]}>
          <Shard shape={spot.shape} color={spot.color(tones)} size={spot.size * scale} />
        </Drift>
      ))}
    </View>
  );
}

interface SportSceneProps {
  readonly sport: SportKey;
  readonly size: number;
  readonly onBand?: boolean;
}

/** One athlete per sport; `onBand` draws it in ink for a backdrop already filled with the sport colour. */
export function SportScene({ sport, size, onBand = false }: SportSceneProps) {
  const tones = useSceneTones(sport, onBand);
  const art = arts[sport];
  return <SceneFrame size={size} tones={tones} back={art.back(tones)} rider={art.rider(tones)} {...(art.front === undefined ? {} : { front: art.front(tones) })} streaks={art.streaks} />;
}

const styles = StyleSheet.create({
  shard: { position: "absolute" },
});
