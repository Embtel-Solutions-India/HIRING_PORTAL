import { AnimatePresence, motion } from "motion/react";
import {
  Briefcase,
  CalendarClock,
  ChevronDown,
  Columns3,
  Hand,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu as MenuIcon,
  Search,
  Settings,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useCurrentUser, useJobMap, useLatestAppMap, useSourceMap, useStageMap, useStore } from "../data/store";
import { can, ROLE_LABEL, type Permission } from "../lib/permissions";
import { cn, fullName } from "../lib/utils";
import { RejectDialog } from "./RejectDialog";
import { Avatar, Badge, Logo, Menu, MenuItem, StageBadge, Toaster } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: Permission;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <LayoutDashboard size={18} />, end: true },
  { to: "/pipeline", label: "Pipeline", icon: <Columns3 size={18} /> },
  { to: "/candidates", label: "Candidates", icon: <Users size={18} /> },
  { to: "/review", label: "Swipe review", icon: <Hand size={18} /> },
  { to: "/interviews", label: "Interviews", icon: <CalendarClock size={18} /> },
  { to: "/email", label: "Email", icon: <Mail size={18} />, permission: "emails.sendSingle" },
  { to: "/jobs", label: "Jobs", icon: <Briefcase size={18} /> },
  { to: "/team", label: "Team", icon: <UserCog size={18} />, permission: "users.view" },
  { to: "/settings", label: "Settings", icon: <Settings size={18} />, permission: "sources.manage" },
];

export function AppShell() {
  const user = useCurrentUser();
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMoreOpen(false), [location.pathname]);

  if (!user) return null;
  const items = NAV.filter((n) => !n.permission || can(user.role, n.permission));

  return (
    <div className="flex min-h-full">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-line bg-paper px-3 py-4 lg:flex">
        <div className="px-2 pb-5">
          <Logo />
        </div>
        <nav className="flex flex-1 flex-col gap-0.5">
          {items.map((n) => (
            <SideLink key={n.to} item={n} />
          ))}
        </nav>
        <SidebarFooter />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMenu={() => setMoreOpen(true)} />
        <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 pt-5 pb-28 sm:px-6 lg:px-8 lg:pb-10">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),8px)] backdrop-blur lg:hidden">
        <BottomLink to="/" end icon={<LayoutDashboard size={20} />} label="Home" />
        <BottomLink to="/pipeline" icon={<Columns3 size={20} />} label="Pipeline" />
        <NavLink to="/review" className="flex flex-col items-center">
          {({ isActive }) => (
            <>
              <span className={cn("-mt-5 flex size-12 items-center justify-center rounded-2xl shadow-lift transition", isActive ? "bg-brand-800 text-lime" : "bg-lime text-brand-900")}>
                <Hand size={22} />
              </span>
              <span className="mt-0.5 text-[10px] font-semibold text-ink-2">Review</span>
            </>
          )}
        </NavLink>
        <BottomLink to="/interviews" icon={<CalendarClock size={20} />} label="Interviews" />
        <button onClick={() => setMoreOpen(true)} className="flex flex-col items-center gap-0.5 py-1 text-muted">
          <MenuIcon size={20} />
          <span className="text-[10px] font-semibold">More</span>
        </button>
      </nav>

      {/* Mobile nav sheet */}
      <AnimatePresence>
        {moreOpen && (
          <motion.div className="fixed inset-0 z-40 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-ink/30" onClick={() => setMoreOpen(false)} />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 320 }}
              className="absolute inset-y-0 left-0 flex w-[280px] flex-col bg-paper px-3 py-4 shadow-pop"
            >
              <div className="flex items-center justify-between px-2 pb-5">
                <Logo />
                <button onClick={() => setMoreOpen(false)} className="rounded-lg p-1.5 text-muted hover:bg-sunken" aria-label="Close menu">
                  <X size={18} />
                </button>
              </div>
              <nav className="flex flex-1 flex-col gap-0.5">
                {items.map((n) => (
                  <SideLink key={n.to} item={n} />
                ))}
              </nav>
              <SidebarFooter />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <Toaster />
      <RejectDialog />
    </div>
  );
}

function SideLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-semibold transition",
          isActive ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-2 hover:bg-sunken hover:text-ink",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn("transition", isActive ? "text-brand-600" : "text-muted group-hover:text-ink-2")}>{item.icon}</span>
          {item.label}
          {item.to === "/review" && <span className="ml-auto rounded bg-lime px-1.5 text-[10px] font-bold text-brand-900">NEW</span>}
        </>
      )}
    </NavLink>
  );
}

function BottomLink({ to, icon, label, end }: { to: string; icon: ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-1", isActive ? "text-brand-700" : "text-muted")}>
      {icon}
      <span className="text-[10px] font-semibold">{label}</span>
    </NavLink>
  );
}

function SidebarFooter() {
  const settings = useStore((s) => s.settings);
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-ink-2">
        <span className={cn("size-2 rounded-full", settings.google.connected ? "bg-brand-500" : "bg-faint")} />
        Google Workspace {settings.google.connected ? "connected" : "not connected"}
      </div>
      <p className="mt-1 truncate text-[11px] text-muted">{settings.google.connected ? `Drive · ${settings.google.driveRootFolder}` : "Resumes stored on the server"}</p>
    </div>
  );
}

function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const user = useCurrentUser()!;
  const logout = useStore((s) => s.logout);
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-paper/90 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button onClick={onOpenMenu} className="-ml-1 rounded-lg p-1.5 text-ink-2 hover:bg-sunken lg:hidden" aria-label="Open menu">
        <MenuIcon size={20} />
      </button>
      <span className="lg:hidden">
        <Logo compact />
      </span>
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-2">
        <Menu
          align="right"
          width={230}
          trigger={({ toggle }) => (
            <button onClick={toggle} className="flex items-center gap-2 rounded-full p-0.5 pr-1.5 hover:bg-sunken" aria-label="Account menu">
              <Avatar name={user.name} color={user.avatarColor} size={30} />
              <ChevronDown size={14} className="hidden text-muted sm:block" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 py-2">
                <p className="text-sm font-bold">{user.name}</p>
                <p className="text-xs text-muted">{user.email}</p>
                <Badge tone={user.role === "super_admin" ? "lime" : user.role === "admin" ? "brand" : "neutral"} className="mt-1.5">
                  {ROLE_LABEL[user.role]}
                </Badge>
              </div>
              <div className="my-1 h-px bg-line" />
              <MenuItem
                icon={<LogOut size={15} />}
                onClick={async () => {
                  close();
                  await logout();
                  navigate("/login");
                }}
              >
                Sign out
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </header>
  );
}

function GlobalSearch() {
  const candidates = useStore((s) => s.candidates);
  const latest = useLatestAppMap();
  const stageMap = useStageMap();
  const jobMap = useJobMap();
  const sourceMap = useSourceMap();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return candidates
      .filter((c) =>
        [fullName(c), c.email, c.currentTitle, c.currentCompany, jobMap[latest[c.id]?.jobId ?? ""]?.title ?? "", sourceMap[c.sourceId]?.name ?? "", ...c.skills].join(" ").toLowerCase().includes(term),
      )
      .slice(0, 7);
  }, [q, candidates, jobMap, sourceMap, latest]);

  const go = (id: string) => {
    navigate(`/candidates/${id}`);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="relative max-w-md flex-1">
      <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          if (e.key === "Enter" && results[active]) go(results[active].id);
          if (e.key === "Escape") inputRef.current?.blur();
        }}
        placeholder="Search candidates, skills, jobs…"
        className="h-9 w-full rounded-lg border border-line bg-surface pr-12 pl-9 text-sm outline-none placeholder:text-faint focus:border-brand-500 focus:ring-3 focus:ring-brand-100"
        aria-label="Search candidates"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-line bg-paper px-1.5 text-[10px] font-semibold text-muted sm:block">⌘K</kbd>
      {open && q && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1.5 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">No candidates match “{q}”</p>
          ) : (
            results.map((c, i) => (
              <button
                key={c.id}
                onMouseDown={() => go(c.id)}
                onMouseEnter={() => setActive(i)}
                className={cn("flex w-full items-center gap-3 px-3 py-2 text-left", i === active && "bg-sunken")}
              >
                <Avatar name={fullName(c)} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{fullName(c)}</span>
                  <span className="block truncate text-xs text-muted">
                    {c.currentTitle} · {jobMap[latest[c.id]?.jobId ?? ""]?.title}
                  </span>
                </span>
                <StageBadge stage={stageMap[latest[c.id]?.stageId ?? ""]} />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
