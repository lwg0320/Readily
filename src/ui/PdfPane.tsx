// Shows one page of a PDF and tries to highlight a quote on it (ARCHITECTURE.md §10.3).
// Opening the right page is the requirement; the highlight is best effort.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { Button, Icon } from "./bits";
import { findQuote } from "./findQuote";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const documents = new Map<string, Promise<pdfjs.PDFDocumentProxy>>();
function open(url: string): Promise<pdfjs.PDFDocumentProxy> {
  let doc = documents.get(url);
  if (!doc) {
    doc = pdfjs.getDocument({ url }).promise;
    doc.catch(() => documents.delete(url));
    documents.set(url, doc);
    // keep only the few most recent documents in memory
    if (documents.size > 4) {
      const oldest = documents.keys().next().value!;
      void documents.get(oldest)?.then((d) => d.destroy()).catch(() => {});
      documents.delete(oldest);
    }
  }
  return doc;
}

export type PdfTarget = { url: string; label: string; page: number; quote?: string };

export function PdfPane({ target }: { target: PdfTarget }) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(target.page);
  const [pages, setPages] = useState(0);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [found, setFound] = useState<boolean | null>(null);

  useEffect(() => setPage(target.page), [target]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let timer = 0;
    const measure = () => setWidth(Math.max(320, Math.floor(el.clientWidth - 32)));
    measure();
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!width) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    setState("loading");
    setFound(null);

    (async () => {
      const doc = await open(target.url);
      if (cancelled) return;
      setPages(doc.numPages);
      const pdfPage = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
      if (cancelled || !canvas.current || !layer.current) return;

      const scale = width / pdfPage.getViewport({ scale: 1 }).width;
      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = canvas.current;
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      c.style.width = `${viewport.width}px`;
      c.style.height = `${viewport.height}px`;
      renderTask = pdfPage.render({ canvasContext: c.getContext("2d")!, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;

      const l = layer.current;
      l.replaceChildren();
      l.style.setProperty("--scale-factor", String(scale));
      textLayer = new pdfjs.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: l, viewport });
      await textLayer.render();
      if (cancelled) return;

      const showingTheQuote = target.quote && page === target.page;
      if (showingTheQuote) {
        const hits = findQuote(textLayer.textContentItemsStr, target.quote!);
        hits.forEach((i) => textLayer!.textDivs[i]?.classList.add("quote-hit"));
        setFound(hits.length > 0);
        const first = textLayer.textDivs[hits[0]];
        if (first && scroller.current) scroller.current.scrollTop = Math.max(0, first.offsetTop - scroller.current.clientHeight / 3);
      } else if (scroller.current) scroller.current.scrollTop = 0;
      setState("ready");
    })().catch((err) => {
      if (cancelled || err?.name === "RenderingCancelledException") return;
      console.error(err);
      setState("failed");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [target, page, width]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#dfe4e9]">
      <div className="flex shrink-0 items-center gap-3 border-b border-rule bg-paper px-4 py-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-semibold" title={target.label}>
          {target.label}
        </span>
        <div className="flex items-center gap-1">
          <Button kind="quiet" className="!px-1.5 !py-1" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page">
            <Icon name="left" />
          </Button>
          <span className="tabular-nums text-ink-soft">
            Page {page}
            {pages ? ` of ${pages}` : ""}
          </span>
          <Button kind="quiet" className="!px-1.5 !py-1" onClick={() => setPage((p) => (pages ? Math.min(pages, p + 1) : p + 1))} disabled={!!pages && page >= pages} aria-label="Next page">
            <Icon name="right" />
          </Button>
        </div>
        {page !== target.page && (
          <Button kind="quiet" className="!px-2 !py-1" onClick={() => setPage(target.page)}>
            Back to page {target.page}
          </Button>
        )}
        <a href={`${target.url}#page=${page}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-stamp">
          <Icon name="external" />
          Open PDF
        </a>
      </div>
      {target.quote && page === target.page && found === false && state === "ready" && (
        <p className="shrink-0 border-b border-rule bg-marker-soft px-4 py-1.5 text-[13px]">The quote is on this page. It could not be highlighted automatically.</p>
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-4">
        {state === "failed" ? (
          <p className="rounded bg-paper p-4 text-[14px]">
            This PDF could not be shown here.{" "}
            <a href={`${target.url}#page=${page}`} target="_blank" rel="noreferrer" className="font-semibold text-stamp">
              Open it in a new tab
            </a>
            .
          </p>
        ) : (
          <div className="relative mx-auto bg-white shadow-sm" style={{ width, opacity: state === "loading" ? 0.5 : 1 }}>
            <canvas ref={canvas} className="block" />
            <div ref={layer} className="textLayer" />
          </div>
        )}
      </div>
    </div>
  );
}
