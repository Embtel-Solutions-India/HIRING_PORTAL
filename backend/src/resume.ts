import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export async function extractResumeText(data: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return normalize(Array.isArray(text) ? text.join("\n") : text);
  }
  if (mimeType.includes("wordprocessingml")) {
    const { value } = await mammoth.extractRawText({ buffer: data });
    return normalize(value);
  }
  return "";
}

/** HTML rendering of a .docx for the in-app preview (browsers can't show Word files). */
export async function docxToHtml(data: Buffer): Promise<string> {
  const { value } = await mammoth.convertToHtml({ buffer: data });
  return value;
}

const normalize = (s: string) =>
  s
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Best-effort details without AI: used as a fallback and to pre-fill while AI runs. */
export function basicParse(text: string, fileName: string) {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
  const phone = text.match(/(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? "";
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => /^[A-Za-z][A-Za-z.'\- ]{2,40}$/.test(l) && l.split(" ").length <= 4);
  const fromFile = fileName
    .replace(/\.(pdf|docx?)$/i, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\b(cv|resume|curriculum vitae|final|updated|v\d+|20\d\d)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = (firstLine ?? fromFile) || "New Candidate";
  const [firstName = "New", ...rest] = name.split(" ");
  return { firstName, lastName: rest.join(" "), email, phone };
}
