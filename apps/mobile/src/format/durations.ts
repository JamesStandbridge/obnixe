export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatLongClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  if (hours === 0) return formatClock(whole);
  return `${hours}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatTargetDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, "0")}`;
}
