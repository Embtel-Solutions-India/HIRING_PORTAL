/**
 * App state, loaded from the API (`GET /api/bootstrap`) and kept fresh by polling so everyone on the team
 * sees the same pipeline. Actions call the API, apply an optimistic update where it makes the UI feel instant,
 * then re-sync from the server. On failure they show an error toast and re-sync (which undoes the optimistic change).
 */
import { useMemo } from "react";
import { create } from "zustand";
import type {
  ActivityEvent,
  Application,
  BookingLink,
  Candidate,
  CandidateHistory,
  DriveInboxFile,
  EmailCampaign,
  EmailTemplate,
  Interview,
  InterviewType,
  Job,
  OrgSettings,
  RejectionReason,
  Role,
  Source,
  Stage,
  TeamMember,
} from "../types";
import { api, ApiError, errorMessage } from "../lib/api";
import { can, type Permission } from "../lib/permissions";

export interface Toast {
  id: string;
  message: string;
  tone: "success" | "info" | "error";
  action?: { label: string; onClick: () => void };
}

interface Data {
  currentUserId: string | null;
  team: TeamMember[];
  stages: Stage[];
  sources: Source[];
  jobs: Job[];
  candidates: Candidate[];
  applications: Application[];
  rejectionReasons: RejectionReason[];
  interviews: Interview[];
  bookingLinks: BookingLink[];
  templates: EmailTemplate[];
  campaigns: EmailCampaign[];
  activity: ActivityEvent[];
  settings: OrgSettings;
  driveInbox: DriveInboxFile[];
}

interface Bootstrap extends Omit<Data, "currentUserId"> {
  me: TeamMember;
}

export interface NewInterviewInput {
  applicationId: string;
  title: string;
  type: InterviewType;
  start: string;
  durationMin: number;
  interviewerIds: string[];
  location?: string;
}

interface Actions {
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  startSync: () => () => void;
  logout: () => Promise<void>;
  toast: (message: string, tone?: Toast["tone"], action?: Toast["action"]) => void;
  dismissToast: (id: string) => void;

  moveStage: (applicationIds: string[], stageId: string, opts?: { notify?: boolean; reasonId?: string; note?: string }) => Promise<boolean>;
  /** Moves cards; a closed target stage first asks for a reason. Resolves false if the user cancels. */
  requestMove: (applicationIds: string[], stageId: string, opts?: { notify?: boolean }) => Promise<boolean>;
  resolveRejectPrompt: (choice: { reasonId: string; note: string } | null) => void;
  addNote: (candidateId: string, body: string, applicationId?: string) => Promise<boolean>;
  setRating: (applicationId: string, rating: number) => Promise<boolean>;
  toggleStar: (applicationId: string) => Promise<boolean>;
  deleteCandidates: (ids: string[]) => Promise<boolean>;
  resummarize: (applicationId: string) => Promise<boolean>;
  /** Not kept in the store: the profile page loads it on its own. */
  fetchHistory: (candidateId: string) => Promise<CandidateHistory | null>;
  uploadResumes: (files: File[], jobId: string, sourceId: string) => Promise<{ created: string[]; rejected: string[] } | null>;
  replaceResume: (candidateId: string, file: File) => Promise<boolean>;
  renameResume: (candidateId: string, fileName: string) => Promise<boolean>;
  /** `sourceId` undefined = use the source detected from each file's Drive folder. */
  importFromDrive: (fileIds: string[], jobId: string, sourceId?: string) => Promise<number | null>;
  setCandidateSource: (candidateIds: string[], sourceId: string) => Promise<boolean>;
  createSource: (name: string, color: string) => Promise<Source | null>;
  updateSource: (id: string, patch: Partial<Pick<Source, "name" | "color" | "active">>) => Promise<boolean>;
  deleteSource: (id: string) => Promise<boolean>;
  reorderSources: (ids: string[]) => Promise<boolean>;
  createSourceFolders: () => Promise<{ jobs: number; folders: number } | null>;
  ignoreDriveFiles: (fileIds: string[]) => Promise<boolean>;
  syncDrive: () => Promise<{ found: number; imported: number } | null>;

  scheduleInterview: (input: NewInterviewInput, opts?: { notify?: boolean }) => Promise<boolean>;
  updateInterview: (id: string, patch: { status: Interview["status"] }) => Promise<boolean>;
  addFeedback: (id: string, feedback: { recommendation: "strong_yes" | "yes" | "no" | "strong_no"; comment: string }) => Promise<boolean>;
  upsertBookingLink: (link: BookingLink) => Promise<boolean>;
  deleteBookingLink: (id: string) => Promise<boolean>;

  sendEmail: (input: { recipientIds: string[]; subject: string; body: string; templateId?: string; scheduledAt?: string }) => Promise<boolean>;
  upsertTemplate: (t: EmailTemplate) => Promise<boolean>;
  deleteTemplate: (id: string) => Promise<boolean>;

  upsertJob: (job: Job & { description?: string }) => Promise<boolean>;
  deleteJob: (id: string) => Promise<boolean>;

  /** null if the invite wasn't saved; `emailError` if it was saved but the email didn't go out. */
  inviteUser: (input: { name: string; email: string; role: Role; title: string }) => Promise<{ emailError?: string } | null>;
  updateUser: (id: string, patch: Partial<Pick<TeamMember, "role" | "status" | "title" | "name">>) => Promise<boolean>;
  resendInvite: (id: string) => Promise<boolean>;
  deleteUser: (id: string) => Promise<boolean>;

  setStages: (stages: Stage[]) => Promise<boolean>;
  saveRejectionReasons: (reasons: { id?: string; label: string; active: boolean }[]) => Promise<boolean>;
  updateSettings: (patch: Partial<Omit<OrgSettings, "google" | "dnsRecords" | "system">> & { google?: Partial<OrgSettings["google"]> }) => Promise<boolean>;
  disconnectGoogle: () => Promise<boolean>;
  verifyEmailDomain: () => Promise<boolean>;
  sendTestEmail: () => Promise<boolean>;
}

/** Open while the user picks a reason for moving cards into a closed stage. */
export interface RejectPrompt {
  applicationIds: string[];
  stageId: string;
  notify: boolean;
  resolve: (moved: boolean) => void;
}

export type Store = Data & Actions & { status: "loading" | "anonymous" | "ready"; toasts: Toast[]; rejectPrompt: RejectPrompt | null };

const emptySettings: OrgSettings = {
  orgName: "",
  emailDomain: "",
  senderName: "",
  senderAddress: "",
  replyTo: "",
  emailSignature: "",
  dnsRecords: [],
  google: { connected: false, account: "", driveRootFolder: "ATS/Resumes", driveSyncEnabled: true, calendarId: "primary", autoMeetLinks: true },
  aiSummariesEnabled: true,
};

const emptyData = (): Data => ({
  currentUserId: null,
  team: [],
  stages: [],
  sources: [],
  jobs: [],
  candidates: [],
  applications: [],
  rejectionReasons: [],
  interviews: [],
  bookingLinks: [],
  templates: [],
  campaigns: [],
  activity: [],
  settings: emptySettings,
  driveInbox: [],
});

const tempId = () => `tmp_${Math.random().toString(36).slice(2, 10)}`;

export const useStore = create<Store>()((set, get) => {
  /** Runs an API call; refreshes afterwards either way, toasts the error on failure. */
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const result = await fn();
      void get().refresh();
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        set({ ...emptyData(), status: "anonymous" });
        return null;
      }
      get().toast(`${label}: ${errorMessage(e)}`, "error");
      void get().refresh();
      return null;
    }
  }
  const ok = async (label: string, fn: () => Promise<unknown>) => (await run(label, async () => (await fn(), true))) === true;

  let inflight: Promise<void> | null = null;

  return {
    ...emptyData(),
    status: "loading",
    toasts: [],
    rejectPrompt: null,

    init: async () => {
      try {
        await api.get("/api/auth/me");
        await get().refresh();
      } catch {
        set({ ...emptyData(), status: "anonymous" });
      }
    },

    refresh: () => {
      inflight ??= (async () => {
        try {
          const { me, ...data } = await api.get<Bootstrap>("/api/bootstrap");
          set({ ...data, currentUserId: me.id, status: "ready" });
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) set({ ...emptyData(), status: "anonymous" });
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    startSync: () => {
      let timer: ReturnType<typeof setTimeout>;
      const tick = async () => {
        if (document.visibilityState === "visible" && get().status === "ready") await get().refresh();
        // Poll quickly while resumes are being parsed, otherwise every 20 seconds.
        const pending = get().candidates.some((c) => c.parseStatus === "pending");
        timer = setTimeout(tick, pending ? 3000 : 20000);
      };
      timer = setTimeout(tick, 20000);
      const onFocus = () => document.visibilityState === "visible" && get().refresh();
      document.addEventListener("visibilitychange", onFocus);
      return () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onFocus);
      };
    },

    logout: async () => {
      await api.post("/api/auth/logout").catch(() => {});
      set({ ...emptyData(), status: "anonymous" });
    },

    toast: (message, tone = "success", action) => {
      const id = tempId();
      set((s) => ({ toasts: [...s.toasts, { id, message, tone, action }] }));
      setTimeout(() => get().dismissToast(id), tone === "error" ? 7000 : 4500);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    // ---------- candidates ----------

    moveStage: (applicationIds, stageId, opts) => {
      const now = new Date().toISOString();
      set((s) => ({ applications: s.applications.map((a) => (applicationIds.includes(a.id) && a.stageId !== stageId ? { ...a, stageId, stageEnteredAt: now, lastActivityAt: now } : a)) }));
      return ok("Couldn't move candidate", () =>
        api.post("/api/applications/move", { ids: applicationIds, stageId, notify: !!opts?.notify, reasonId: opts?.reasonId, note: opts?.note }),
      );
    },
    requestMove: (applicationIds, stageId, opts) => {
      if (get().stages.find((s) => s.id === stageId)?.kind !== "closed") return get().moveStage(applicationIds, stageId, opts);
      get().rejectPrompt?.resolve(false);
      return new Promise((resolve) => set({ rejectPrompt: { applicationIds, stageId, notify: !!opts?.notify, resolve } }));
    },
    resolveRejectPrompt: (choice) => {
      const p = get().rejectPrompt;
      if (!p) return;
      set({ rejectPrompt: null });
      if (!choice) return p.resolve(false);
      void get()
        .moveStage(p.applicationIds, p.stageId, { notify: p.notify, reasonId: choice.reasonId, note: choice.note })
        .then(p.resolve);
    },
    addNote: (candidateId, body, applicationId) => {
      const note = { id: tempId(), authorId: get().currentUserId ?? "", body, createdAt: new Date().toISOString(), applicationId: applicationId ?? "" };
      set((s) => ({
        candidates: s.candidates.map((c) => (c.id === candidateId ? { ...c, notes: [note, ...c.notes] } : c)),
        applications: s.applications.map((a) => (applicationId ? a.id === applicationId : a.candidateId === candidateId) ? { ...a, lastActivityAt: note.createdAt } : a),
      }));
      return ok("Couldn't save note", () => api.post(`/api/candidates/${candidateId}/notes`, { body, applicationId: applicationId || null }));
    },
    setRating: (applicationId, rating) => {
      set((s) => ({ applications: s.applications.map((a) => (a.id === applicationId ? { ...a, rating } : a)) }));
      return ok("Couldn't save rating", () => api.patch(`/api/applications/${applicationId}`, { rating }));
    },
    toggleStar: (applicationId) => {
      const starred = !get().applications.find((a) => a.id === applicationId)?.starred;
      set((s) => ({ applications: s.applications.map((a) => (a.id === applicationId ? { ...a, starred } : a)) }));
      return ok("Couldn't update star", () => api.patch(`/api/applications/${applicationId}`, { starred }));
    },
    deleteCandidates: (ids) => {
      set((s) => ({ candidates: s.candidates.filter((c) => !ids.includes(c.id)), applications: s.applications.filter((a) => !ids.includes(a.candidateId)) }));
      return ok("Couldn't delete", () => api.post("/api/candidates/delete", { ids }));
    },
    fetchHistory: (candidateId) => api.get<CandidateHistory>(`/api/candidates/${candidateId}/history`).catch(() => null),
    resummarize: (applicationId) => ok("Couldn't restart summary", () => api.post(`/api/applications/${applicationId}/resummarize`)),

    uploadResumes: (files, jobId, sourceId) =>
      run("Upload failed", () => {
        const form = new FormData();
        // Fields must come before the files.
        form.append("jobId", jobId);
        form.append("sourceId", sourceId);
        files.forEach((f) => form.append("files", f, f.name));
        return api.post<{ created: string[]; rejected: string[] }>("/api/resumes", form);
      }),
    replaceResume: (candidateId, file) => {
      const form = new FormData();
      form.append("file", file);
      return ok("Couldn't replace the resume", () => api.post(`/api/candidates/${candidateId}/resume`, form));
    },
    renameResume: (candidateId, fileName) => ok("Couldn't rename the resume", () => api.patch(`/api/candidates/${candidateId}/resume`, { fileName })),
    importFromDrive: async (fileIds, jobId, sourceId) => {
      const r = await run("Import failed", () => api.post<{ created: string[] }>("/api/drive/import", { fileIds, jobId: jobId || null, ...(sourceId !== undefined ? { sourceId: sourceId || null } : {}) }));
      return r ? r.created.length : null;
    },
    setCandidateSource: (candidateIds, sourceId) => {
      set((s) => ({ candidates: s.candidates.map((c) => (candidateIds.includes(c.id) ? { ...c, sourceId } : c)) }));
      return ok("Couldn't set source", () => api.post("/api/candidates/source", { ids: candidateIds, sourceId: sourceId || null }));
    },
    createSource: async (name, color) => {
      const r = await run("Couldn't add source", () => api.post<Source>("/api/sources", { name, color }));
      if (r) set((s) => ({ sources: [...s.sources, r] }));
      return r;
    },
    updateSource: (id, patch) => {
      set((s) => ({ sources: s.sources.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
      return ok("Couldn't update source", () => api.patch(`/api/sources/${id}`, patch));
    },
    deleteSource: (id) => {
      set((s) => ({ sources: s.sources.filter((x) => x.id !== id) }));
      return ok("Couldn't delete source", () => api.del(`/api/sources/${id}`));
    },
    reorderSources: (ids) => {
      set((s) => ({ sources: ids.map((id) => s.sources.find((x) => x.id === id)!).filter(Boolean) }));
      return ok("Couldn't reorder", () => api.put("/api/sources/order", ids));
    },
    createSourceFolders: () => run("Couldn't create folders", () => api.post<{ jobs: number; folders: number }>("/api/drive/source-folders")),
    ignoreDriveFiles: (fileIds) => {
      set((s) => ({ driveInbox: s.driveInbox.filter((f) => !fileIds.includes(f.driveFileId)) }));
      return ok("Couldn't update", () => api.post("/api/drive/ignore", { fileIds }));
    },
    syncDrive: () => run("Drive sync failed", () => api.post<{ found: number; imported: number }>("/api/drive/sync")),

    // ---------- interviews ----------

    scheduleInterview: (input, opts) => ok("Couldn't schedule", () => api.post("/api/interviews", { ...input, notify: !!opts?.notify })),
    updateInterview: (id, patch) => {
      set((s) => ({ interviews: s.interviews.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
      return ok("Couldn't update interview", () => api.patch(`/api/interviews/${id}`, patch));
    },
    addFeedback: (id, feedback) => ok("Couldn't submit feedback", () => api.post(`/api/interviews/${id}/feedback`, feedback)),
    upsertBookingLink: (link) => {
      const { id, bookings: _b, ...body } = link;
      return ok("Couldn't save booking link", () => api.put(`/api/booking-links/${id}`, body));
    },
    deleteBookingLink: (id) => {
      set((s) => ({ bookingLinks: s.bookingLinks.filter((l) => l.id !== id) }));
      return ok("Couldn't delete", () => api.del(`/api/booking-links/${id}`));
    },

    // ---------- email ----------

    sendEmail: (input) => ok("Email not sent", () => api.post("/api/emails", input)),
    upsertTemplate: ({ id, name, subject, body, category }) => ok("Couldn't save template", () => api.put(`/api/email-templates/${id}`, { name, subject, body, category })),
    deleteTemplate: (id) => {
      set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }));
      return ok("Couldn't delete", () => api.del(`/api/email-templates/${id}`));
    },

    // ---------- admin ----------

    deleteJob: (id) => ok("Couldn't delete job", () => api.del(`/api/jobs/${id}`)),

    upsertJob: (job) =>
      ok("Couldn't save job", () =>
        api.put(`/api/jobs/${job.id}`, {
          title: job.title,
          department: job.department,
          location: job.location,
          type: job.type,
          status: job.status,
          hiringManagerId: job.hiringManagerId,
          openings: job.openings,
          description: job.description,
        }),
      ),
    inviteUser: (input) => run("Invite failed", () => api.post<{ emailError?: string }>("/api/users/invite", input)),
    updateUser: (id, patch) => {
      set((s) => ({ team: s.team.map((u) => (u.id === id ? { ...u, ...patch } : u)) }));
      return ok("Couldn't update", () => api.patch(`/api/users/${id}`, patch));
    },
    resendInvite: (id) => ok("Couldn't resend", () => api.post(`/api/users/${id}/resend-invite`)),
    deleteUser: async (id) => {
      const done = await ok("Couldn't delete", () => api.del(`/api/users/${id}`));
      if (done) set((s) => ({ team: s.team.filter((u) => u.id !== id) }));
      return done;
    },
    setStages: (stages) => {
      set({ stages });
      return ok("Couldn't save stages", () => api.put("/api/settings/stages", stages));
    },
    saveRejectionReasons: (reasons) => ok("Couldn't save reasons", () => api.put("/api/settings/rejection-reasons", reasons)),
    updateSettings: (patch) => ok("Couldn't save settings", () => api.patch("/api/settings", patch)),
    disconnectGoogle: () => ok("Couldn't disconnect", () => api.post("/api/integrations/google/disconnect")),
    verifyEmailDomain: () => ok("Verification failed", () => api.post("/api/settings/email/verify")),
    sendTestEmail: () => ok("Test email failed", () => api.post("/api/settings/email/test")),
  };
});

// ---------- Selectors & hooks ----------

export const useCurrentUser = () => {
  const id = useStore((s) => s.currentUserId);
  const team = useStore((s) => s.team);
  return team.find((u) => u.id === id) ?? null;
};

export const useCan = (permission: Permission) => {
  const user = useCurrentUser();
  return !!user && can(user.role, permission);
};

export const useStageMap = () => {
  const stages = useStore((s) => s.stages);
  return Object.fromEntries(stages.map((s) => [s.id, s])) as Record<string, Stage>;
};

export const useSourceMap = () => {
  const sources = useStore((s) => s.sources);
  return Object.fromEntries(sources.map((s) => [s.id, s])) as Record<string, Source>;
};

export const useJobMap = () => {
  const jobs = useStore((s) => s.jobs);
  return Object.fromEntries(jobs.map((j) => [j.id, j])) as Record<string, Job>;
};

export const useTeamMap = () => {
  const team = useStore((s) => s.team);
  return Object.fromEntries(team.map((u) => [u.id, u])) as Record<string, TeamMember>;
};

export const useCandidateMap = () => {
  const candidates = useStore((s) => s.candidates);
  return useMemo(() => Object.fromEntries(candidates.map((c) => [c.id, c])) as Record<string, Candidate>, [candidates]);
};

/** One entry per application, joined with its person: what boards, review and funnels show. */
export const useCards = () => {
  const applications = useStore((s) => s.applications);
  const candidates = useStore((s) => s.candidates);
  return useMemo(() => {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    return applications.flatMap((app) => {
      const candidate = byId.get(app.candidateId);
      return candidate ? [{ app, candidate }] : [];
    });
  }, [applications, candidates]);
};

export type Card = ReturnType<typeof useCards>[number];

/** A person's applications, newest first. */
export const useApplicationsOf = (candidateId: string | undefined) => {
  const applications = useStore((s) => s.applications);
  return useMemo(
    () => applications.filter((a) => a.candidateId === candidateId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.appliedAt.localeCompare(a.appliedAt)),
    [applications, candidateId],
  );
};

/** candidate id → the application they were most recently worked on for (same rule the server uses for manual emails). */
export const useLatestAppMap = () => {
  const applications = useStore((s) => s.applications);
  return useMemo(() => {
    const out: Record<string, Application> = {};
    for (const a of applications) if (!out[a.candidateId] || a.lastActivityAt > out[a.candidateId]!.lastActivityAt) out[a.candidateId] = a;
    return out;
  }, [applications]);
};
