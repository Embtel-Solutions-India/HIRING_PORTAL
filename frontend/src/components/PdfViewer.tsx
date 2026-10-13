import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

// pdf.js is large, so it's loaded on first use. Documents are cached so flipping between candidates is instant.
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
const loadPdfjs = () =>
  (pdfjsPromise ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  }));

const docs = new Map<string, Promise<PDFDocumentProxy>>();

export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let p = docs.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Couldn't load resume (${res.status})`);
      const lib = await loadPdfjs();
      return lib.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
    })();
    p.catch(() => docs.delete(url));
    docs.set(url, p);
    if (docs.size > 30) docs.delete(docs.keys().next().value!);
  }
  return p;
}

/** Warm the cache for a resume the person is likely to open next. */
export const prefetchPdf = (url: string) => void loadPdf(url).catch(() => {});

export function PdfViewer({ url, onError }: { url: string; onError: (message: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const host = ref.current;
    if (!host) return;
    setLoading(true);
    host.replaceChildren();

    const render = async () => {
      try {
        const doc = await loadPdf(url);
        if (cancelled) return;
        const width = host.clientWidth || 640;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= Math.min(doc.numPages, 15); n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = "100%";
          canvas.style.display = "block";
          canvas.className = "resume-paper mb-3 rounded-sm bg-white";
          host.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
          if (n === 1 && !cancelled) setLoading(false);
        }
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : "Couldn't display this PDF");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [url, onError]);

  return (
    <div className="relative mx-auto max-w-[720px]">
      {loading && (
        <div className="absolute inset-x-0 top-0 flex flex-col items-center gap-2 py-16 text-sm text-muted">
          <Loader2 className="animate-spin" /> Loading resume…
        </div>
      )}
      <div ref={ref} />
    </div>
  );
}
