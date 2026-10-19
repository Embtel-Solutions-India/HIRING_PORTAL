/**
 * Google APIs over plain HTTPS: OAuth (sign-in + the Workspace connection), Drive and Calendar.
 *
 * One Google account (connected by a Super Admin in Settings) owns the resume folders and creates
 * calendar events. Its refresh token is stored encrypted in the settings table.
 */
import { config } from "./config.ts";
import { decrypt } from "./crypto.ts";
import { HttpError } from "./http.ts";
import { getSetting, patchSetting } from "./settings.ts";

export const LOGIN_SCOPES = ["openid", "email", "profile"];
export const INTEGRATION_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
];

export const loginRedirectUri = () => `${config.appUrl}/api/auth/google/callback`;
export const integrationRedirectUri = () => `${config.appUrl}/api/integrations/google/callback`;

export function authUrl(opts: { scopes: string[]; redirectUri: string; state: string; offline?: boolean; hd?: string; loginHint?: string }) {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    state: opts.state,
    include_granted_scopes: "true",
    prompt: opts.offline ? "consent" : "select_account",
  });
  if (opts.offline) p.set("access_type", "offline");
  if (opts.hd) p.set("hd", opts.hd);
  if (opts.loginHint) p.set("login_hint", opts.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...body }),
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new HttpError(502, `Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

export const exchangeCode = (code: string, redirectUri: string) =>
  tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });

export async function userInfo(accessToken: string) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new HttpError(502, "Couldn't read your Google profile");
  return (await res.json()) as { email: string; email_verified: boolean; name?: string; given_name?: string; hd?: string };
}

export async function revokeToken(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

// ---------- Access token for the connected Workspace account ----------

let cached: { token: string; expiresAt: number } | null = null;

export function clearTokenCache() {
  cached = null;
}

export async function isConnected() {
  const g = await getSetting("google");
  return g.connected && !!g.refreshTokenEnc;
}

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const g = await getSetting("google");
  if (!g.connected || !g.refreshTokenEnc) throw new HttpError(409, "Google Workspace isn't connected. A Super Admin can connect it in Settings.");
  try {
    const t = await tokenRequest({ refresh_token: decrypt(g.refreshTokenEnc), grant_type: "refresh_token" });
    cached = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  } catch (e) {
    // Revoked or expired grant: mark disconnected so Settings shows it.
    await patchSetting("google", { connected: false });
    throw e;
  }
}

async function gfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await accessToken()}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status === 404 ? 404 : 502, `Google API error (${res.status}): ${msg.slice(0, 300)}`);
  }
  return res;
}

// ---------- Drive ----------

const DRIVE = "https://www.googleapis.com/drive/v3";
export const FOLDER = "application/vnd.google-apps.folder";
export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const RESUME_MIME = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", GOOGLE_DOC];

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  /** Increases on every change to the file (content or metadata). */
  version?: string;
  trashed?: boolean;
  driveId?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}

const escapeQ = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const common = "supportsAllDrives=true&includeItemsFromAllDrives=true";

async function listQuery(query: string, fields = "files(id,name,mimeType,size,modifiedTime,webViewLink,parents)"): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken = "";
  do {
    const url = `${DRIVE}/files?${common}&pageSize=200&q=${encodeURIComponent(query)}&fields=${encodeURIComponent(`nextPageToken,${fields}`)}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const json = (await (await gfetch(url)).json()) as { files: DriveFile[]; nextPageToken?: string };
    out.push(...json.files);
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

export async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const found = await listQuery(`name = '${escapeQ(name)}' and mimeType = '${FOLDER}' and '${parentId}' in parents and trashed = false`, "files(id,name)");
  if (found[0]) return found[0].id;
  const res = await gfetch(`${DRIVE}/files?supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
  });
  return ((await res.json()) as { id: string }).id;
}

/** "ATS/Resumes" → folder id, creating any missing folders under My Drive. */
export async function ensureFolderPath(path: string): Promise<string> {
  let parent = "root";
  for (const part of path.split("/").map((p) => p.trim()).filter(Boolean)) parent = await findOrCreateFolder(part, parent);
  return parent;
}

export async function ensureRootFolder(): Promise<string> {
  const g = await getSetting("google");
  if (g.driveRootFolderId) return g.driveRootFolderId;
  const id = await ensureFolderPath(g.driveRootFolder || "ATS/Resumes");
  await patchSetting("google", { driveRootFolderId: id });
  return id;
}

export async function listFolder(folderId: string): Promise<DriveFile[]> {
  return listQuery(`'${folderId}' in parents and trashed = false`);
}

export async function listSubfolders(folderId: string): Promise<DriveFile[]> {
  return listQuery(`'${folderId}' in parents and mimeType = '${FOLDER}' and trashed = false`, "files(id,name)");
}

/** `id` (from generateFileId) makes the upload idempotent: a retry with the same id can't create a second file. */
export async function uploadFile(folderId: string, name: string, mimeType: string, data: Buffer, id?: string): Promise<DriveFile> {
  const boundary = `hirely${Date.now().toString(36)}`;
  const meta = JSON.stringify({ ...(id ? { id } : {}), name, parents: [folderId], mimeType });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await gfetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,md5Checksum,version,webViewLink`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json()) as DriveFile;
}

export async function getFileMeta(fileId: string): Promise<DriveFile> {
  const res = await gfetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,md5Checksum,version,trashed,driveId,modifiedTime,webViewLink,parents`);
  return (await res.json()) as DriveFile;
}

/** Downloads a file. Google Docs are exported as PDF. */
export async function downloadFile(fileId: string, mimeType: string): Promise<{ data: Buffer; mimeType: string }> {
  const url =
    mimeType === GOOGLE_DOC
      ? `${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`
      : `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await gfetch(url);
  return { data: Buffer.from(await res.arrayBuffer()), mimeType: mimeType === GOOGLE_DOC ? "application/pdf" : mimeType };
}

export async function moveFile(fileId: string, toFolderId: string) {
  const meta = await getFileMeta(fileId);
  const remove = (meta.parents ?? []).join(",");
  await gfetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&addParents=${toFolderId}${remove ? `&removeParents=${remove}` : ""}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function generateFileId(): Promise<string> {
  const res = await gfetch(`${DRIVE}/files/generateIds?count=1&space=drive&type=files`);
  return ((await res.json()) as { ids: string[] }).ids[0]!;
}

/** Uploads new content as a new revision of the same file (same id, same links). */
export async function updateFileContent(fileId: string, mimeType: string, data: Buffer): Promise<void> {
  await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": mimeType },
    body: data,
  });
}

async function patchMeta(fileId: string, body: object) {
  await gfetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
export const renameFile = (fileId: string, name: string) => patchMeta(fileId, { name });
export const setTrashed = (fileId: string, trashed: boolean) => patchMeta(fileId, { trashed });

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
}

const driveParam = (driveId: string) => (driveId ? `&driveId=${encodeURIComponent(driveId)}` : "");

export async function getStartPageToken(driveId: string): Promise<string> {
  const res = await gfetch(`${DRIVE}/changes/startPageToken?supportsAllDrives=true${driveParam(driveId)}`);
  return ((await res.json()) as { startPageToken: string }).startPageToken;
}

export async function listChanges(pageToken: string, driveId: string) {
  const fields = "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,md5Checksum,version,trashed,parents))";
  const res = await gfetch(
    `${DRIVE}/changes?pageToken=${encodeURIComponent(pageToken)}&pageSize=1000&includeRemoved=true&${common}${driveParam(driveId)}&fields=${encodeURIComponent(fields)}`,
  );
  return (await res.json()) as { changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string };
}

// ---------- Calendar ----------

const CAL = "https://www.googleapis.com/calendar/v3";

export interface CalendarEventInput {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  attendees: string[];
  withMeet: boolean;
  location?: string;
  sendUpdates: boolean;
}

export async function createEvent(input: CalendarEventInput): Promise<{ id: string; meetLink?: string }> {
  const g = await getSetting("google");
  const calendarId = encodeURIComponent(g.calendarId || "primary");
  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.start.toISOString() },
    end: { dateTime: input.end.toISOString() },
    attendees: [...new Set(input.attendees.filter(Boolean))].map((email) => ({ email })),
    location: input.location,
    guestsCanModify: false,
  };
  if (input.withMeet) {
    body.conferenceData = { createRequest: { requestId: `hirely-${Date.now()}-${Math.random().toString(36).slice(2)}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  const res = await gfetch(`${CAL}/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=${input.sendUpdates ? "all" : "none"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id: string; hangoutLink?: string };
  return { id: json.id, meetLink: json.hangoutLink };
}

export async function cancelEvent(eventId: string) {
  const g = await getSetting("google");
  await gfetch(`${CAL}/calendars/${encodeURIComponent(g.calendarId || "primary")}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" }).catch((e) => {
    if (!(e instanceof HttpError && e.status === 404)) throw e;
  });
}

/** Busy blocks per email address between `from` and `to`. */
export async function freeBusy(emails: string[], from: Date, to: Date): Promise<Record<string, { start: string; end: string }[]>> {
  if (!emails.length) return {};
  const res = await gfetch(`${CAL}/freeBusy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: emails.map((id) => ({ id })) }),
  });
  const json = (await res.json()) as { calendars: Record<string, { busy?: { start: string; end: string }[] }> };
  return Object.fromEntries(Object.entries(json.calendars ?? {}).map(([k, v]) => [k.toLowerCase(), v.busy ?? []]));
}
