# Launching Hirely on AWS

This guide takes you from zero to a live, secure hiring app at an address like **https://hire.yourcompany.com** that your team signs into with Google.

Plan on about **2 hours**, plus however long your email provider takes to verify your domain (step 4). You don't need to know how to code. You will copy and paste some commands.

**What you'll end up with**

| Piece | What it does | Rough monthly cost |
|---|---|---|
| AWS Lightsail server (2 GB) | Runs the app and its database, with automatic HTTPS | $12 |
| An SMTP email provider (your choice) | Sends candidate emails from your domain | Free tier to a few dollars, depending on provider |
| Google Workspace (you already have it) | Sign-in, resume storage in Drive, interview events in Calendar | $0 extra |
| Claude API (Anthropic) | Reads each resume and writes the summary | about 2–5¢ per resume |

**Before you start, have these ready:**

- Admin access to your **domain's DNS** (wherever you bought the domain, e.g. GoDaddy, Namecheap, Google Domains/Squarespace, Cloudflare, Route 53)
- An **AWS account** (aws.amazon.com, with a card on file)
- A **Google Workspace** account. A Workspace super-admin helps for step 3.
- This project folder on your computer

Throughout this guide, replace `hire.yourcompany.com` with your real address and `yourcompany.com` with your real domain.

---

## Step 1 — Create the server (AWS Lightsail)

1. Sign in to AWS. Search for **Lightsail** and open it.
2. Click **Create instance**.
   - **Region:** pick the one closest to your team (e.g. *Oregon, us-west-2*).
   - **Platform:** Linux/Unix. **Blueprint:** *OS Only* → **Ubuntu 24.04 LTS**.
   - **Plan:** **$12/month (2 GB RAM)**. Don't choose anything smaller.
   - **Name:** `hirely`. Click **Create instance**.
3. Give the server a permanent address:
   - Open the instance → **Networking** tab → **Attach static IP** → create one. Note the IP address, e.g. `3.91.20.15`.
4. Open the web ports. On the same **Networking** tab, under **IPv4 Firewall**, make sure these rules exist (add any that are missing):
   - SSH, TCP 22
   - HTTP, TCP 80
   - HTTPS, TCP 443
5. Turn on automatic backups: open the instance → **Snapshots** tab → turn on **Automatic snapshots**. This gives you a daily backup of the whole server for a few dollars a month.

## Step 2 — Point your address at the server (DNS)

At your domain's DNS provider, add **one record**:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| A | `hire` | your static IP from step 1.3 | 300 (or Auto) |

This usually works within a few minutes. Check it from your own computer with `nslookup hire.yourcompany.com`; it should show your static IP.

## Step 3 — Google: sign-in, Drive and Calendar

1. Go to **https://console.cloud.google.com**, signed in with your company Google account.
2. Use the project picker at the top → **New project** → name it `Hirely` → **Create**, then select it.
3. **Turn on the APIs:** search the top bar for each and click **Enable**:
   - **Google Drive API**
   - **Google Calendar API**
4. **Consent screen.** Go to **APIs & Services → OAuth consent screen**. Newer consoles call it **Google Auth Platform → Branding / Audience**.
   - App name: `Hirely` (people see this when signing in). Support email: yours.
   - **User type / Audience: Internal**. This keeps the app to your company's accounts and avoids Google's app review.
   - Developer contact: your email. Save.
5. **Create the login keys.** Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**. Newer consoles: **Google Auth Platform → Clients → Create client**.
   - Application type: **Web application**. Name: `Hirely web`.
   - **Authorized redirect URIs:** add **both** of these, exactly:
     - `https://hire.yourcompany.com/api/auth/google/callback`
     - `https://hire.yourcompany.com/api/integrations/google/callback`
   - Click **Create**. Copy the **Client ID** and **Client secret** into a note for step 7.
6. *(Only if your company restricts third-party apps.)* A Workspace super-admin goes to **admin.google.com → Security → Access and data control → API controls → Manage Third-Party App Access**, finds the Client ID, and sets it to **Trusted**.

## Step 4 — Email: sending from your domain over SMTP

Hirely sends email through any SMTP provider. Pick one you already use or like.

**a. Get SMTP settings from your provider.** You need a host, port, username and password (often an *app password* or *API key*):

| Provider | Host | Port | Username / password |
|---|---|---|---|
| Google Workspace | `smtp.gmail.com` | 587 | your address / an [app password](https://myaccount.google.com/apppasswords) (low volume only, ~2,000/day) |
| Microsoft 365 | `smtp.office365.com` | 587 | your address / password (SMTP AUTH must be enabled for the mailbox) |
| SendGrid | `smtp.sendgrid.net` | 587 | `apikey` / your API key |
| Mailgun | `smtp.mailgun.org` | 587 | the domain's SMTP login / password |
| Brevo | `smtp-relay.brevo.com` | 587 | your SMTP login / SMTP key |
| Postmark | `smtp.postmarkapp.com` | 587 | server API token / same token |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | SES SMTP credentials |
| Zoho Mail | `smtp.zoho.com` | 587 | your address / app password |

Use port **587** unless your provider says 465.

**b. Verify your domain with the provider.** In the provider's dashboard, add your domain (e.g. `yourcompany.com`). It will show **DKIM** records (and usually an **SPF** value). Add them at your DNS provider exactly as shown. Also add a DMARC record if you don't have one:

| Type | Name | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@yourcompany.com` |

> Your domain can only have **one** SPF record. If you already have one (e.g. for Google Workspace), add the provider's `include:` to it rather than creating a second.

After launch, **Settings → Email domain → Get records** checks that SPF and DMARC are in place.

**c. Choose the sender address**, e.g. `careers@yourcompany.com`, on the verified domain. It doesn't need its own inbox. Set the **reply-to** to a real inbox or Google Group (e.g. `recruiting@yourcompany.com`) so candidate replies reach a person.

Until the domain is verified, set `EMAIL_TRANSPORT=log` in step 7 so nothing is sent.

## Step 5 — Claude API key (AI resume summaries)

1. Go to **https://console.anthropic.com** and sign up or sign in.
2. Under **Billing**, add a payment method and a monthly spend limit, e.g. $50.
3. Under **API keys**, click **Create key**, name it `hirely`, and copy the key for step 7.

Skip this step and the app still works; it just won't write summaries. You can add the key later.

## Amazon S3 (resume storage)

Resumes are stored in S3 and kept in sync with Google Drive. Skip this section to keep resumes in Drive only.

1. Create a **private** bucket in your region. Block all public access.
2. **Turn on Versioning** (Bucket → Properties → Bucket Versioning → Enable). The app refuses to store files without it.
3. Add a lifecycle rule: *Permanently delete noncurrent versions* after 90 days (or your retention period).
4. Create an IAM user with this policy (replace `YOUR-BUCKET`) and an access key:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/*" },
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR-BUCKET" }
     ]
   }
   ```

5. Set `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and optionally `RESUME_DELETE_GRACE_DAYS`) and restart.
6. In **Settings → Resume sync**, click **Start migration**. Watch *Migrated to S3* reach *N of N*. Drive files are not changed.
   Re-running the migration is safe. Keep the Drive originals until the dashboard shows every resume migrated and no failures.

## Step 6 — Put the app on the server

**Connect to the server.** In Lightsail, open the instance and click **Connect using SSH**. A terminal opens in your browser. Paste these commands one at a time:

```bash
sudo apt-get update && sudo apt-get -y upgrade
```

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

(That last one adds swap memory so building the app never runs out of RAM.)

```bash
sudo usermod -aG docker ubuntu && exit
```

Click **Connect using SSH** again so the Docker permission takes effect.

**Copy the code over.** Pick one option.

*Option A — GitHub (easiest for future updates).* Push this folder to a **private** GitHub repository. On the server, run:

```bash
git clone https://github.com/<you>/<repo>.git hirely
```

```bash
cd hirely
```

*Option B — upload a zip.* On **your computer**, in the folder that contains this project, run:

```bash
cd "Hiring Software" && COPYFILE_DISABLE=1 tar --exclude=node_modules --exclude=dist --exclude=.dev-db --exclude=data --exclude=.env --exclude=.claude -czf ../hirely.tar.gz . && cd ..
```

Upload `hirely.tar.gz` to the server. Use the browser terminal's **⋮ / gear menu → Upload file** if you see it. Otherwise, download the SSH key from **Lightsail → Account → SSH keys** and run this on your computer:

```bash
scp -i ~/Downloads/LightsailDefaultKey-us-west-2.pem hirely.tar.gz ubuntu@YOUR_STATIC_IP:~
```

Then, on the server, run:

```bash
mkdir hirely && tar -xzf hirely.tar.gz -C hirely && cd hirely
```

## Step 7 — Fill in the settings

On the server, inside the `hirely` folder:

```bash
cp .env.example .env
```

```bash
openssl rand -hex 32
```

Run `openssl rand -hex 32` **twice** and keep both results: one for `APP_SECRET`, one for `POSTGRES_PASSWORD`. Then open the settings file:

```bash
nano .env
```

Fill in:

- `DOMAIN`: `hire.yourcompany.com`
- `APP_URL`: `https://hire.yourcompany.com`
- `ORG_NAME`, `ORG_TIMEZONE`
- `APP_SECRET`, `POSTGRES_PASSWORD`: the two random values. **Never change `APP_SECRET` later**, or the Google connection must be redone.
- `SUPER_ADMIN_EMAIL`: **your** Google account email
- `ALLOWED_EMAIL_DOMAIN`: `yourcompany.com`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: from step 3.5
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: from step 4
- `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO`
- `EMAIL_TRANSPORT`: `smtp` (or `log` until your domain is verified)
- `ANTHROPIC_API_KEY`: from step 5

Save with **Ctrl+O**, then **Enter**, then **Ctrl+X** to exit.

## Step 8 — Start it

```bash
docker compose up -d --build
```

The first build takes 3–5 minutes. Then check that everything is running:

```bash
docker compose ps
```

```bash
docker compose logs -f app
```

You should see `Hirely API listening on :3000`. Press **Ctrl+C** to stop watching the logs; the app keeps running.

Open **https://hire.yourcompany.com**. The padlock (HTTPS) is set up automatically the first time; give it a minute. Sign in with Google using the `SUPER_ADMIN_EMAIL` account.

## Step 9 — First-time setup inside the app

1. **Settings → Google & AI → Connect Google.** Sign in with the Google account that should *own* the resume folders and interview events, and tick **both** the Drive and Calendar permissions. A shared account such as `hiring@yourcompany.com` works best, so it doesn't depend on one person.
   - The app creates `ATS/Resumes` in that account's Drive. You can change the folder name in Settings.
   - **Calendar:** leave `primary`, or paste the ID of a shared hiring calendar that account can edit.
2. **Settings → Email domain.** Check the sender name, address, reply-to and signature → **Save**. Click **Get records / Verify** and confirm the DNS records are green, then **Send test email**.
3. **Jobs → New job** for each open role. Paste the **job description**: the AI uses it to score each resume. A matching Drive folder is created automatically.
4. **Team → Invite member** for each person:
   - **Interviewer:** people who only take interviews. They see just the candidates they're scheduled with, plus resumes, summaries, notes and feedback.
   - **Recruiter:** reviews every resume, moves stages, schedules interviews, emails single candidates.
   - **Admin:** recruiters plus uploading resumes, bulk email, jobs, templates and managing recruiter/interviewer accounts.
   - **Super Admin:** everything, including these settings.

   Each person gets an invite email and signs in with their Google account.
5. **Interviews → Booking links.** Edit the "30-min intro call" link and add the right **hosts** (the people candidates book with) and working hours. Add more links as needed.
6. **Add resumes.** Drop PDF or Word files into `ATS/Resumes/<Job title>/` in Google Drive (they're picked up within a few minutes), or use **Candidates → Upload resumes**.

You're live. 🎉

---

## Running it day to day

| Task | Command (run on the server in the `hirely` folder) |
|---|---|
| See if it's running | `docker compose ps` |
| Watch the logs | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| Update to a new version | `./scripts/update.sh` (backs up first, then rebuilds) |
| Back up the database now | `./scripts/backup.sh` |
| Restore a backup | `./scripts/restore.sh backups/<file>.sql.gz` |
| Change a setting in `.env` | edit `.env`, then `docker compose up -d` |

**Nightly database backups.** Run `crontab -e`, choose nano, and add this line:

```
15 3 * * * cd /home/ubuntu/hirely && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Resume files live in Google Drive (Google keeps them safe). Lightsail's automatic snapshots cover the whole server as a second safety net.

**Updating with Option B (zip):** upload the new `hirely.tar.gz`, then run:

```bash
tar -xzf hirely.tar.gz -C hirely && cd hirely && ./scripts/update.sh
```

Your `.env` and data are not touched.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Browser says the site can't be reached | Check the DNS A record (step 2) and that ports 80 and 443 are open in the Lightsail firewall (step 1.4). Then `docker compose logs caddy`. |
| Google says **redirect_uri_mismatch** | The two redirect URIs in step 3.5 must match `APP_URL` exactly, `https://` included. |
| "…isn't on the team yet" when signing in | That account hasn't been invited. Sign in first with `SUPER_ADMIN_EMAIL`, then invite people from **Team**. |
| Google says "access blocked / admin policy" | A Workspace admin needs to trust the app (step 3.6). |
| Connect Google says "didn't grant offline access" | Remove Hirely at https://myaccount.google.com/permissions, then click **Connect Google** again. |
| Emails aren't arriving | Check that `EMAIL_TRANSPORT=smtp` and the SMTP settings (step 4a). Failed sends store the provider's error; check `docker compose logs app`. Check the DNS records under Settings → Email domain. |
| Emails land in spam | Make sure your provider shows the domain verified (DKIM), and SPF and DMARC pass under Settings → Email domain, and that the From address is on the verified domain. |
| Resumes dropped in Drive don't appear | They must be PDF, Word (.docx) or Google Docs inside `ATS/Resumes/` or a job sub-folder of the **connected** account. Use **Check now** in the Add candidates dialog. Files outside a job folder wait in the Drive inbox. |
| "No AI summary" on candidates | Set `ANTHROPIC_API_KEY`, run `docker compose up -d`, then click **Retry** on the candidate. Check that billing is active in the Anthropic console. |
| Something else | `docker compose logs --tail=200 app` shows the error. |

## Security notes

- Only invited people can sign in, and only with Google. Turn people off from **Team → Deactivate**; it signs them out everywhere immediately.
- Every permission is checked on the server, not just hidden in the screens.
- Interviewers can only open the candidates they're scheduled to interview.
- `.env` holds your keys. Keep it on the server only, and limit who can SSH into the Lightsail instance.
- Candidate data stays in your AWS server and your Google Drive. Resume text is sent to the Claude API only to write the summary.
- Deleting a candidate in the app keeps their resume in Drive. Delete the file there too if a candidate asks for their data to be removed.
