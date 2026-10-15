import { config } from "./config.ts";
import { Prisma, prisma } from "./db.ts";

export interface OrgSettingsRow {
  orgName: string;
  emailDomain: string;
  senderName: string;
  senderAddress: string;
  replyTo: string;
  emailSignature: string;
  aiSummariesEnabled: boolean;
}

export interface GoogleSettingsRow {
  connected: boolean;
  account: string;
  refreshTokenEnc?: string;
  scopes?: string;
  driveRootFolder: string;
  driveRootFolderId?: string;
  driveSyncEnabled: boolean;
  lastSyncAt?: string;
  calendarId: string;
  autoMeetLinks: boolean;
}

export interface DnsRecord {
  type: "SPF" | "DKIM" | "DMARC";
  host: string;
  value: string;
  verified: boolean;
}

const domainOf = (email: string) => email.split("@")[1] ?? "";

const DEFAULTS = {
  org: (): OrgSettingsRow => {
    const sender = config.email.fromAddress || (config.superAdminEmail ? `careers@${domainOf(config.superAdminEmail)}` : "careers@yourcompany.com");
    return {
      orgName: config.orgName,
      emailDomain: config.allowedEmailDomain || domainOf(sender),
      senderName: config.email.fromName,
      senderAddress: sender,
      replyTo: config.email.replyTo || sender,
      emailSignature: `${config.email.fromName}\n${config.orgName}`,
      aiSummariesEnabled: true,
    };
  },
  google: (): GoogleSettingsRow => ({
    connected: false,
    account: "",
    driveRootFolder: "ATS/Resumes",
    driveSyncEnabled: true,
    calendarId: "primary",
    autoMeetLinks: true,
  }),
  dns: (): DnsRecord[] => [],
  driveChanges: () => ({ pageToken: "", driveId: "", lastSuccessAt: "" }),
  migration: () => ({ startedAt: "" }),
};

type Key = keyof typeof DEFAULTS;
type ValueOf<K extends Key> = ReturnType<(typeof DEFAULTS)[K]>;

export async function getSetting<K extends Key>(key: K): Promise<ValueOf<K>> {
  const row = await prisma.settings.findUnique({ where: { key } });
  const base = DEFAULTS[key]() as ValueOf<K>;
  if (!row) return base;
  return Array.isArray(base) ? (row.value as ValueOf<K>) : ({ ...base, ...(row.value as object) } as ValueOf<K>);
}

export async function setSetting<K extends Key>(key: K, value: ValueOf<K>) {
  // Round-trip through JSON so undefined fields are dropped, exactly as they are when stored.
  const json = JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  await prisma.settings.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
}

export async function patchSetting<K extends Key>(key: K, patch: Partial<ValueOf<K>>) {
  const current = await getSetting(key);
  const next = { ...(current as object), ...(patch as object) } as ValueOf<K>;
  await setSetting(key, next);
  return next;
}
