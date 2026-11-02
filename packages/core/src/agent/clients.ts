/** Short name shown for an agent client from the name it announces. */
export function clientLabel(name: string | undefined): string {
  if (name === undefined || name.trim() === "") return "Agent";
  if (/cursor/i.test(name)) return "Cursor";
  if (/codex/i.test(name)) return "Codex";
  if (/claude/i.test(name)) return "Claude";
  if (/chatgpt|openai/i.test(name)) return "ChatGPT";
  if (/vscode|visual studio code/i.test(name)) return "VS Code";
  return name.trim().slice(0, 40);
}
