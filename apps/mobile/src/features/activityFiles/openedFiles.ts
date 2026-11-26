/**
 * `IO-051`: a file shared to Obnixe or opened with it reaches the app as a link, an Android `content://` grant (the
 * `obnixe-intake` module turns a share into a view) or an iOS `file://` copy in the inbox. It opens the import screen.
 */
export function openedFileRoute(path: string): string | null {
  return /^(content|file):\/\//i.test(path) ? `/import-activity?file=${encodeURIComponent(path)}` : null;
}
