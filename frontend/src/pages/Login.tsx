import { CircleAlert, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Button, GoogleMark, Logo } from "../components/ui";
import { useStore } from "../data/store";
import { api, errorMessage } from "../lib/api";

interface AuthConfig {
  googleConfigured: boolean;
  devLogin: boolean;
  orgName: string;
  emailDomain: string;
}

const ERRORS: Record<string, string> = {
  not_invited: "isn't on the team yet. Ask an admin to invite you, then try again.",
  deactivated: "has been deactivated. Ask an admin if you need access again.",
  wrong_domain: "isn't on the team. Sign in with your work Google account, or ask an admin to invite this address.",
  unverified: "Your Google email address isn't verified.",
  access_denied: "Google sign-in was cancelled.",
  cancelled: "Google sign-in was cancelled.",
};

export default function Login() {
  const [params] = useSearchParams();
  const status = useStore((s) => s.status);
  const init = useStore((s) => s.init);
  const navigate = useNavigate();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [devEmail, setDevEmail] = useState("");
  const [devError, setDevError] = useState("");
  const returnTo = params.get("returnTo") ?? "/";
  const error = params.get("error");
  const errorEmail = params.get("email");

  useEffect(() => {
    api.get<AuthConfig>("/api/auth/config").then(setCfg).catch(() => setCfg({ googleConfigured: false, devLogin: false, orgName: "", emailDomain: "" }));
    if (status === "loading") void init();
  }, [status, init]);

  if (status === "ready") return <Navigate to={returnTo.startsWith("/") ? returnTo : "/"} replace />;

  const errorText = error ? (errorEmail && ["not_invited", "deactivated", "wrong_domain"].includes(error) ? `${errorEmail} ${ERRORS[error]}` : (ERRORS[error] ?? `Sign-in failed (${error}).`)) : "";

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-brand-900 p-12 text-white lg:flex lg:flex-col">
        <div className="[&_span]:text-white">
          <Logo />
        </div>
        <div className="mt-auto max-w-md">
          <p className="text-[13px] font-semibold tracking-[0.12em] text-lime uppercase">Internal hiring workspace</p>
          <h1 className="mt-3 text-[44px] leading-[1.05] font-extrabold tracking-[-0.03em]">
            Every resume, every stage, <span className="text-lime">one pipeline.</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70">Resumes live in your Google Drive. Interviews land on Google Calendar. Updates go out from your own domain.</p>
        </div>
        <div className="pointer-events-none absolute -top-32 -right-32 size-[420px] rounded-full bg-lime/10 blur-3xl" />
      </section>

      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-[400px]">
          <div className="lg:hidden">
            <Logo />
          </div>
          <h2 className="mt-8 text-[28px] font-extrabold tracking-tight lg:mt-0">Sign in</h2>
          <p className="mt-1 text-sm text-muted">Use your work Google account{cfg?.orgName && cfg.orgName !== "Your Company" ? ` at ${cfg.orgName}` : ""}.</p>

          {errorText && (
            <p className="mt-5 flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[13px] font-medium text-rose-800">
              <CircleAlert size={16} className="mt-0.5 shrink-0" /> {errorText}
            </p>
          )}

          <a
            href={`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`}
            aria-disabled={!cfg?.googleConfigured}
            className={
              "mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-line bg-surface text-[15px] font-semibold shadow-card transition hover:border-line-strong hover:shadow-pop " +
              (cfg && !cfg.googleConfigured ? "pointer-events-none opacity-50" : "")
            }
          >
            <GoogleMark size={20} /> Continue with Google
          </a>
          <p className="mt-2.5 flex items-center justify-center gap-1.5 text-center text-xs text-muted">
            <Lock size={12} /> Only people invited by an admin
          </p>
          {cfg && !cfg.googleConfigured && (
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Google sign-in isn't configured on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). See DEPLOY.md.</p>
          )}

          {cfg?.devLogin && (
            <form
              className="mt-8 rounded-xl border border-dashed border-line-strong p-4"
              onSubmit={async (e) => {
                e.preventDefault();
                setDevError("");
                try {
                  await api.post("/api/auth/dev-login", { email: devEmail });
                  await useStore.getState().refresh();
                  navigate(returnTo, { replace: true });
                } catch (err) {
                  setDevError(errorMessage(err));
                }
              }}
            >
              <p className="text-[12px] font-semibold text-muted">Development sign-in (disabled in production)</p>
              <div className="mt-2 flex gap-2">
                <input value={devEmail} onChange={(e) => setDevEmail(e.target.value)} type="email" required placeholder="invited email" className="field h-9" aria-label="Email" />
                <Button type="submit">Sign in</Button>
              </div>
              {devError && <p className="mt-2 text-xs text-danger">{devError}</p>}
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
