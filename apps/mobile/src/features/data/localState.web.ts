const prefix = "obnixe-state:";

export async function writeLocalState(name: string, text: string): Promise<void> {
  localStorage.setItem(`${prefix}${name}`, text);
}

export async function readLocalState(name: string): Promise<string | null> {
  return localStorage.getItem(`${prefix}${name}`);
}

export function deleteLocalState(name: string): void {
  localStorage.removeItem(`${prefix}${name}`);
}
