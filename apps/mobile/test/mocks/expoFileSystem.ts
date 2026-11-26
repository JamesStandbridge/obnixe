/** In-memory stand-in for the expo-file-system `File`, `Directory` and `Paths` API used by the app. */

export const storedFiles = new Map<string, Uint8Array>();
export const storedDirectories = new Set<string>();

type Part = string | File | Directory;

function join(parts: readonly Part[]): string {
  const [first, ...rest] = parts;
  const base = first instanceof File || first instanceof Directory ? first.uri : (first ?? "");
  return [base.replace(/\/+$/, ""), ...rest.map((part) => (typeof part === "string" ? part : part.uri).replace(/^\/+|\/+$/g, ""))].join("/");
}

function parentOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf("/"));
}

export interface CreateOptions {
  readonly idempotent?: boolean;
  readonly intermediates?: boolean;
}

export interface RelocationOptions {
  readonly overwrite?: boolean;
}

export enum FileMode {
  ReadWrite = "rw",
  ReadOnly = "r",
  WriteOnly = "w",
  Append = "wa",
  Truncate = "wt",
}

export class FileHandle {
  private closed = false;

  constructor(private readonly uri: string) {}

  async writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error(`Handle of ${this.uri} is closed`);
    const current = storedFiles.get(this.uri) ?? new Uint8Array();
    const next = new Uint8Array(current.length + bytes.length);
    next.set(current);
    next.set(bytes, current.length);
    storedFiles.set(this.uri, next);
  }

  close(): void {
    if (this.closed) throw new Error(`Handle of ${this.uri} is already closed`);
    this.closed = true;
  }
}

export class Directory {
  readonly uri: string;

  constructor(...parts: Part[]) {
    this.uri = join(parts);
  }

  get exists(): boolean {
    return storedDirectories.has(this.uri);
  }

  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf("/") + 1);
  }

  get size(): number {
    let total = 0;
    for (const [uri, bytes] of storedFiles) if (uri.startsWith(`${this.uri}/`)) total += bytes.length;
    return total;
  }

  create(options: CreateOptions = {}): void {
    if (this.exists && options.idempotent !== true) throw new Error(`Directory ${this.uri} exists`);
    let uri = this.uri;
    while (uri !== root && !storedDirectories.has(uri)) {
      storedDirectories.add(uri);
      uri = parentOf(uri);
    }
  }

  list(): (Directory | File)[] {
    const children: (Directory | File)[] = [];
    for (const uri of storedDirectories) if (parentOf(uri) === this.uri) children.push(new Directory(uri));
    for (const uri of storedFiles.keys()) if (parentOf(uri) === this.uri) children.push(new File(uri));
    return children;
  }
}

export class File {
  readonly uri: string;

  constructor(...parts: Part[]) {
    this.uri = join(parts);
  }

  get exists(): boolean {
    return storedFiles.has(this.uri);
  }

  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf("/") + 1);
  }

  get parentDirectory(): Directory {
    return new Directory(parentOf(this.uri));
  }

  create(): void {
    if (!storedDirectories.has(parentOf(this.uri))) throw new Error(`No directory for ${this.uri}`);
    storedFiles.set(this.uri, new Uint8Array());
  }

  async write(content: Uint8Array | string): Promise<void> {
    if (!this.exists) this.create();
    storedFiles.set(this.uri, typeof content === "string" ? new TextEncoder().encode(content) : content.slice());
  }

  /** Only the modes the app uses: `Truncate` empties the file, writes append. */
  open(mode: FileMode): FileHandle {
    if (!this.exists) throw new Error(`No file ${this.uri}`);
    if (mode !== FileMode.Truncate) throw new Error(`Unsupported mode ${mode}`);
    storedFiles.set(this.uri, new Uint8Array());
    return new FileHandle(this.uri);
  }

  async bytes(): Promise<Uint8Array> {
    return this.bytesSync();
  }

  bytesSync(): Uint8Array {
    const bytes = storedFiles.get(this.uri);
    if (bytes === undefined) throw new Error(`No file ${this.uri}`);
    return bytes.slice();
  }

  delete(): void {
    if (!storedFiles.delete(this.uri)) throw new Error(`No file ${this.uri}`);
  }

  async move(destination: File, options: RelocationOptions = {}): Promise<void> {
    if (destination.exists && options.overwrite !== true) throw new Error(`File ${destination.uri} exists`);
    storedFiles.set(destination.uri, this.bytesSync());
    storedFiles.delete(this.uri);
  }
}

const root = "file:///data/documents";

export const Paths = {
  document: new Directory(root),
  cache: new Directory("file:///data/cache"),
  availableDiskSpace: 64 * 1024 * 1024 * 1024,
};

export function resetFileSystem(): void {
  storedFiles.clear();
  storedDirectories.clear();
  storedDirectories.add(root);
}

resetFileSystem();
