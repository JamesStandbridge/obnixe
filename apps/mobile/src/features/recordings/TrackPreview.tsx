import { memo } from "react";
import Svg, { Circle, Path } from "react-native-svg";
import { previewGeometry } from "@/features/recordings/previewPath";
import { useTheme } from "@/ui/theme";

interface TrackPreviewProps {
  readonly polyline: string;
  readonly color: string;
  readonly width: number;
  readonly height: number;
}

/** The stored masked preview as a vector line, for cards and rows (`MAP-023`). */
export const TrackPreview = memo(function TrackPreview({ polyline, color, width, height }: TrackPreviewProps) {
  const { colors } = useTheme();
  const geometry = previewGeometry(polyline, width, height, 4);
  if (geometry === null) return null;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} accessibilityLabel="Aperçu de la trace">
      <Path d={geometry.path} fill="none" stroke={colors.bg} strokeWidth={4.5} strokeLinejoin="round" strokeLinecap="round" />
      <Path d={geometry.path} fill="none" stroke={color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={geometry.end.x} cy={geometry.end.y} r={2.5} fill={colors.text} stroke={colors.bg} strokeWidth={1.5} />
      <Circle cx={geometry.start.x} cy={geometry.start.y} r={2.75} fill={colors.bg} stroke={color} strokeWidth={1.75} />
    </Svg>
  );
});
