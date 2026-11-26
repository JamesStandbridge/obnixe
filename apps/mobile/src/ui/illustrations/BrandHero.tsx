import { G, Path, Polygon } from "react-native-svg";
import { SceneFrame } from "@/ui/illustrations/SportScene";
import type { SceneTones, ShardSpot } from "@/ui/illustrations/SportScene";
import { LogoMark } from "@/ui/illustrations/scenes";
import { bevelPath } from "@/ui/Shapes";
import { useTheme } from "@/ui/theme";
import { wash } from "@/ui/tokens";

interface BrandHeroProps {
  readonly size: number;
}

/** The welcome artwork: the mark on a yellow slab, circled by the colours of the sports. */
export function BrandHero({ size }: BrandHeroProps) {
  const { colors } = useTheme();
  const tones: SceneTones = { main: colors.sport.run, deep: colors.sportDeep.run, accent: colors.brand, ink: colors.text, line: wash(colors.text, 0.12) };
  const shards: readonly ShardSpot[] = [
    { x: 8, y: 30, size: 22, shape: "slab", color: () => colors.sport.strength },
    { x: 170, y: 22, size: 18, shape: "triangle", color: () => colors.sport.run },
    { x: 176, y: 132, size: 16, shape: "slab", color: () => colors.sport.climb },
    { x: 14, y: 150, size: 14, shape: "diamond", color: () => colors.sport.swim },
    { x: 96, y: 0, size: 10, shape: "diamond", color: () => colors.sport.yoga },
  ];
  return (
    <SceneFrame
      size={size}
      tones={tones}
      streaks
      shards={shards}
      back={
        <G>
          <Polygon points="150,150 196,150 160,196 114,196" fill={wash(colors.brand, 0.35)} />
        </G>
      }
      rider={
        <G>
          <Path d={bevelPath(128, 128, 28, 18, "topRight")} fill={colors.brand} transform="translate(36 36)" />
          <G transform="translate(42 42) scale(0.113)">
            <LogoMark ink={colors.brandInk} accent={colors.brandDeep} />
          </G>
        </G>
      }
    />
  );
}
