# Bugcrowd Blackbox Dashboard Pack

Extracted: 2026-06-08

Sources:
- Main program page: https://bugcrowd.com/engagements/bugcrowd
- Main policy JSON: https://bugcrowd.com/engagements/bugcrowd/changelog/1ae12edd-3c69-4985-82c5-46fafede3ebc.json
- Main policy published_at: 2026-05-27T08:26:41.022Z
- Hack Me page: https://bugcrowd.com/engagements/hackme
- Hack Me policy JSON: https://bugcrowd.com/engagements/hackme/changelog/9667afe1-a0d4-4c3e-b4b1-7748e2f0d991.json
- Hack Me policy published_at: 2026-02-16T07:53:12.722Z

Important: do not mix the two scopes in one scan. A host can be in scope for one engagement and out of scope for the other.

## Recommended Dashboard Job

Use the main Bugcrowd program for a real bounty-oriented blackbox scan.

Suggested job name:

```text
Bugcrowd main - low-noise blackbox - 2026-06-08
```

Suggested scan profile:

```text
Profile: low-noise authenticated-or-public web blackbox
Concurrency: 1-2 workers
Rate limit: low; avoid burst traffic
Crawl depth: shallow-to-medium
Respect scope allowlist strictly
Manual validation required before reporting
Disable destructive, availability, brute-force, spam, phishing, social-engineering, and DoS modules
Disable rate-limit testing
Disable prompt-injection reporting modules for this program
Disable EXIF-only findings on file attachments
Disable username-format / staff-impersonation-only checks
Do not test third-party services unless the finding is clearly Bugcrowd misconfiguration or insecure usage
```

Authentication:

```text
Only use credentials you can self-provision.
No supplemental credentials or access will be provided.
Do not test other researchers, customers, staff accounts, or real customer bounty environments.
```

Disclosure:

```text
Explicit permission is required to disclose submission results.
```

## Main Program: Include Targets

Program:

```text
Name: Bugcrowd
Type: Bug Bounty
Status: in_progress
Participation: open
Safe Harbor: full
Started: 2013-09-07T01:00:00Z
```

Primary in-scope targets:

```text
https://docs.bugcrowd.com/
https://bugcrowd.com/programs
https://tracker.bugcrowd.com
https://api.bugcrowd.com
https://gov.bugcrowd.net
https://*.gov.bugcrowd.net
https://identity.bugcrowd.com/
*.bugcrowd.com/auth/*
```

Tags / technology hints:

```text
docs.bugcrowd.com: HTML, Website Testing
bugcrowd.com/programs: Elasticsearch, Ruby on Rails, PostgreSQL, ReactJS, Website Testing
tracker.bugcrowd.com: Elasticsearch, Ruby on Rails, PostgreSQL, ReactJS, Website Testing
api.bugcrowd.com: API Testing, Elasticsearch, Ruby on Rails, JSON, PostgreSQL, HTTP
gov.bugcrowd.net: AWS, Website Testing
*.gov.bugcrowd.net: AWS, Website Testing
identity.bugcrowd.com: Docker, API Testing, Website Testing, Kotlin
*.bugcrowd.com/auth/*: Docker, API Testing, Website Testing, Kotlin
```

Reward ranges:

```text
Main targets:
P1: 2501-10000 USD
P2: 901-2500 USD
P3: 301-900 USD
P4: 300 USD

Beta feature targets:
P1: 1500-5000 USD
P2: 500-1500 USD
P3: 100-500 USD
P4: 100 USD
```

Beta feature note:

```text
identity.bugcrowd.com and *.bugcrowd.com/auth/* are beta centralized-auth targets.
Not everyone may have access to the endpoint.
Reports may be duplicated to internal reports.
Rewards differ from the main program.
```

Government target note:

```text
Government (.gov) targets may not be publicly accessible.
```

## Main Program: Exclude / Blocklist

Block these explicitly:

```text
bugcrowd*.freshdesk.com
https://www.bugcrowd.com
blog.bugcrowd.com
researcherdocs.bugcrowd.com
pages.bugcrowd.com
forum.bugcrowd.com
email.bugcrowd.com
email.forum.bugcrowd.com
https://go.bugcrowd.com
events.bugcrowd.com
https://assetinventory.bugcrowd.com
https://community.bugcrowd.com
trust.bugcrowd.com
Social Engineering
```

Third-party / non-authorized service areas called out by the policy:

```text
www.bugcrowd.com, blog.bugcrowd.com: Pantheon
forum.bugcrowd.com: Discourse
email.bugcrowd.com, email.forum.bugcrowd.com: Mailgun
collateral.bugcrowd.com: Outreach
bounce.bugcrowd.com, go.bugcrowd.com, ww2.bugcrowd.com: Marketo
pages.bugcrowd.com: Hubspot
researcherdocs.bugcrowd.com: Readme.io
events.bugcrowd.com: Splash
assetinventory.bugcrowd.com: BitDiscovery
bugcrowd*.freshdesk.com: Freshdesk
bugcrowd-support.freshdesk.com support widget: Freshdesk
github.com/bugcrowd PRs, Issues etc: only credential leakage or critical impact is potentially relevant
trust.bugcrowd.com: Safebase
All Jumio related endpoints: Jumio / NetVerify
```

Out-of-scope / not useful findings:

```text
Reports lacking manual validation
Reports solely reliant on automated tools/scanners
Theoretical attack vectors without proof of exploitability
Rate limiting
EXIF data not stripped from file attachments on submissions
github.com/bugcrowd.com PRs and Issues, unless credential leakage or critical impact
Prompt injection vulnerabilities
Username-only staff/customer/ASE impersonation format issues
Adding any variation of *_bugcrowd to a normal username
Disruptive testing that affects other researchers, customers, systems, or accounts
```

## Main Program: Dashboard Filters

Allowlist patterns:

```text
^https://docs\.bugcrowd\.com/
^https://bugcrowd\.com/programs
^https://bugcrowd\.com/engagements
^https://tracker\.bugcrowd\.com/
^https://api\.bugcrowd\.com/
^https://gov\.bugcrowd\.net/
^https://([a-zA-Z0-9-]+\.)*gov\.bugcrowd\.net/
^https://identity\.bugcrowd\.com/
^https://([a-zA-Z0-9-]+\.)?bugcrowd\.com/auth/
```

Blocklist patterns:

```text
^https://www\.bugcrowd\.com/
^https://blog\.bugcrowd\.com/
^https://researcherdocs\.bugcrowd\.com/
^https://pages\.bugcrowd\.com/
^https://forum\.bugcrowd\.com/
^https://email\.bugcrowd\.com/
^https://email\.forum\.bugcrowd\.com/
^https://go\.bugcrowd\.com/
^https://events\.bugcrowd\.com/
^https://assetinventory\.bugcrowd\.com/
^https://community\.bugcrowd\.com/
^https://trust\.bugcrowd\.com/
^https://.*bugcrowd.*\.freshdesk\.com/
^https://bugcrowd-support\.freshdesk\.com/
^https://github\.com/bugcrowd/
.*jumio.*
.*netverify.*
```

Recommended first scan target subset:

```text
https://docs.bugcrowd.com/
https://bugcrowd.com/programs
https://api.bugcrowd.com
```

Hold for manual review before including:

```text
https://tracker.bugcrowd.com
https://gov.bugcrowd.net
https://*.gov.bugcrowd.net
https://identity.bugcrowd.com/
*.bugcrowd.com/auth/*
```

## Hack Me Program

Use this only as a separate training/demo scan. It is no-reward and not monitored by Bugcrowd staff for real Bugcrowd vulnerabilities.

Program:

```text
Name: Hack Me!
Type: Vulnerability Disclosure
Status: in_progress
Participation: open
Reward allocation: no_reward
Safe Harbor: full
Started: 2013-09-27T06:00:00Z
```

Hack Me notes:

```text
Submissions are not rewarded and do not earn points.
The program is not monitored by Bugcrowd staff.
Legitimate Bugcrowd platform vulnerabilities should be submitted to the main Bugcrowd bug bounty program.
Challenge flag: It's a trap!
```

Hack Me in-scope:

```text
https://www.bugcrowd.com
https://api.bugcrowd.com
All IT-Managed Third-Party Services and Infrastructure
http://www.bugcrowd.com with IP 192.168.0.1, name "Test by AN", internal-use test target
https://www.bugcrowd.com/hackme-external-form/
```

Hack Me out-of-scope:

```text
https://docs.bugcrowd.com/
researcherdocs.bugcrowd.com
https://tracker.bugcrowd.com
```

Hack Me VRT / exclusions:

```text
Automotive Security Misconfiguration: out of scope
Blockchain Infrastructure Misconfiguration: out of scope
Application-Level Denial-of-Service (DoS): out of scope
EXIF/manual user-enumeration category: out of scope
Physical Security Issues on api.bugcrowd.com authentication vulnerabilities: conditional
Broken Access Control on api.bugcrowd.com requiring knowledge of a UUID: conditional, not considered valid
Fingerprinting/Banner Disclosure: conditional
```
