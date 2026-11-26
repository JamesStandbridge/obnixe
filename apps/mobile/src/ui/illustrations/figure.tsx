import { Circle, G, Polygon } from "react-native-svg";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Chain {
  readonly root: Point;
  readonly joint: Point;
  readonly end: Point;
}

export interface Limbs {
  readonly arm: Chain;
  readonly leg: Chain;
  readonly toe: Point;
}

/** Joint positions of an athlete in a 200 by 200 box, `near` being the side facing the viewer. */
export interface Pose {
  readonly head: Point;
  readonly neck: Point;
  readonly hip: Point;
  readonly near: Limbs;
  readonly far: Limbs;
}

export interface FigureColors {
  readonly main: string;
  readonly deep: string;
  readonly accent: string;
}

const widths = { torsoTop: 30, torsoBottom: 21, upperArm: 11, forearm: 9, thigh: 16, shin: 12, shoe: 8, head: 12.5 } as const;

/** A quad from `a` to `b`, `wa` wide at `a` and `wb` wide at `b`, as SVG polygon points. */
export function segment(a: Point, b: Point, wa: number, wb: number = wa): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const corners: readonly Point[] = [
    { x: a.x + (nx * wa) / 2, y: a.y + (ny * wa) / 2 },
    { x: b.x + (nx * wb) / 2, y: b.y + (ny * wb) / 2 },
    { x: b.x - (nx * wb) / 2, y: b.y - (ny * wb) / 2 },
    { x: a.x - (nx * wa) / 2, y: a.y - (ny * wa) / 2 },
  ];
  return corners.map((corner) => `${corner.x.toFixed(1)},${corner.y.toFixed(1)}`).join(" ");
}

function LimbSet({ limbs, color, accent }: { readonly limbs: Limbs; readonly color: string; readonly accent: string }) {
  const { arm, leg, toe } = limbs;
  return (
    <G>
      <Polygon points={segment(leg.root, leg.joint, widths.thigh, widths.thigh - 2)} fill={color} />
      <Circle cx={leg.joint.x} cy={leg.joint.y} r={(widths.thigh - 2) / 2} fill={color} />
      <Polygon points={segment(leg.joint, leg.end, widths.shin, widths.shin - 3)} fill={color} />
      <Polygon points={segment(leg.end, toe, widths.shoe + 2, widths.shoe - 1)} fill={accent} />
      <Polygon points={segment(arm.root, arm.joint, widths.upperArm, widths.upperArm - 1)} fill={color} />
      <Circle cx={arm.joint.x} cy={arm.joint.y} r={(widths.forearm + 1) / 2} fill={color} />
      <Polygon points={segment(arm.joint, arm.end, widths.forearm, widths.forearm - 2)} fill={color} />
      <Circle cx={arm.end.x} cy={arm.end.y} r={widths.forearm / 2} fill={color} />
    </G>
  );
}

/** An athlete built from slanted quads: far limbs in the deep tone, torso and near limbs in the main tone. */
export function Figure({ pose, colors }: { readonly pose: Pose; readonly colors: FigureColors }) {
  return (
    <G>
      <LimbSet limbs={pose.far} color={colors.deep} accent={colors.accent} />
      <Polygon points={segment(pose.neck, pose.hip, widths.torsoTop, widths.torsoBottom)} fill={colors.main} />
      <Circle cx={pose.hip.x} cy={pose.hip.y} r={widths.torsoBottom / 2} fill={colors.main} />
      <Polygon points={segment(pose.neck, pose.head, 9, 9)} fill={colors.main} />
      <Circle cx={pose.head.x} cy={pose.head.y} r={widths.head} fill={colors.main} />
      <LimbSet limbs={pose.near} color={colors.main} accent={colors.accent} />
    </G>
  );
}

const p = (x: number, y: number): Point => ({ x, y });

export const poses = {
  run: {
    head: p(124, 40),
    neck: p(117, 58),
    hip: p(100, 104),
    near: { arm: { root: p(118, 64), joint: p(138, 82), end: p(153, 66) }, leg: { root: p(102, 104), joint: p(132, 120), end: p(124, 152) }, toe: p(138, 156) },
    far: { arm: { root: p(112, 64), joint: p(94, 82), end: p(80, 98) }, leg: { root: p(98, 104), joint: p(84, 136), end: p(58, 148) }, toe: p(52, 160) },
  },
  climb: {
    head: p(108, 54),
    neck: p(106, 71),
    hip: p(98, 116),
    near: { arm: { root: p(112, 73), joint: p(126, 50), end: p(134, 26) }, leg: { root: p(101, 116), joint: p(126, 126), end: p(132, 150) }, toe: p(145, 150) },
    far: { arm: { root: p(100, 73), joint: p(84, 60), end: p(80, 38) }, leg: { root: p(95, 116), joint: p(74, 136), end: p(84, 162) }, toe: p(97, 162) },
  },
  strength: {
    head: p(100, 46),
    neck: p(100, 64),
    hip: p(100, 110),
    near: { arm: { root: p(113, 68), joint: p(132, 54), end: p(132, 28) }, leg: { root: p(106, 110), joint: p(124, 138), end: p(126, 168) }, toe: p(138, 171) },
    far: { arm: { root: p(87, 68), joint: p(68, 54), end: p(68, 28) }, leg: { root: p(94, 110), joint: p(76, 138), end: p(74, 168) }, toe: p(62, 171) },
  },
  swim: {
    head: p(152, 92),
    neck: p(138, 95),
    hip: p(90, 101),
    near: { arm: { root: p(138, 97), joint: p(158, 80), end: p(180, 88) }, leg: { root: p(92, 103), joint: p(66, 106), end: p(42, 99) }, toe: p(32, 93) },
    far: { arm: { root: p(132, 93), joint: p(118, 113), end: p(100, 120) }, leg: { root: p(88, 99), joint: p(62, 95), end: p(40, 106) }, toe: p(30, 111) },
  },
  hike: {
    head: p(116, 40),
    neck: p(111, 58),
    hip: p(100, 104),
    near: { arm: { root: p(113, 63), joint: p(124, 84), end: p(136, 96) }, leg: { root: p(102, 104), joint: p(122, 132), end: p(126, 162) }, toe: p(139, 164) },
    far: { arm: { root: p(106, 63), joint: p(96, 84), end: p(88, 100) }, leg: { root: p(98, 104), joint: p(90, 136), end: p(74, 160) }, toe: p(86, 166) },
  },
  bike: {
    head: p(140, 54),
    neck: p(129, 68),
    hip: p(92, 98),
    near: { arm: { root: p(128, 72), joint: p(140, 88), end: p(150, 100) }, leg: { root: p(95, 100), joint: p(122, 112), end: p(114, 138) }, toe: p(125, 140) },
    far: { arm: { root: p(124, 72), joint: p(134, 90), end: p(144, 102) }, leg: { root: p(90, 100), joint: p(104, 124), end: p(96, 148) }, toe: p(106, 150) },
  },
  yoga: {
    head: p(100, 46),
    neck: p(100, 64),
    hip: p(100, 112),
    near: { arm: { root: p(112, 68), joint: p(137, 68), end: p(164, 68) }, leg: { root: p(106, 112), joint: p(138, 126), end: p(142, 166) }, toe: p(155, 168) },
    far: { arm: { root: p(88, 68), joint: p(63, 68), end: p(36, 68) }, leg: { root: p(94, 112), joint: p(72, 140), end: p(52, 166) }, toe: p(40, 168) },
  },
  ski: {
    head: p(124, 58),
    neck: p(115, 74),
    hip: p(92, 112),
    near: { arm: { root: p(114, 78), joint: p(130, 96), end: p(148, 102) }, leg: { root: p(94, 112), joint: p(122, 124), end: p(112, 154) }, toe: p(128, 155) },
    far: { arm: { root: p(108, 78), joint: p(118, 100), end: p(138, 108) }, leg: { root: p(90, 112), joint: p(112, 132), end: p(98, 158) }, toe: p(114, 159) },
  },
  glide: {
    head: p(118, 42),
    neck: p(112, 60),
    hip: p(98, 106),
    near: { arm: { root: p(114, 64), joint: p(134, 80), end: p(148, 92) }, leg: { root: p(100, 106), joint: p(122, 132), end: p(124, 160) }, toe: p(138, 162) },
    far: { arm: { root: p(108, 64), joint: p(90, 84), end: p(72, 98) }, leg: { root: p(96, 106), joint: p(82, 134), end: p(60, 154) }, toe: p(72, 160) },
  },
  paddle: {
    head: p(102, 50),
    neck: p(100, 68),
    hip: p(94, 114),
    near: { arm: { root: p(110, 72), joint: p(126, 90), end: p(142, 82) }, leg: { root: p(98, 114), joint: p(124, 108), end: p(150, 118) }, toe: p(156, 112) },
    far: { arm: { root: p(92, 72), joint: p(78, 90), end: p(66, 80) }, leg: { root: p(92, 114), joint: p(118, 112), end: p(144, 122) }, toe: p(150, 116) },
  },
  stand: {
    head: p(100, 40),
    neck: p(100, 58),
    hip: p(100, 108),
    near: { arm: { root: p(113, 62), joint: p(120, 86), end: p(122, 110) }, leg: { root: p(106, 108), joint: p(110, 138), end: p(112, 168) }, toe: p(124, 170) },
    far: { arm: { root: p(87, 62), joint: p(80, 86), end: p(78, 110) }, leg: { root: p(94, 108), joint: p(90, 138), end: p(88, 168) }, toe: p(76, 170) },
  },
  cheer: {
    head: p(100, 52),
    neck: p(100, 70),
    hip: p(100, 116),
    near: { arm: { root: p(113, 74), joint: p(130, 50), end: p(146, 28) }, leg: { root: p(106, 116), joint: p(128, 132), end: p(122, 160) }, toe: p(134, 164) },
    far: { arm: { root: p(87, 74), joint: p(70, 50), end: p(54, 28) }, leg: { root: p(94, 116), joint: p(76, 136), end: p(80, 164) }, toe: p(68, 168) },
  },
} as const satisfies Record<string, Pose>;

export type PoseName = keyof typeof poses;
