import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, CircleAlert, CircleCheck, Info, Star, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useStore } from "../data/store";
import type { Stage, TeamMember } from "../types";
import { cn, initials, tint } from "../lib/utils";

/* ---------------- Button ---------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "lime";
type ButtonSize = "sm" | "md" | "lg";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }
>(({ variant = "secondary", size = "md", icon, className, children, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-semibold whitespace-nowrap transition active:translate-y-px disabled:pointer-events-none disabled:opacity-45",
      size === "sm" && "h-8 px-2.5 text-[13px]",
      size === "md" && "h-9 px-3.5 text-sm",
      size === "lg" && "h-11 px-5 text-[15px]",
      variant === "primary" && "bg-brand-700 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-brand-800",
      variant === "lime" && "bg-lime text-brand-900 hover:brightness-95",
      variant === "secondary" && "border border-line bg-surface text-ink shadow-card hover:border-line-strong hover:bg-paper",
      variant === "ghost" && "text-ink-2 hover:bg-sunken hover:text-ink",
      variant === "danger" && "bg-danger text-white hover:brightness-95",
      className,
    )}
    {...props}
  >
    {icon}
    {children}
  </button>
));
Button.displayName = "Button";

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-sunken hover:text-ink disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------------- Badges ---------------- */

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "lime" | "warn" | "danger" | "info";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        tone === "neutral" && "bg-sunken text-ink-2",
        tone === "brand" && "bg-brand-50 text-brand-700",
        tone === "lime" && "bg-lime-soft text-brand-800",
        tone === "warn" && "bg-amber-50 text-amber-800",
        tone === "danger" && "bg-rose-50 text-rose-700",
        tone === "info" && "bg-sky-50 text-sky-800",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StageBadge({ stage, className }: { stage?: Stage; className?: string }) {
  if (!stage) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap", className)}
      style={{ background: tint(stage.color, 0.1) }}
    >
      <span className="size-2 rounded-full" style={{ background: stage.color }} />
      <span className="text-ink-2">{stage.name}</span>
    </span>
  );
}

/* ---------------- Avatars ---------------- */

export function Avatar({
  name,
  color,
  size = 32,
  className,
}: {
  name: string;
  color?: string;
  size?: number;
  className?: string;
}) {
  // Candidate avatars get a deterministic soft color from their name.
  const fallback = ["#e8efe9", "#efe8de", "#e6eaf3", "#f1e6ea", "#e9e6f3", "#e3f0ee"][
    [...name].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 6
  ];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-bold select-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.38),
        background: color ?? fallback,
        color: color ? "#fff" : "#2a2925",
      }}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ members, size = 24 }: { members: TeamMember[]; size?: number }) {
  return (
    <span className="flex -space-x-1.5">
      {members.map((m) => (
        <span key={m.id} title={m.name} className="rounded-full ring-2 ring-surface">
          <Avatar name={m.name} color={m.avatarColor} size={size} />
        </span>
      ))}
    </span>
  );
}

/* ---------------- Stars & score ---------------- */

export function Stars({ value, onChange, size = 14 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role={onChange ? "radiogroup" : undefined} aria-label={`Rating ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(n === value ? 0 : n);
          }}
          className={cn("disabled:cursor-default", onChange && "transition hover:scale-110")}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
        >
          <Star size={size} className={n <= value ? "fill-amber-400 text-amber-400" : "text-line-strong"} strokeWidth={2} />
        </button>
      ))}
    </span>
  );
}

export function MatchScore({ score, size = 44 }: { score: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? "#22663f" : score >= 70 ? "#7a9a1f" : "#b7791f";
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} title={`${score}% match`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-sunken)" strokeWidth={4} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (score / 100) * c}
        />
      </svg>
      <span className="tabular absolute font-bold" style={{ fontSize: size * 0.3, color }}>
        {score}
      </span>
    </span>
  );
}

/* ---------------- Form bits ---------------- */

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field h-9 appearance-none py-0 pr-8 font-medium"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition", checked ? "bg-brand-600" : "bg-line-strong")}
    >
      <span className={cn("size-4 rounded-full bg-white shadow transition", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Checkbox({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label: string; indeterminate?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition",
        checked || indeterminate ? "border-brand-700 bg-brand-700 text-white" : "border-line-strong bg-surface hover:border-brand-500",
      )}
    >
      {checked && <Check size={11} strokeWidth={3.5} />}
      {!checked && indeterminate && <span className="h-0.5 w-2 rounded bg-white" />}
    </button>
  );
}

/* ---------------- Tabs ---------------- */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 overflow-x-auto border-b border-line scroll-slim", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition",
            value === t.value ? "border-brand-700 text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className={cn("tabular rounded px-1.5 text-[11px]", value === t.value ? "bg-brand-50 text-brand-700" : "bg-sunken text-muted")}>
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-semibold transition",
            value === o.value ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Modal & Drawer ---------------- */

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEscape(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-ink/35 backdrop-blur-[2px]" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", damping: 28, stiffness: 380 }}
            className="relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-surface shadow-pop sm:rounded-2xl"
            style={{ maxWidth: width }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <h2 className="text-[17px] font-bold tracking-tight">{title}</h2>
                {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
              </div>
              <IconButton label="Close" onClick={onClose} className="-mr-1.5">
                <X size={18} />
              </IconButton>
            </div>
            <div className="scroll-slim overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-paper/60 px-5 py-3 sm:rounded-b-2xl">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Drawer({ open, onClose, children, width = 720, label }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; label: string }) {
  useEscape(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-ink/25" onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-label={label}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 320 }}
            className="absolute inset-y-0 right-0 flex w-full flex-col bg-paper shadow-pop"
            style={{ maxWidth: width }}
          >
            {children}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ---------------- Menu (dropdown) ---------------- */

export function Menu({
  trigger,
  children,
  align = "left",
  width = 220,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className={cn("absolute top-full z-30 mt-1.5 rounded-xl border border-line bg-surface p-1 shadow-pop", align === "right" ? "right-0" : "left-0")}
            style={{ width }}
            role="menu"
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  icon,
  active,
  danger,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  icon?: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition disabled:opacity-40",
        danger ? "text-danger hover:bg-rose-50" : "text-ink-2 hover:bg-sunken hover:text-ink",
        active && "bg-sunken text-ink",
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {active && <Check size={14} className="text-brand-600" />}
    </button>
  );
}

/* ---------------- Layout helpers ---------------- */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-sunken text-muted">{icon}</div>
      <p className="font-bold">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Locked({ children, reason = "Your role can't do this" }: { children: ReactNode; reason?: string }) {
  return (
    <span title={reason} className="cursor-not-allowed opacity-50 [&>*]:pointer-events-none">
      {children}
    </span>
  );
}

/* ---------------- Toasts ---------------- */

export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            className="pointer-events-auto flex items-center gap-2.5 rounded-xl bg-ink py-2.5 pr-2 pl-3.5 text-sm font-medium text-white shadow-pop"
          >
            {t.tone === "success" && <CircleCheck size={16} className="text-lime" />}
            {t.tone === "info" && <Info size={16} className="text-sky-300" />}
            {t.tone === "error" && <CircleAlert size={16} className="text-rose-300" />}
            <span>{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="ml-1 rounded-md px-2 py-1 font-semibold text-lime hover:bg-white/10"
              >
                {t.action.label}
              </button>
            )}
            <button onClick={() => dismiss(t.id)} className="rounded-md p-1 text-white/50 hover:text-white" aria-label="Dismiss">
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

/* ---------------- Brand marks ---------------- */

export function GoogleMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function DriveMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 87.3 78" aria-hidden>
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47" />
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
    </svg>
  );
}

export function CalendarMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#4285F4" strokeWidth="2" />
      <rect x="3" y="3" width="18" height="5" rx="2" fill="#4285F4" />
      <text x="12" y="18.5" textAnchor="middle" fontSize="9" fontWeight="700" fill="#4285F4" fontFamily="system-ui">
        31
      </text>
    </svg>
  );
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-8 items-center justify-center rounded-[9px] bg-brand-800 text-lime shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M3.5 2.5v11M12.5 2.5v11M3.5 8h9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
      {!compact && <span className="text-[17px] font-extrabold tracking-tight">Hirely</span>}
    </span>
  );
}
