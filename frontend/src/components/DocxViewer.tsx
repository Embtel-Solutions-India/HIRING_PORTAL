import DOMPurify from "dompurify";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

const cache = new Map<string, Promise<string>>();

function loadHtml(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url, { credentials: "same-origin" }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Couldn't load resume (${r.status})`);
      return DOMPurify.sanitize(await r.text(), { FORBID_TAGS: ["style", "form", "input"], FORBID_ATTR: ["style"] });
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export const prefetchDocx = (url: string) => void loadHtml(url).catch(() => {});

/** Word resumes, converted to HTML on the server and sanitized here (rendered inline so keyboard + swipe keep working). */
export function DocxViewer({ url, onError }: { url: string; onError: (message: string) => void }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    loadHtml(url)
      .then((h) => !cancelled && setHtml(h))
      .catch((e) => !cancelled && onError(e instanceof Error ? e.message : "Couldn't display this file"));
    return () => {
      cancelled = true;
    };
  }, [url, onError]);

  if (html === null)
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted">
        <Loader2 className="animate-spin" /> Loading resume…
      </div>
    );
  return (
    <article
      className="resume-paper mx-auto max-w-[720px] rounded-sm px-7 py-8 text-[14px] leading-relaxed text-[#222] sm:px-10 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-2 [&_table]:w-full [&_td]:align-top"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
