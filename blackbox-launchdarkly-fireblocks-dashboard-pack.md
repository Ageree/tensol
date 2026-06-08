# LaunchDarkly / Fireblocks Bugcrowd Dashboard Pack

Extracted: 2026-06-08

Sources:
- LaunchDarkly page: https://bugcrowd.com/engagements/launchdarkly-mbb-og
- LaunchDarkly policy JSON: https://bugcrowd.com/engagements/launchdarkly-mbb-og/changelog/b6c4b37c-f459-47fd-9886-d54f77a8d8ae.json
- LaunchDarkly policy published_at: 2026-06-03T15:05:46.514Z
- Fireblocks page: https://bugcrowd.com/engagements/fireblocks-mbb-og
- Fireblocks policy JSON: https://bugcrowd.com/engagements/fireblocks-mbb-og/changelog/a035263c-3b03-4e81-b159-75026dd0a2fd.json
- Fireblocks policy published_at: 2026-02-12T13:49:31.665Z

Do not mix these programs in one scan. Each engagement has its own in-scope list, out-of-scope rules, credentials notes, and severity/reward policy.

## Recommendation

For a first dashboard-driven blackbox run, use Fireblocks if your platform is strongest at API/service blackbox and you want a compact scope.

Use LaunchDarkly if your platform supports authenticated web/API scanning and you can provide a self-created `@bugcrowdninja.com` account/session.

## Shared Safe Scan Profile

```text
Profile: low-noise bug bounty blackbox
Concurrency: 1-2 workers
Rate limit: conservative
Crawl depth: shallow-to-medium
Follow redirects: yes, but never leave allowlist
Respect strict allowlist and blocklist
Require manual validation before reporting
Disable DoS, DDoS, volumetric, stress, brute-force, rate-limit bypass, email bombing/flooding
Disable social engineering, phishing, physical attack, MITM, and third-party-provider testing
Stop immediately if a finding may modify/delete data, transfer funds/assets, or affect other users
Do not target other users' data or accounts
Do not use leaked/stolen credentials
```

## Option A: Fireblocks

Suggested dashboard job:

```text
Fireblocks MBB - low-noise API blackbox - 2026-06-08
```

Program metadata:

```text
Name: Fireblocks Web Managed Bug Bounty Engagement
Type: Bug Bounty
Status: in_progress
Participation: open
Safe Harbor: full
Started: 2025-09-09T06:00:00Z
Scope rating: 1/4
Reward allocation: pay_for_success
```

In-scope targets:

```text
https://sb-console-api.fireblocks.io
https://sb-mobile-api.fireblocks.io
https://sandbox-api.fireblocks.io
```

Tags:

```text
sb-console-api.fireblocks.io: Cryptography, Cryptocurrency
sb-mobile-api.fireblocks.io: Cryptography, Cryptocurrency
sandbox-api.fireblocks.io: Cryptography, Cryptocurrency
```

Reward ranges:

```text
P1: 7000-12000 USD
P2: 1000-9000 USD
P3: 300-1500 USD
P4: 20-300 USD
P5: no reward
```

Access / credentials:

```text
Create an account with an @bugcrowdninja.com email address.
Registration does not work with other email domains.
Policy links Fireblocks sandbox docs:
https://developers.fireblocks.com/docs/sandbox-quickstart
https://developers.fireblocks.com/docs/postman-guide
```

Focus areas:

```text
Unauthorized actions, especially unauthorized funds transfer
Sensitive or personally identifiable information disclosure
XSS
CSRF for sensitive functions in a privileged context
Server-side or remote code execution
Authentication or authorization flaws, including IDOR and auth bypass
Injection vulnerabilities, including SQL and XML injection
Directory traversal
Significant security misconfiguration with a verifiable vulnerability
```

Excluded / out of scope:

```text
P5 vulnerabilities
Availability / volumetric testing
DoS / DDoS / Network DoS
Rate limiting bypass attempts
Email bombing / flooding
Social engineering
Phishing
Physical attacks
Third-party providers and services
Manipulating other stakeholders or their accounts
N-day / third-party 0-days less than 14 days after public release
```

Fireblocks allowlist patterns:

```text
^https://sb-console-api\.fireblocks\.io(/|$)
^https://sb-mobile-api\.fireblocks\.io(/|$)
^https://sandbox-api\.fireblocks\.io(/|$)
```

Fireblocks blocklist patterns:

```text
^https?://(?!sb-console-api\.fireblocks\.io|sb-mobile-api\.fireblocks\.io|sandbox-api\.fireblocks\.io).*
.*third[- ]?party.*
.*phishing.*
.*social.*
.*dos.*
.*ddos.*
.*rate.?limit.*
```

Suggested first Fireblocks target subset:

```text
https://sandbox-api.fireblocks.io
```

Then add, after manual review:

```text
https://sb-console-api.fireblocks.io
https://sb-mobile-api.fireblocks.io
```

## Option B: LaunchDarkly

Suggested dashboard job:

```text
LaunchDarkly MBB - low-noise web/API blackbox - 2026-06-08
```

Program metadata:

```text
Name: LaunchDarkly Managed Bug Bounty Engagement
Type: Bug Bounty
Status: in_progress
Participation: open
Safe Harbor: full
Started: 2026-05-19T18:00:00Z
Scope rating: 2/4
Reward allocation: pay_for_success
```

In-scope targets:

```text
https://app.launchdarkly.com
https://app.launchdarkly.com/api/v2/
https://app.launchdarkly.com/internal/
https://app.launchdarkly.com/private/
https://events.launchdarkly.com
https://stream.launchdarkly.com
https://docs.launchdarkly.com
https://launchdarkly.com/docs
LaunchDarkly open source SDK repositories ending in -sdk
```

Target notes:

```text
app.launchdarkly.com is the main application.
/api/v2/ and /internal/ are customer-facing APIs and require an ldso session cookie or access token.
/private/ APIs are not intended to allow authentication to non-LaunchDarkly users; improper accessibility is noteworthy.
events.launchdarkly.com records SDK events for metrics.
stream.launchdarkly.com provides flag information to SDKs.
docs.launchdarkly.com is mostly static but has search/user input and cross-origin requests to app.launchdarkly.com.
SDK testing requires generating SDK keys/client IDs from the UI.
```

Tags:

```text
app.launchdarkly.com: Elasticsearch, PostgreSQL, ReactJS, MongoDB, Javascript
events.launchdarkly.com: Elasticsearch, AWS, Go, PostgreSQL, MongoDB
stream.launchdarkly.com: AWS, Go
LaunchDarkly Open Source SDKs: Java, Rust, Haskell, Objective-C, ASP.NET, C++, ReactJS, C#, PHP, Vue.js, Ruby, NodeJS, Python, Javascript
docs.launchdarkly.com: no tags listed
https://launchdarkly.com/docs: no tags listed
```

Reward ranges:

```text
P1: 6500-7500 USD
P2: 2500 USD
P3: 1250 USD
P4: 150 USD
P5: no reward
```

Access / credentials:

```text
All accounts must be created using an @bugcrowdninja.com email address.
Use your own test credentials only.
For API testing, create an access token in Account Settings or use your own ldso session cookie after logging in.
Do not target other users' data; use another self-controlled test account when needed.
```

Focus areas:

```text
Improper authentication/access control
Privilege escalation beyond the assigned role
XSS / SSRF in user input fields
Unauthenticated or unauthorized API access
APIs returning data from other accounts/environments or data outside the user role
Handler logic errors causing unexpected behavior
Custom Contexts functionality
Experimentation functionality
SDK / streamer / event-recorder logic issues
Docs search/input XSS or injection
CSRF involving cross-origin requests to app.launchdarkly.com
N-day issues exploitable in in-scope targets
Leaked credentials only under the policy's eligibility conditions
```

Known issue:

```text
Rate limiting on account verification and forgot password pages is known and not eligible.
```

Out-of-scope targets:

```text
blog.launchdarkly.com
launchdarkly.com
sandbox.launchdarkly.com
slack.launchdarkly.com
status.launchdarkly.com
https://launchdarkly.atlassian.net
All LaunchDarkly domains/properties not explicitly listed as in scope
All subdomains not explicitly listed as in scope
Non-SDK open source repositories
```

Excluded submission types:

```text
Low-effort or AI-generated reports without original analysis
Third-party integrations and endpoints
Availability / volumetric testing
DoS / DDoS / Network DoS
Rate limiting bypass attempts
Email bombing or flooding
All forms of social engineering
Clickjacking on pages with no sensitive actions
CSRF on unauthenticated forms or forms with no sensitive actions
Attacks requiring MITM or physical device access
Previously known vulnerable libraries without a working PoC
CSV injection without LaunchDarkly-specific vulnerability
Missing SSL/TLS best practices
Any activity disrupting service
Content spoofing/text injection without HTML/CSS modification
Rate limiting or brute-force issues on non-authentication endpoints
Missing CSP best practices
Missing HttpOnly/Secure flags, except the ldso cookie
Missing SPF/DKIM/DMARC/email best practices
Issues affecting only outdated or unpatched browsers more than two stable versions behind
Issues affecting uncommon browser extensions
Software version disclosure, banner identification, descriptive errors, stack traces
Public zero-days with official patch less than 1 month old: case-by-case
Tabnabbing
Open redirect unless additional impact is demonstrated
Unlikely-user-interaction findings
Non-SDK repositories
Dependency/vulnerability scans of source code without deeper analysis
Client-side SDK keys intended to be public
Client-side website keys/tokens intended to be public, including Algolia search API key and TrackJS analytics token
Jira ServiceDesk public registration
Verification email inbox spam
HTML injection in text fields or generated emails
Password reset link not expiring after email address change
Open source GitHub findings not related to client/server SDK repos suffixed by -sdk
P5 vulnerabilities
```

LaunchDarkly allowlist patterns:

```text
^https://app\.launchdarkly\.com(/|$)
^https://app\.launchdarkly\.com/api/v2(/|$)
^https://app\.launchdarkly\.com/internal(/|$)
^https://app\.launchdarkly\.com/private(/|$)
^https://events\.launchdarkly\.com(/|$)
^https://stream\.launchdarkly\.com(/|$)
^https://docs\.launchdarkly\.com(/|$)
^https://launchdarkly\.com/docs(/|$)
```

LaunchDarkly blocklist patterns:

```text
^https://blog\.launchdarkly\.com(/|$)
^https://launchdarkly\.com/(?!docs)
^https://sandbox\.launchdarkly\.com(/|$)
^https://slack\.launchdarkly\.com(/|$)
^https://status\.launchdarkly\.com(/|$)
^https://launchdarkly\.atlassian\.net(/|$)
^https://[^/]*\.launchdarkly\.com(/|$)
.*third[- ]?party.*
.*phishing.*
.*social.*
.*dos.*
.*ddos.*
.*rate.?limit.*
```

Important: the generic subdomain block pattern above must be ordered after the explicit allowlist in your dashboard, or represented as "block all launchdarkly subdomains except allowlist".

Suggested first LaunchDarkly target subset:

```text
https://docs.launchdarkly.com
https://launchdarkly.com/docs
```

Then add authenticated/API targets after session setup:

```text
https://app.launchdarkly.com
https://app.launchdarkly.com/api/v2/
https://events.launchdarkly.com
https://stream.launchdarkly.com
```

Hold for manual review:

```text
https://app.launchdarkly.com/internal/
https://app.launchdarkly.com/private/
LaunchDarkly open source SDK repositories ending in -sdk
```
