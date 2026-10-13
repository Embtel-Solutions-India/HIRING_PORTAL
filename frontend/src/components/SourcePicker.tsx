import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, FolderSearch, Plus, Search, Tag } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCan, useSourceMap, useStore } from "../data/store";
import { cn, tint } from "../lib/utils";

/** Colors offered for sources. Chips show the name, so color is a helper, not the only identity. */
export const SOURCE_COLORS = ["#2a78d6", "#4a3aa7", "#1baf7a", "#e87ba4", "#eda100", "#eb6834", "#008300", "#e34948", "#0f766e", "#9a3412", "#6d28d9", "#be185d", "#4d7c0f", "#a16207", "#1e40af", "#898781"];

/** Special picker value: keep the source detected from each file's Drive sub-folder. */
export const AUTO_SOURCE = "__auto";

export function SourceBadge({ sourceId, className, muted = true }: { sourceId: string; className?: string; muted?: boolean }) {
  const s = useSourceMap()[sourceId];
  if (!s) {
    if (!muted) return null;
    return <span className={cn("inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap text-muted", className)}>No source</span>;
  }
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap", className)} style={{ background: tint(s.color, 0.12) }}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
      <span className="truncate text-ink-2">{s.name}</span>
    </span>
  );
}

/**
 * Pick where a candidate came from. Shows active sources with a search box; people who can manage sources
 * can add a new one right from the menu.
 */
export function SourcePicker({
  value,
  onChange,
  variant = "field",
  allowAuto,
  align = "left",
  disabled,
  className,
  placeholder = "Not specified",
}: {
  value: string;
  onChange: (sourceId: string) => void;
  variant?: "field" | "badge" | "button";
  allowAuto?: boolean;
  align?: "left" | "right";
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const sources = useStore((s) => s.sources);
  const createSource = useStore((s) => s.createSource);
  const canManage = useCan("sources.manage");
  const map = useSourceMap();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setAdding(false);
    setNewName("");
    requestAnimationFrame(() => searchRef.current?.focus());
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [open]);

  const active = sources.filter((s) => s.active || s.id === value);
  const shown = active.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()));
  const current = map[value];
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const add = async () => {
    const name = (newName || q).trim();
    if (!name) return;
    const existing = sources.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) return pick(existing.id);
    const created = await createSource(name, SOURCE_COLORS[sources.length % SOURCE_COLORS.length]!);
    if (created) pick(created.id);
  };

  const label =
    value === AUTO_SOURCE ? (
      <span className="inline-flex items-center gap-1.5 text-ink-2">
        <FolderSearch size={14} className="text-muted" /> From Drive folder name
      </span>
    ) : current ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full" style={{ background: current.color }} />
        <span className="truncate">{current.name}</span>
      </span>
    ) : (
      <span className="text-faint">{placeholder}</span>
    );

  return (
    <div ref={ref} className={cn("relative inline-flex", variant === "field" && "w-full", className)}>
      {variant === "badge" ? (
        <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} className="rounded-full transition hover:ring-2 hover:ring-line disabled:pointer-events-none" aria-label="Change source" title="Change source">
          <SourceBadge sourceId={value} />
        </button>
      ) : variant === "button" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-lime px-2.5 text-[13px] font-semibold text-brand-900 hover:brightness-95 disabled:opacity-45"
        >
          <Tag size={14} /> {placeholder}
        </button>
      ) : (
        <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} className="field flex h-9 items-center justify-between gap-2 py-0 text-left font-medium disabled:opacity-50" aria-label="Source">
          {label}
          <ChevronDown size={15} className="shrink-0 text-muted" />
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className={cn("absolute top-full z-40 mt-1.5 w-[250px] rounded-xl border border-line bg-surface p-1 shadow-pop", align === "right" ? "right-0" : "left-0")}
            role="listbox"
          >
            <div className="relative mb-1">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (shown[0]) pick(shown[0].id);
                    else if (canManage && q.trim()) void add();
                  }
                }}
                placeholder="Search sources…"
                className="h-8 w-full rounded-lg bg-paper pr-2 pl-7 text-[13px] outline-none placeholder:text-faint"
              />
            </div>
            <div className="scroll-slim max-h-[260px] overflow-y-auto">
              {allowAuto && !q && <Option active={value === AUTO_SOURCE} onClick={() => pick(AUTO_SOURCE)} icon={<FolderSearch size={13} className="text-muted" />} label="From Drive folder name" hint="e.g. …/Case Manager/LinkedIn/" />}
              {!q && <Option active={!value} onClick={() => pick("")} icon={<span className="size-2 rounded-full border border-dashed border-faint" />} label="Not specified" />}
              {shown.map((s) => (
                <Option key={s.id} active={s.id === value} onClick={() => pick(s.id)} icon={<span className="size-2 rounded-full" style={{ background: s.color }} />} label={s.name} />
              ))}
              {q && !shown.length && !canManage && <p className="px-2.5 py-2 text-[12px] text-muted">No source called “{q}”. Ask an admin to add it.</p>}
            </div>
            {canManage && (
              <div className="mt-1 border-t border-line pt-1">
                {adding || (q && !shown.some((s) => s.name.toLowerCase() === q.trim().toLowerCase())) ? (
                  <form
                    className="flex items-center gap-1 p-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void add();
                    }}
                  >
                    <input
                      autoFocus={adding}
                      value={adding ? newName : q}
                      onChange={(e) => (adding ? setNewName(e.target.value) : setQ(e.target.value))}
                      placeholder="New source, e.g. Naukri"
                      maxLength={40}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-line px-2 text-[13px] outline-none focus:border-brand-500"
                    />
                    <button type="submit" className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand-700 px-2 text-[12px] font-semibold text-white hover:bg-brand-800">
                      <Plus size={13} /> Add
                    </button>
                  </form>
                ) : (
                  <button type="button" onClick={() => setAdding(true)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-brand-700 hover:bg-brand-50">
                    <Plus size={14} /> Add a new source
                  </button>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Option({ active, onClick, icon, label, hint }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; hint?: string }) {
  return (
    <button type="button" role="option" aria-selected={active} onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium text-ink-2 hover:bg-sunken hover:text-ink", active && "bg-sunken text-ink")}>
      <span className="flex w-3 justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-[11px] font-normal text-muted">{hint}</span>}
      </span>
      {active && <Check size={14} className="text-brand-600" />}
    </button>
  );
}
