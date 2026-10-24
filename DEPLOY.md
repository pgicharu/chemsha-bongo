# Deploying

How to run Chemsha Bongo on a VPS with HTTPS, real email, Grafana with
logins and nightly backups, and how to operate and wind it down.

The server runs the same stack as a laptop ([README.md](README.md)) with
`docker-compose.prod.yml` on top: **Caddy** in front with automatic HTTPS,
**no public ports** except 80 and 443, **Grafana with logins**, and
production app settings (no bots, real email). Commands run on the server
unless marked "on your laptop".

## What is public

| What | Access |
| --- | --- |
| The app | `https://APP_DOMAIN` (Caddy → `app:3000`, websockets included) |
| `/metrics` | `https://APP_DOMAIN/metrics`, public by default (see [Winding down](#winding-down)) |
| Grafana | `https://GRAFANA_DOMAIN`, login required, users are Viewers |
| Prometheus, Alloy, Netdata, Uptime Kuma | SSH tunnel only (server's `127.0.0.1`) |
| Postgres | not published: `make psql` on the server |
| Chaos switches | not published, not proxied: `make prod-chaos` on the server |

```
internet ──80/443──▶ caddy ──▶ app:3000 ──▶ postgres
                          └──▶ lgtm:3000 (Grafana)
ssh -L ──▶ 127.0.0.1:9090 Prometheus · :12345 Alloy · :19999 Netdata · :3002 Uptime Kuma
```

## 0. Requirements

- **A VPS**: Ubuntu 24.04 LTS or Debian 13; 4 GB RAM, 2 vCPU, 40 GB disk
  recommended. 2 GB works without Netdata and Uptime Kuma (see
  [Memory](#memory)).
- **A domain** with two names, e.g. `quiz.example.com` (`APP_DOMAIN`) and
  `grafana.example.com` (`GRAFANA_DOMAIN`).
- **An SMTP provider** (Brevo's free plan is used below) and access to the
  domain's DNS.
- An SSH key pair (`ssh-keygen -t ed25519`).

## 1. Prepare the server

Log in as root (or the provider's default user) the first time.

**Non-root user:**

```sh
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
```

Confirm `ssh deploy@<server-ip>` works, then disable password and root
logins (keep the current session open until a new one is tested):

```sh
sudo tee /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
EOF
sudo systemctl reload ssh
```

**Updates, firewall, time zone:**

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y git make unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades    # Yes: daily security updates
sudo timedatectl set-timezone Africa/Nairobi       # cron times below are local

sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp      # HTTP/3
sudo ufw enable
```

> **Docker and ufw.** Docker writes its own firewall rules, so a port a
> container publishes on `0.0.0.0` is reachable from the internet **even if
> ufw blocks it**. That is why `docker-compose.prod.yml` publishes nothing
> publicly except Caddy's 80/443, and why the laptop setup (`make up`) must
> never be run on the server: it publishes the app on port 3000.

unattended-upgrades does not reboot on its own. When
`/var/run/reboot-required` exists, reboot at a quiet time; containers come
back automatically (`restart: unless-stopped`).

**Docker Engine and the Compose plugin** (Ubuntu shown; on Debian replace
both `ubuntu` with `debian`):

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker deploy     # log out and back in
docker compose version
```

Membership of the `docker` group is equivalent to root; only `deploy` gets it.

**Swap.** The app image is built on the server (`npm ci` and Vite); swap
turns a brief memory spike into a slowdown instead of an OOM kill:

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system
free -h
```

## 2. DNS

| Name | Type | Value |
| --- | --- | --- |
| `APP_DOMAIN` | A | server IPv4 |
| `GRAFANA_DOMAIN` | A | server IPv4 |
| both, optional | AAAA | server IPv6, **only** if it really works |

A broken AAAA record makes Let's Encrypt fail (it tries IPv6 first). Caddy
requests certificates on first start, so DNS must resolve before then:

```sh
dig +short quiz.example.com A
dig +short grafana.example.com A
```

## 3. Code and `.env`

```sh
cd ~
git clone https://github.com/<account>/chemsha-bongo.git
cd chemsha-bongo
git checkout main
cp .env.example .env
chmod 600 .env
```

Generate secrets:

```sh
openssl rand -hex 32       # SESSION_SECRET
openssl rand -hex 24       # POSTGRES_PASSWORD
openssl rand -hex 24       # GRAFANA_DB_PASSWORD
openssl rand -hex 24       # CHAOS_TOKEN (optional)
openssl rand -base64 18    # GRAFANA_ADMIN_PASSWORD
```

Values to change:

| Variable | Server value |
| --- | --- |
| `SESSION_SECRET` | random |
| `POSTGRES_PASSWORD` | random |
| `DATABASE_URL` | `postgres://chemsha:<POSTGRES_PASSWORD>@postgres:5432/chemsha` |
| `GRAFANA_DB_PASSWORD` | random |
| `ALLOW_BOTS` | `false` (also forced by `docker-compose.prod.yml`) |
| `CHAOS_TOKEN` | random to enable chaos switches, empty to disable; never committed |
| `LOG_LEVEL` | `info` |
| `MAIL_FROM` | `"Chemsha Bongo <quiz@your-domain>"` (section 4) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | e.g. `smtp-relay.brevo.com` / `587` / `false` |
| `SMTP_USER` / `SMTP_PASS` | SMTP login / key (section 4) |
| `APP_DOMAIN`, `GRAFANA_DOMAIN` | the names from section 2 (uncomment) |
| `ACME_EMAIL` | address for certificate notices |
| `GRAFANA_ADMIN_PASSWORD` | random |
| `COMPOSE_PROFILES` | `uptime,netdata` (empty on a 2 GB server) |
| `COMPOSE_FILE` | `docker-compose.yml:docker-compose.prod.yml`, so plain `docker compose` commands use the production files |

`APP_BASE_URL` and `EMAIL_TRANSPORT` are set by `docker-compose.prod.yml`
(`https://APP_DOMAIN` and `smtp`). Leave `BOTS_URL`, `TRAFFIC_BOTS`,
`OTEL_*` and the rootless-Docker lines alone.

Validate (Compose names any missing required value):

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet && echo OK
```

## 4. Email

The app speaks plain SMTP, so any provider works. Steps for Brevo:

1. Create an account at brevo.com and complete its sign-up checks.
2. **Authenticate the sending domain**: *Settings → Senders, Domains &
   Dedicated IPs → Domains → Add a domain*. Copy the DNS records Brevo shows
   for the account; typically:

   | Record | Type | Name | Value |
   | --- | --- | --- | --- |
   | Brevo code | TXT | `@` | `brevo-code=…` |
   | DKIM | TXT or CNAME, as shown | e.g. `brevo1._domainkey`, `brevo2._domainkey` | as shown |
   | SPF | TXT | `@` | `v=spf1 include:spf.brevo.com ~all` (if asked) |
   | DMARC | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@your-domain` |

   A domain may have only one `v=spf1` record; if one exists, add
   `include:spf.brevo.com` to it. Start DMARC at `p=none` and tighten once
   reports show Brevo passing; keep any existing DMARC record. Press
   **Authenticate** once the records resolve.
3. **Add a sender** on that domain (*Senders → Add a sender*); this is
   `MAIL_FROM`.
4. **Generate an SMTP key**: *SMTP & API → SMTP*. The page shows the SMTP
   login (`SMTP_USER`); the key (`SMTP_PASS`) is shown once.
5. In `.env`:

   ```sh
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587          # STARTTLS
   SMTP_SECURE=false      # true only for port 465
   SMTP_USER=<SMTP login>
   SMTP_PASS=<SMTP key>
   MAIL_FROM="Chemsha Bongo <quiz@your-domain>"
   ```

6. Check the port is not blocked:
   `timeout 5 bash -c '</dev/tcp/smtp-relay.brevo.com/587' && echo reachable`.

Brevo's free plan allows 300 emails per day (check current pricing). Bots
never send email.

**Troubleshooting:**

- `make prod-logs`, look for `email.failed` (or Grafana:
  `{service="app"} | event="email.failed"`). `EAUTH` / response code 535:
  wrong login or key. `ETIMEDOUT` / `ECONNECTION`: port blocked or wrong
  host.
- `email.sent` but nothing arrives: check Brevo's *Transactional → Logs*.
- Spam folder: usually the domain is not yet authenticated or `MAIL_FROM` is
  not on it.
- Microsoft 365 recipients: new senders may be quarantined silently. Ask the
  recipient's IT to release or allow-list the domain, and send a test to
  such an address before going live.

## 5. Start

```sh
make prod-up        # first build takes a few minutes
make prod-ps        # all Up; services with health checks (healthy)
docker compose logs caddy | grep -i 'certificate obtained'    # one per domain
```

**Checks, on your laptop:**

```sh
curl -sI http://quiz.example.com | head -3          # 308 → https://
curl -s https://quiz.example.com/health             # {"status":"ok"}
curl -s https://quiz.example.com/metrics | head -3  # Prometheus text
curl -sI https://grafana.example.com/ | grep -i location   # /login
nc -vz -w 3 <server-ip> 3000 ; nc -vz -w 3 <server-ip> 5432 ; nc -vz -w 3 <server-ip> 9090   # all must fail
```

On the server, `sudo ss -ltnp` should show only 22, 80 and 443 on `0.0.0.0` /
`[::]`; everything else on `127.0.0.1`.

**By hand:** sign up with a real address (the confirmation link should start
with `https://APP_DOMAIN`); host a short live quiz and join from a phone on
mobile data; log in to Grafana as `admin` with `GRAFANA_ADMIN_PASSWORD` and
query `chemsha_answers_total`, `{service="app"}` and `{service="caddy"}`
(Caddy's access log).

### Grafana users

Users get **Viewer** accounts: Explore and panel queries, but no saving
dashboards or editing data sources. `docker-compose.prod.yml` sets
`GF_USERS_VIEWERS_CAN_EDIT` so Viewers can use Explore, and
`GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer` for new accounts. If a future Grafana
drops `viewers_can_edit`, make them Editors instead.

Create users in *Administration → Users and access → Users → New user*, or
in bulk from a `users.csv` of `login,name,email` lines (on your laptop):

```sh
G=https://grafana.example.com
read -rs -p 'Grafana admin password: ' GPW; echo
while IFS=, read -r login name email; do
  pw=$(openssl rand -base64 12)
  curl -fsS -u "admin:$GPW" -H 'Content-Type: application/json' -X POST "$G/api/admin/users" \
    -d "{\"name\":\"$name\",\"email\":\"$email\",\"login\":\"$login\",\"password\":\"$pw\"}" >/dev/null \
    && echo "$login,$pw"
done < users.csv > user-passwords.csv
```

Users can change their password under their profile.

**Admin password.** `GRAFANA_ADMIN_PASSWORD` is only read on first start with
an empty `lgtm-data` volume. To change it later:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec lgtm sh -c \
  'cd /otel-lgtm/grafana && GF_PATHS_DATA=/data/grafana/data GF_PATHS_PLUGINS=/data/grafana/plugins \
   ./bin/grafana cli --homepath /otel-lgtm/grafana admin reset-admin-password "NEW-PASSWORD"'
```

**Reference dashboards.** `make prod-dashboards-up` instead of `make prod-up`
adds the dashboards from `dashboards/` (visible to Viewers); `make prod-up`
removes them.

### Uptime Kuma first run

Uptime Kuma creates its admin account on the **first visit**, from whoever
arrives first, so do it immediately after the first `make prod-up` through
the SSH tunnel: open <http://localhost:13002> and create the admin. Add two
HTTP monitors:

- `http://app:3000/health` (inside Docker)
- `https://APP_DOMAIN/health` (the public path: DNS, HTTPS, Caddy)

Keep it tunnel-only. It can be published at `UPTIME_DOMAIN` (commented block
at the end of `deploy/Caddyfile`), but only after the admin account exists.

### SSH tunnels

On your laptop (different local ports, so they don't clash with a local
stack):

```sh
ssh -N \
  -L 19090:127.0.0.1:9090 \
  -L 22345:127.0.0.1:12345 \
  -L 29999:127.0.0.1:19999 \
  -L 13002:127.0.0.1:3002 \
  deploy@<server-ip>
```

Then: Prometheus <http://localhost:19090>, Alloy <http://localhost:22345>,
Netdata <http://localhost:29999>, Uptime Kuma <http://localhost:13002>.

## 6. Backups

`deploy/backup.sh` runs `pg_dump -Fc` into
`~/backups/chemsha-bongo/chemsha-<UTC time>[-label].dump` (owner-only),
deletes dumps older than 14 days, prints one line and exits non-zero on
failure. Run it once (this also creates the log folder):

```sh
make prod-backup
```

Schedule with `crontab -e` as `deploy`:

```cron
# Nightly at 02:30
30 2 * * *   cd ~/chemsha-bongo && ./deploy/backup.sh nightly >> ~/backups/chemsha-bongo/backup.log 2>&1
# Optional: weekdays at 17:30, before regular sessions
30 17 * * 1-5 cd ~/chemsha-bongo && ./deploy/backup.sh pre-session >> ~/backups/chemsha-bongo/backup.log 2>&1
```

Check with `tail ~/backups/chemsha-bongo/backup.log`.

**Copy backups off the server** (on your laptop):

```sh
rsync -av deploy@<server-ip>:backups/chemsha-bongo/ ~/chemsha-backups/
```

Dumps contain email addresses and password hashes; keep copies private.

**Restore:** `make prod-restore FILE=~/backups/chemsha-bongo/<file>.dump`
(or `./deploy/restore.sh <file>`). It shows the target database and project
and asks for the database name to be typed, takes a `pre-restore` backup,
stops the app, re-creates the database from the dump and starts the app.
Players are disconnected for a few seconds and any live game is lost.

## 7. Operating

| Task | Command |
| --- | --- |
| App and Caddy logs | `make prod-logs` (or Grafana → Loki) |
| Status, memory | `make prod-ps`, `make stats` |
| Chaos switches | `make prod-chaos ARGS=status`, `ARGS="slow-scoring on"`, `ARGS="all off"` |
| Re-score a quiz | `make prod-rescore ARGS="--quiz 12 --dry-run"`, then without `--dry-run` |
| SQL prompt | `make psql` |
| Restart the app | `docker compose -f docker-compose.yml -f docker-compose.prod.yml restart app` |
| Apply an edited `.env` | `make prod-up` (restart does not re-read `.env`) |
| Apply an edited Caddyfile | `make prod-caddy-reload` (connections stay open) |
| Backup now | `make prod-backup` |

Chaos switches need `CHAOS_TOKEN`; their control port (9091) listens only
inside the app container and must never be published or proxied.

**Restarting the app ends any live game** (marked `abandoned`), so restart,
update or roll back between games. Never run `make up`, `make reset` or
`docker compose down -v` on the server.

**Update:**

```sh
make prod-backup
git pull
make prod-up           # rebuilds the app; unchanged containers are left alone
```

**Run another version** (a tag, commit or branch), then return to `main`:

```sh
./deploy/backup.sh before-switch
git fetch && git checkout <tag, commit or branch>
make prod-up
git checkout main && make prod-up
```

Migrations only go forward: rolling code back does not undo a migration. To
fully undo a release that changed the schema, restore the backup taken
before it.

## Memory

Limits (`deploy.resources.limits.memory`) and usage on the production stack
with no traffic, a few minutes after start. `lgtm` grows as it stores data.

| Service | Limit | Measured | On a 2 GB server |
| --- | ---: | ---: | --- |
| `lgtm` (Grafana, Prometheus, Loki, Tempo) | 1536 MiB | 710 MiB (800 after hours) | keep |
| `netdata` | 384 MiB | 150 MiB | **drop** |
| `uptime-kuma` | 256 MiB | 112 MiB | **drop** |
| `app` | 384 MiB | 80 MiB | keep |
| `postgres` | 384 MiB | 60 MiB | keep |
| `alloy` | 256 MiB | 45 MiB | keep |
| `caddy` | 128 MiB | 30 MiB | keep |
| **Total** | **3328 MiB** | **about 1.2 GiB** | **about 0.95 GiB** (limits 2688 MiB) |

- **4 GB (recommended)**: everything, with room for builds and the OS.
- **2 GB**: set `COMPOSE_PROFILES=` (empty) in `.env`, run
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml rm -sf netdata uptime-kuma`,
  then `make prod-up`. The 2 GB of swap is required. Use `make stats` for
  resource use and run external checks from elsewhere.

Disk: images take about 10 GB, a week of telemetry a few hundred MB. Check
with `df -h` and `docker system df`.

## Security checklist

- [ ] `.env` has fresh random `SESSION_SECRET`, `POSTGRES_PASSWORD` (also in
      `DATABASE_URL`), `GRAFANA_DB_PASSWORD`, `GRAFANA_ADMIN_PASSWORD` and,
      if used, `CHAOS_TOKEN`; `chmod 600 .env`; never committed
- [ ] `ALLOW_BOTS=false`
- [ ] Port 9091 not reachable (`nc -vz <server-ip> 9091` fails)
- [ ] `https://GRAFANA_DOMAIN/` redirects to `/login`; `admin`/`admin` refused
- [ ] Postgres not reachable; only 22/80/443 public (`sudo ss -ltnp`)
- [ ] Uptime Kuma admin account created
- [ ] `make prod-backup` works, cron installed, a copy kept off the server
- [ ] ufw active, SSH password login off, unattended-upgrades on

## Winding down

1. **Final backup**, copied off the server.
2. **Hide `/metrics`**: in `deploy/Caddyfile` uncomment
   `respond /metrics* 404`, then `make prod-caddy-reload`. Check that
   `curl -sI https://APP_DOMAIN/metrics` returns 404. Prometheus still
   scrapes inside Docker.
3. **Rotate secrets** if the server stays up, then `make prod-up`:
   - `CHAOS_TOKEN`: empty (switches disabled).
   - `SESSION_SECRET`: new value (logs everyone out).
   - `GRAFANA_DB_PASSWORD`: new value (app and Grafana pick it up).
   - `POSTGRES_PASSWORD`: first `make psql` and
     `ALTER USER chemsha WITH PASSWORD '<new>';`, then update
     `POSTGRES_PASSWORD` and `DATABASE_URL`.
   - Grafana admin password (command above); delete or disable user
     accounts.
   - Delete the SMTP key at the provider.
4. Or stop it: `make prod-down` (data kept), and destroy the VPS once
   backups are safe elsewhere.
