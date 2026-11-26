import { Fragment } from "react";
import Svg, { Circle, Path, Rect, Text as SvgText, TSpan } from "react-native-svg";
import type { ShareTrack } from "@obnixe/core";
import type { SportKey } from "@obnixe/schema";
import type { StatValue } from "@/ui/Stats";
import { useTheme } from "@/ui/theme";
import { fonts, wash } from "@/ui/tokens";

/** Pixel size of the shared image: portrait 4:5, accepted as is by the usual photo feeds. */
export const shareImageSize = { width: 1080, height: 1350 } as const;

const margin = 80;
/** Where the track is drawn, in image units. */
export const shareTrackFrame = { width: shareImageSize.width - 2 * margin, height: 560 } as const;
const trackTop = 320;
const titleLength = 26;

export type ShareTrackState = { readonly kind: "drawn"; readonly track: ShareTrack } | { readonly kind: "masked" } | { readonly kind: "none" };

export interface ShareCardContent {
  readonly sport: SportKey;
  readonly sportLabel: string;
  readonly title: string;
  readonly date: string;
  /** At most four, drawn two by two. */
  readonly figures: readonly StatValue[];
  readonly track: ShareTrackState;
}

function linePath(points: ShareTrack["runs"][number]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${(margin + point.x).toFixed(1)},${(trackTop + point.y).toFixed(1)}`).join("");
}

function shortTitle(title: string): string {
  return title.length <= titleLength ? title : `${title.slice(0, titleLength - 1).trimEnd()}…`;
}

function trackNote(track: ShareTrackState): string | null {
  switch (track.kind) {
    case "drawn":
      return null;
    case "masked":
      return "Trace masquée par tes zones de confidentialité";
    case "none":
      return "Sans trace GPS";
    default: {
      const unreachable: never = track;
      return unreachable;
    }
  }
}

interface ShareCardProps {
  readonly content: ShareCardContent;
  readonly width: number;
}

/**
 * `SUM-006`: the stylized track without map background, the key figures and the activity, drawn as one SVG so the phone
 * captures it as is and the web rasterizes the same drawing.
 */
export function ShareCard({ content, width }: ShareCardProps) {
  const { colors } = useTheme();
  const tone = colors.sport[content.sport];
  const note = trackNote(content.track);
  const paths = content.track.kind === "drawn" ? content.track.track.runs.map(linePath) : [];
  const columnWidth = (shareImageSize.width - 2 * margin) / 2;
  return (
    <Svg
      width={width}
      height={(width * shareImageSize.height) / shareImageSize.width}
      viewBox={`0 0 ${shareImageSize.width} ${shareImageSize.height}`}
      accessibilityLabel={`Image de partage : ${content.title}`}
    >
      <Rect x={0} y={0} width={shareImageSize.width} height={shareImageSize.height} fill={colors.bg} />
      <Rect x={0} y={0} width={shareImageSize.width} height={14} fill={tone} />
      <SvgText x={margin} y={132} fill={tone} fontFamily={fonts.text700} fontSize={34} letterSpacing={4}>
        {content.sportLabel.toUpperCase()}
      </SvgText>
      <SvgText x={margin} y={212} fill={colors.text} fontFamily={fonts.brand800} fontSize={68}>
        {shortTitle(content.title)}
      </SvgText>
      <SvgText x={margin} y={268} fill={colors.text2} fontFamily={fonts.text500} fontSize={34}>
        {content.date}
      </SvgText>
      {paths.map((path, index) => (
        <Path key={`glow-${index}`} d={path} fill="none" stroke={wash(tone, 0.22)} strokeWidth={34} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {paths.map((path, index) => (
        <Path key={`line-${index}`} d={path} fill="none" stroke={tone} strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {content.track.kind === "drawn" ? (
        <>
          <Circle cx={margin + content.track.track.end.x} cy={trackTop + content.track.track.end.y} r={16} fill={colors.text} stroke={colors.bg} strokeWidth={6} />
          <Circle cx={margin + content.track.track.start.x} cy={trackTop + content.track.track.start.y} r={18} fill={colors.bg} stroke={tone} strokeWidth={8} />
        </>
      ) : null}
      {note === null ? null : (
        <SvgText x={shareImageSize.width / 2} y={trackTop + shareTrackFrame.height / 2} fill={colors.text3} fontFamily={fonts.text600} fontSize={36} textAnchor="middle">
          {note}
        </SvgText>
      )}
      {content.figures.slice(0, 4).map((figure, index) => {
        const x = margin + (index % 2) * columnWidth;
        const y = 960 + Math.floor(index / 2) * 160;
        return (
          <Fragment key={figure.label}>
            <SvgText x={x} y={y} fill={colors.text2} fontFamily={fonts.text600} fontSize={32}>
              {figure.label}
            </SvgText>
            <SvgText x={x} y={y + 92} fill={colors.text} fontFamily={fonts.figure800} fontSize={104}>
              <TSpan>{figure.value}</TSpan>
              {figure.unit === "" ? null : (
                <TSpan fill={colors.text2} fontFamily={fonts.figure600} fontSize={44} dx={12}>
                  {figure.unit}
                </TSpan>
              )}
            </SvgText>
          </Fragment>
        );
      })}
      <SvgText x={shareImageSize.width - margin} y={shareImageSize.height - 56} fill={colors.text3} fontFamily={fonts.brand800} fontSize={32} letterSpacing={6} textAnchor="end">
        OBNIXE
      </SvgText>
    </Svg>
  );
}
