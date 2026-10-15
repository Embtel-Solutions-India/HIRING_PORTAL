import { Check, ClipboardCheck, Crown, Mail, MoreHorizontal, Shield, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Avatar, Badge, Button, CalendarMark, Field, IconButton, Menu, MenuItem, Modal, PageHeader, Select, Tabs } from "../components/ui";
import { useCurrentUser, useStore } from "../data/store";
import { can, canManageRole, PERMISSION_GROUPS, ROLE_DESCRIPTION, ROLE_LABEL, ROLES } from "../lib/permissions";
import type { Role } from "../types";
import { cn, timeAgo } from "../lib/utils";

const ROLE_ICON: Record<Role, ReactNode> = { interviewer: <ClipboardCheck size={16} />, user: <Shield size={16} />, admin: <ShieldCheck size={16} />, super_admin: <Crown size={16} /> };

export default function Team() {
  const me = useCurrentUser()!;
  const team = useStore((s) => s.team);
  const updateUser = useStore((s) => s.updateUser);
  const resendInvite = useStore((s) => s.resendInvite);
  const deleteUser = useStore((s) => s.deleteUser);
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<"members" | "roles">("members");
  const [inviteOpen, setInviteOpen] = useState(false);
  const superAdmins = team.filter((t) => t.role === "super_admin" && t.status === "active").length;

  const assignable = ROLES.filter((r) => canManageRole(me.role, r));

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={
          me.role === "admin"
            ? "As an Admin you can invite and manage Recruiters and Interviewers. Ask a Super Admin to change Admin roles."
            : "Invite teammates — including the people who take interviews — and control what each role can do."
        }
        actions={
          <Button variant="primary" icon={<UserPlus size={15} />} onClick={() => setInviteOpen(true)}>
            Invite member
          </Button>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[...ROLES].reverse().map((r) => (
          <div key={r} className="card p-4">
            <div className="flex items-center gap-2">
              <span className={cn("flex size-8 items-center justify-center rounded-lg", r === "super_admin" ? "bg-lime-soft text-brand-800" : r === "admin" ? "bg-brand-50 text-brand-700" : r === "interviewer" ? "bg-sky-50 text-sky-800" : "bg-sunken text-ink-2")}>{ROLE_ICON[r]}</span>
              <p className="font-bold">{ROLE_LABEL[r]}</p>
              <span className="tabular ml-auto text-xl font-bold">{team.filter((t) => t.role === r && t.status !== "deactivated").length}</span>
            </div>
            <p className="mt-2 text-[13px] leading-snug text-muted">{ROLE_DESCRIPTION[r]}</p>
          </div>
        ))}
      </div>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "members", label: "Members", count: team.length },
          { value: "roles", label: "Roles & permissions" },
        ]}
      />

      {tab === "members" ? (
        <div className="card">
          <ul className="divide-y divide-line">
            {team.map((m) => {
              const editable = m.id !== me.id && canManageRole(me.role, m.role);
              const lastSuper = m.role === "super_admin" && superAdmins <= 1;
              return (
                <li key={m.id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", m.status === "deactivated" && "[&>*:not(:last-child)]:opacity-55")}>
                  <Avatar name={m.name} color={m.avatarColor} size={36} />
                  <div className="min-w-[180px] flex-1">
                    <p className="text-sm font-semibold">
                      {m.name} {m.id === me.id && <span className="text-xs font-medium text-muted">(you)</span>}
                    </p>
                    <p className="text-xs text-muted">
                      {m.title} · {m.email}
                    </p>
                  </div>
                  <span className="hidden w-32 items-center gap-1.5 text-xs text-muted lg:flex" title={m.calendarConnected ? "Google Calendar connected" : "Calendar not connected"}>
                    <span className={cn(!m.calendarConnected && "opacity-30 grayscale")}>
                      <CalendarMark size={14} />
                    </span>
                    {m.calendarConnected ? "Calendar on" : "No calendar"}
                  </span>
                  <span className="hidden w-28 text-xs text-muted md:block">{m.status === "invited" ? "Invite pending" : m.lastActiveAt ? `Active ${timeAgo(m.lastActiveAt)}` : "—"}</span>
                  {m.status !== "active" && <Badge tone={m.status === "invited" ? "warn" : "neutral"}>{m.status}</Badge>}
                  {editable && !lastSuper ? (
                    <Select
                      ariaLabel={`Role for ${m.name}`}
                      value={m.role}
                      onChange={async (v) => {
                        if (await updateUser(m.id, { role: v as Role })) toast(`${m.name} is now ${ROLE_LABEL[v as Role]}`);
                      }}
                      options={assignable.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                    />
                  ) : (
                    <Badge tone={m.role === "super_admin" ? "lime" : m.role === "admin" ? "brand" : m.role === "interviewer" ? "info" : "neutral"} className="h-9 w-[120px] justify-center">
                      {ROLE_LABEL[m.role]}
                    </Badge>
                  )}
                  {editable ? (
                    <Menu
                      align="right"
                      trigger={({ toggle }) => (
                        <IconButton label={`Actions for ${m.name}`} onClick={toggle}>
                          <MoreHorizontal size={16} />
                        </IconButton>
                      )}
                    >
                      {(close) => (
                        <>
                          {m.status === "invited" && (
                            <MenuItem
                              icon={<Mail size={15} />}
                              onClick={async () => {
                                close();
                                if (await resendInvite(m.id)) toast(`Invite re-sent to ${m.email}`, "info");
                              }}
                            >
                              Resend invite
                            </MenuItem>
                          )}
                          {m.status === "deactivated" ? (
                            <MenuItem
                              icon={<Check size={15} />}
                              onClick={async () => {
                                close();
                                if (await updateUser(m.id, { status: "active" })) toast(`${m.name} reactivated`);
                              }}
                            >
                              Reactivate
                            </MenuItem>
                          ) : (
                            <MenuItem
                              danger
                              icon={<X size={15} />}
                              onClick={async () => {
                                close();
                                if (await updateUser(m.id, { status: "deactivated" })) toast(`${m.name} deactivated · signed out everywhere`);
                              }}
                            >
                              Deactivate
                            </MenuItem>
                          )}
                          {can(me.role, "users.delete") && !m.protected && !(lastSuper && m.status === "active") && (
                            <MenuItem
                              danger
                              icon={<Trash2 size={15} />}
                              onClick={async () => {
                                close();
                                if (!confirm(`Delete ${m.name}? They lose access immediately. Their notes and feedback stay, but no longer show an author.`)) return;
                                if (await deleteUser(m.id)) toast(`${m.name} deleted`);
                              }}
                            >
                              Delete
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Menu>
                  ) : (
                    <span className="w-8" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-line bg-paper/60">
              <tr>
                <th className="px-4 py-3 text-left text-[12px] font-semibold text-muted">Permission</th>
                {ROLES.map((r) => (
                  <th key={r} className="w-28 px-3 py-3 text-center text-[12px] font-bold">
                    {ROLE_LABEL[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_GROUPS.map((g) => (
                <Fragment key={g.label}>
                  <tr className="bg-paper/40">
                    <td colSpan={5} className="label px-4 pt-4 pb-1.5">
                      {g.label}
                    </td>
                  </tr>
                  {g.items.map((p) => (
                    <tr key={p.key} className="border-t border-line/70">
                      <td className="px-4 py-2.5 text-ink-2">{p.label}</td>
                      {ROLES.map((r) => (
                        <td key={r} className="px-3 py-2.5 text-center">
                          {can(r, p.key) ? (
                            <Check size={16} className="mx-auto text-brand-600" aria-label="Allowed" />
                          ) : (
                            <span className="mx-auto block h-px w-3 bg-line-strong" aria-label="Not allowed" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line px-4 py-3 text-xs text-muted">Permissions are enforced by the API as well as hidden in the UI. Changing this matrix is a code change in <span className="font-mono">src/lib/permissions.ts</span> (and the backend twin).</p>
        </div>
      )}

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} roles={assignable} />
    </>
  );
}

function InviteModal({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const invite = useStore((s) => s.inviteUser);
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<Role>("interviewer");
  const [sending, setSending] = useState(false);
  const external = !!settings.emailDomain && email.includes("@") && !email.toLowerCase().endsWith(`@${settings.emailDomain}`);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a teammate"
      description="They'll sign in with Google using the email below."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !email.includes("@") || sending}
            onClick={async () => {
              setSending(true);
              const r = await invite({ name: name.trim(), email: email.trim().toLowerCase(), role, title });
              setSending(false);
              if (!r) return;
              if (r.emailError) toast(`${email} was added, but the invite email failed: ${r.emailError}. Fix the email settings, then use Resend invite.`, "error");
              else toast(`Invite sent to ${email}`);
              setName("");
              setEmail("");
              onClose();
            }}
            icon={<Mail size={15} />}
          >
            Send invite
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Full name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Google account email" hint={external ? "Outside your company. This email must be a Google account (Gmail, Google Workspace, or a Google account made with this email)." : "They sign in with Google using this address."}>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`name@${settings.emailDomain}`} />
        </Field>
        <Field label="Job title">
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Role</span>
          <div className="grid gap-2">
            {roles.map((r) => (
              <button key={r} onClick={() => setRole(r)} className={cn("flex items-start gap-3 rounded-xl border p-3 text-left transition", role === r ? "border-brand-600 bg-brand-50" : "border-line hover:border-line-strong")}>
                <span className="mt-0.5 text-brand-700">{ROLE_ICON[r]}</span>
                <span>
                  <span className="block text-sm font-bold">{ROLE_LABEL[r]}</span>
                  <span className="block text-xs leading-snug text-muted">{ROLE_DESCRIPTION[r]}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
