import { decodeUtf8, InvalidUtf8Error } from "../../data/utf8.ts";
import { ImportError } from "./errors.ts";

/** Attributes of an element by local name. */
export type XmlAttributes = Readonly<Record<string, string>>;

/** Element names are local names: the namespace prefix is dropped, so `gpxtpx:hr` and `ns3:hr` both read `hr`. */
export interface XmlHandler {
  open(name: string, attributes: XmlAttributes): void;
  close(name: string): void;
  text(text: string): void;
}

export class XmlSyntaxError extends Error {
  constructor(
    readonly reason: string,
    readonly offset: number,
    /** The document ends inside a construct or an element. */
    readonly truncated: boolean = false,
  ) {
    super(`${reason} at character ${offset}`);
  }
}

const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const entityPattern = /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]+);|&/g;
const whitespace = /^[\s\uFEFF]*$/;
const namePattern = /^[A-Za-z_][\w.:-]*$/;

const localName = (name: string): string => name.slice(name.indexOf(":") + 1);

function decodeEntities(text: string, offset: number): string {
  if (!text.includes("&")) return text;
  return text.replace(entityPattern, (_match: string, entity: string | undefined) => {
    if (entity === undefined) throw new XmlSyntaxError("bare ampersand", offset);
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (code > 0x10ffff) throw new XmlSyntaxError(`invalid character reference &${entity};`, offset);
      return String.fromCodePoint(code);
    }
    const value = entities[entity];
    if (value === undefined) throw new XmlSyntaxError(`unknown entity &${entity};`, offset);
    return value;
  });
}

/** Index of the `>` closing the tag opened at `start`, skipping quoted attribute values. */
function tagEnd(source: string, start: number): number {
  let quote = 0;
  for (let index = start; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (code === 0x22 || code === 0x27) {
      quote = code;
    } else if (code === 0x3e) {
      return index;
    } else if (code === 0x3c) {
      throw new XmlSyntaxError("unexpected < in a tag", index);
    }
  }
  throw new XmlSyntaxError("unterminated tag", start, true);
}

function parseAttributes(body: string, offset: number): XmlAttributes {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index] ?? "")) index += 1;
    if (index >= body.length) break;
    const equals = body.indexOf("=", index);
    if (equals < 0) throw new XmlSyntaxError("attribute without a value", offset + index);
    const name = body.slice(index, equals).trim();
    if (!namePattern.test(name)) throw new XmlSyntaxError(`invalid attribute name "${name}"`, offset + index);
    let valueStart = equals + 1;
    while (valueStart < body.length && /\s/.test(body[valueStart] ?? "")) valueStart += 1;
    const quote = body[valueStart];
    if (quote !== '"' && quote !== "'") throw new XmlSyntaxError(`unquoted value of ${name}`, offset + valueStart);
    const valueEnd = body.indexOf(quote, valueStart + 1);
    if (valueEnd < 0) throw new XmlSyntaxError(`unterminated value of ${name}`, offset + valueStart);
    attributes[localName(name)] = decodeEntities(body.slice(valueStart + 1, valueEnd), offset + valueStart);
    index = valueEnd + 1;
    if (index < body.length && !/\s/.test(body[index] ?? "")) throw new XmlSyntaxError("attributes must be separated by whitespace", offset + index);
  }
  return attributes;
}

/**
 * Minimal streaming XML reader (SAX): elements, attributes, text, CDATA and the predefined and numeric entities. Comments,
 * processing instructions and the document type are skipped. Throws `XmlSyntaxError` on any well-formedness error, including
 * a truncated document, before or while calling the handler.
 */
export function parseXml(source: string, handler: XmlHandler): void {
  const open: string[] = [];
  let rootSeen = false;
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf("<", index);
    const textEnd = lt < 0 ? source.length : lt;
    if (textEnd > index) {
      const text = source.slice(index, textEnd);
      if (open.length > 0) handler.text(decodeEntities(text, index));
      else if (!whitespace.test(text)) throw new XmlSyntaxError("text outside the root element", index);
    }
    if (lt < 0) break;
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlSyntaxError("unterminated comment", lt, true);
      index = end + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlSyntaxError("unterminated CDATA section", lt, true);
      if (open.length === 0) throw new XmlSyntaxError("CDATA outside the root element", lt);
      handler.text(source.slice(lt + 9, end));
      index = end + 3;
    } else if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlSyntaxError("unterminated processing instruction", lt, true);
      index = end + 2;
    } else if (source.startsWith("<!", lt)) {
      if (rootSeen) throw new XmlSyntaxError("declaration inside the document", lt);
      const subset = source.indexOf("[", lt);
      const close = source.indexOf(">", lt);
      const end = subset >= 0 && subset < close ? source.indexOf(">", source.indexOf("]", subset)) : close;
      if (end < 0) throw new XmlSyntaxError("unterminated declaration", lt, true);
      index = end + 1;
    } else if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt);
      if (end < 0) throw new XmlSyntaxError("unterminated closing tag", lt, true);
      const name = source.slice(lt + 2, end).trim();
      const expected = open.pop();
      if (expected !== name) throw new XmlSyntaxError(expected === undefined ? `unexpected </${name}>` : `</${name}> closes <${expected}>`, lt);
      handler.close(localName(name));
      index = end + 1;
    } else {
      const end = tagEnd(source, lt + 1);
      const selfClosing = source[end - 1] === "/";
      const body = source.slice(lt + 1, selfClosing ? end - 1 : end);
      const nameEnd = body.search(/\s/);
      const name = nameEnd < 0 ? body : body.slice(0, nameEnd);
      if (!namePattern.test(name)) throw new XmlSyntaxError(`invalid element name "${name}"`, lt);
      if (open.length === 0 && rootSeen) throw new XmlSyntaxError("second root element", lt);
      rootSeen = true;
      handler.open(localName(name), nameEnd < 0 ? {} : parseAttributes(body.slice(nameEnd), lt + 1 + nameEnd));
      if (selfClosing) handler.close(localName(name));
      else open.push(name);
      index = end + 1;
    }
  }
  if (!rootSeen) throw new XmlSyntaxError("no root element", source.length);
  if (open.length > 0) throw new XmlSyntaxError(`<${open[open.length - 1] ?? ""}> is not closed`, source.length, true);
}

/** Decodes a UTF-8 file and reads it, refusing a cut document as `truncated` and any other encoding or syntax error as `malformed`. */
export function readXmlFile(bytes: Uint8Array, handler: XmlHandler): void {
  let source: string;
  try {
    source = decodeUtf8(bytes);
  } catch (error) {
    if (error instanceof InvalidUtf8Error) throw new ImportError("malformed", error.message);
    throw error;
  }
  try {
    parseXml(source, handler);
  } catch (error) {
    if (error instanceof XmlSyntaxError) throw new ImportError(error.truncated ? "truncated" : "malformed", error.message);
    throw error;
  }
}
