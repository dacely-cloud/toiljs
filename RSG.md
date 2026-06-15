# Resilience and Scale Grade (RSG)

> One grade for an application across nine axes, where your grade is your weakest axis, never the average and never the best.

![status](https://img.shields.io/badge/status-spec-2dd4bf)
![type](https://img.shields.io/badge/type-rubric-84cc16)
![authority](https://img.shields.io/badge/external%20authority-none-8aa0a4)

RSG is an internal rubric for grading how resilient, distributed, fast, lean, and secure an application actually is, as a single letter from **AAA** down to **D**. It exists to force one honest conversation: a system is only as good as its weakest link, and a good network must never be allowed to flatter bad code.

---

## Table of contents

- [The core rule](#the-core-rule)
- [The grade table](#the-grade-table)
- [The nine axes](#the-nine-axes)
- [Latency thresholds](#latency-thresholds)
- [How to score](#how-to-score)
- [The binding axis](#the-binding-axis)
- [The stability modifier](#the-stability-modifier)
- [Worked examples](#worked-examples)
- [Design decisions](#design-decisions)
- [Relationship to real standards](#relationship-to-real-standards)

---

## The core rule

**Your grade is your weakest axis.** Not the average, not the best. To earn **AAA**, every axis must be AAA at the same time.

A globally edged frontend sitting on a single-region database is capped by the database. A fault-tolerant global system serving a one-second app is capped by latency. Clean code on one server in one region is capped by topology. The lowest column sets the grade, every time.

This is the whole point of the system. The most common lie in this space is calling something "global scale" because the read path is global, while the write path is one box in one region. The weakest-link rule refuses to let any single strong axis hide a weak one.

---

## The grade table

| Grade | Topology + distribution | Availability | Data path | Delivered p99 | Program performance + architecture | Dependencies | Security | Client performance + reach | Modern stack + compatibility |
|---|---|---|---|---|---|---|---|---|---|
| **AAA** | Active/active multi-region plus real edge compute, logic runs next to the user | 99.99%+, automated cross-region failover, no single point of failure | Globally distributed writes, sub-50ms reads almost everywhere | under 100ms | Edge-native, clean separation of requests, tasks, and compute, no blocking work on the hot path, near-optimal per request | Zero third party on the critical path, you own the stack | Zero trust, TLS everywhere, data encrypted at rest, passwords hashed never plaintext, pen-tested, audited compliance | Smooth on old and low-end devices, small bundle, no main-thread jank, linear-or-better hot paths, degrades gracefully | Latest protocols (HTTP/3, QUIC, WebTransport where they fit) with full graceful fallback, nothing breaks for older clients |
| **AA** | Primary region plus standby regions, geo read replicas, partial edge | 99.95 to 99.99%, automated regional failover | Cross-region reads, single-region writes | under 200ms | Good architecture, mostly clean separation, minor hot-path waste | Few trusted dependencies, none critical | WAF plus DDoS, encryption, compliance underway | Fast on mid-range and a few-years-old hardware, minor jank only on the weakest, good complexity at normal scale | HTTP/2 baseline, HTTP/3 where available, modern standards, compatibility kept |
| **A** | One region, multi-AZ, autoscaling stateless tier | 99.9%, survives an AZ failure | Single region, read replicas plus cache | under 500ms | Reasonable structure, some coupling, acceptable efficiency | Several third-party deps, managed | TLS, auth, secrets management, basic WAF | Smooth on current mainstream hardware, struggles on genuinely old devices, acceptable complexity at typical sizes | Current generation (HTTP/2, TLS 1.3), reasonable compatibility |
| **B** | Single region, serverless or one small group (Vercel-style) | ~99.5%, DB is effectively a single point of failure | One primary DB, latency equals distance to it | under 1s | Works but coupled, blocking work on the request path | Leans on third-party platforms and services | TLS plus auth, platform defaults | Needs fairly modern hardware to feel good, laggy on older devices, some quadratic paths that bite at larger data | Functional but dated (HTTP/1.1), works everywhere, leaves performance on the table |
| **C** | One server, one database | best effort, no real SLA | Single DB, no redundancy | 1 to 3s | Monolithic, tangled, no separation | Glued together from third-party pieces | Hand-rolled, minimal | Comfortable only on new hardware, janky elsewhere, quadratic-or-worse hot paths, heavy bundle | Legacy protocols and aging runtimes, real perf and security drag |
| **D** | Localhost, single process | none | Local | over 3s | Whatever compiles | Anything | None | Needs high-end hardware, unusable on anything old, pathological complexity, freezes on constrained devices | Obsolete or end-of-life tech, deprecated protocols, unsupported runtimes |

Each axis maps to a numeric level for scoring: `AAA = 5`, `AA = 4`, `A = 3`, `B = 2`, `C = 1`, `D = 0`.

Security has hard caps on top of these levels. Some failures, like no TLS or storing passwords in readable form, disqualify a system outright, and others cap it below AAA, see [the security axis](#7-security).

---

## The nine axes

### 1. Topology + distribution

Where your code and your points of presence physically live. This climbs from a single process on localhost, to one region, to multi-AZ inside a region, to standby regions, to true active/active multi-region with edge compute running logic next to the user. The question it answers: how close are you to your users, and how many independent places can serve them.

### 2. Availability

Your uptime and your failure behavior. Measured as an SLA percentage plus what survives a failure. The jump that matters is from "survives an instance failure" to "survives an availability-zone failure" to "survives an entire region failure with automated failover and no single point of failure." A high SLA number with a hidden single point of failure does not earn a high grade here.

### 3. Data path

How and where your data is read and written. The hardest axis to lift, because distributing writes is genuinely difficult. It climbs from a single database, to read replicas plus cache, to cross-region reads with single-region writes, to globally distributed writes with low-latency reads everywhere. This is usually the axis that secretly caps "global" systems, because reads are easy to distribute and writes are not.

### 4. Delivered p99 latency

The whole response time the user actually feels, p99, end to end, under realistic load. Network plus replication plus your application's own compute. This axis is **measured, not self-assessed**, because it is the axis that catches slow code. A globally distributed system that takes one second to respond fails here regardless of how good its topology is. See [latency thresholds](#latency-thresholds) for the exact cutoffs.

### 5. Program performance + architecture

The quality of the code on the hot path and how cleanly it is separated. AAA requires tight, edge-native code with a clean separation of requests, tasks, and compute, and no blocking work on the request path. This axis also absorbs **efficiency**, the cost or resource per request. That sub-check exists to defeat the brute-force cheat: you can hit a latency target by throwing thousands of overprovisioned instances at slow code, but that is not AAA, that is hiding bad code behind a server bill. If your cost per request is far above what the work actually demands, this axis drops even when latency looks fine.

### 6. Dependencies

How much of your critical path you actually own. AAA means zero third party on the critical path. This is the most unforgiving axis at the top, by design. One Auth0 in the login path, one Stripe call in the hot path, or one managed queue you do not control, and you are capped at **AA**, because your security and your performance are now only as good as someone else's system that you cannot inspect or fix. Most stacks that look AAA are actually AA the moment you trace their critical-path dependencies.

### 7. Security

This axis grades how hard your system is to break into and how much damage a breach would do. It is descriptive and specific, because vague security language is how insecure systems pass review. Each level is a concrete checklist, and certain failures are hard caps no matter how good everything else looks.

**AAA security.** All traffic encrypted in transit with modern TLS, all sensitive data encrypted at rest. The auth design never lets the server see a raw password at all: it uses a password-authenticated key exchange (such as SRP or OPAQUE) or a quantum-resistant equivalent, so that even a fully compromised server, proxy, or log file never captures a usable credential. Where credentials are stored, they are salted and hashed with a slow algorithm built for it (argon2, bcrypt, or scrypt). Secrets live in a managed vault with rotation, never in code or a committed config file. Every request is authenticated and authorized with no implicit trust between services (zero trust). The system actively defends against the standard attack classes: injection, cross-site scripting, request forgery, server-side request forgery, and broken access control. There is a WAF and DDoS protection in front, auth events are logged and monitored, and there is a written incident-response plan. And it is independently verified: a third-party penetration test plus the formal compliance certification appropriate to the data (see below on what compliance means).

**AA security.** Encryption in transit and at rest, the server receives the raw password over TLS and immediately hashes it with argon2, bcrypt, or scrypt (the standard, acceptable pattern that most of the web runs on), secrets management, a WAF and DDoS protection, the common attack classes covered, and monitoring. The gap from AAA is twofold: no independent verification (no recent third-party pen test, or compliance work started but not certified), and the server still handles a usable credential, which is a breach surface AAA designs out. Secure in practice, not yet audited.

**A security.** TLS everywhere, authentication and authorization in place, secrets kept out of the codebase, passwords hashed, and a basic WAF. The standard attack classes are mostly handled but not formally tested. Reasonable for a product handling normal user data, short of regulated or high-value data.

**B security.** TLS plus authentication, relying on the defaults a hosting platform gives you. Encryption and hashing happen because the platform does them, not because you designed for them. Fine for low-stakes data, thin if you hold anything sensitive.

**C security.** Hand-rolled, minimal. Auth exists but is improvised, encryption is partial, and the common attack classes are not systematically addressed. Holds personal or valuable data at real risk.

**D security.** Effectively none. No meaningful auth, no encryption, or worse.

#### Hard disqualifiers (catastrophic, cap at D)

These are not point deductions, they are caps. If any is true, the security axis is **D**, and under the weakest-link rule the whole system is D, no matter how global, fast, or clean it is.

| If this is true | Why it is catastrophic |
|---|---|
| Sensitive data transmitted with no TLS (in the clear over the network) | trivially intercepted on the wire by anyone in the path |
| Passwords stored in plaintext or reversible form, not hashed | a single database leak exposes every user's actual password |
| No authentication on an endpoint that exposes sensitive data | anyone who finds the URL can read it |

#### Design caps (serious, but not catastrophic)

These do not zero you out, but they cap how high security can climb. Each one is a real path to a data breach, just not an instant one.

| If this is true | Caps at | The breach risk |
|---|---|---|
| The server receives and processes the raw password (the standard send-over-TLS-then-hash pattern) | **B** | a server compromise, a memory dump, or one stray log line captures live, usable credentials, which is one of the most common breach paths in practice |
| Secrets committed into the repository | **C** | anyone with repo access, now or anywhere in its history, has your keys |
| Known unpatched critical vulnerabilities (CVEs) in the stack | **C** | a working public exploit already exists |
| No protection against the standard attack classes (injection, XSS, CSRF, broken access control) | **C** | the most common breach vectors are left open |

So the pattern almost the whole internet uses, a password sent over TLS to a server that then hashes it, is **not** a D. It is the acceptable baseline, and it caps security at **B**, because the server momentarily holds a usable credential, and that is a genuine data-breach surface: anything that reads server memory or logs at the wrong moment walks away with live passwords. What earns a D is sending that password over an unencrypted connection, or storing it in readable form.

To reach **AAA**, the password must never reach the server in usable form at all. That is the job of a password-authenticated key exchange (SRP, OPAQUE) or a quantum-resistant scheme, where the proof of knowledge happens without the secret ever crossing the wire in a form anyone can replay. Done right, a fully breached server still yields no credentials.

#### What "compliance" actually means

Compliance is independent, audited proof that you meet a defined security standard. It is never a standalone word, it is always compliance *with a specific framework*, and which framework depends on the data you hold:

- **SOC 2**: an audit of how a service handles customer data across security, availability, and confidentiality. The usual baseline for B2B SaaS.
- **ISO/IEC 27001**: international certification that you run a real information-security management system, not just controls.
- **PCI DSS**: required if you store, process, or transmit payment-card numbers.
- **HIPAA**: required in the US if you handle protected health information.
- **GDPR / CCPA**: legal obligations for handling personal data of EU or California residents, covering consent, access, deletion, and breach notification.

For AAA you need whichever of these your data actually triggers, certified by an outside auditor. "We take security seriously" is not compliance. A signed SOC 2 Type II report is.

This axis also interacts with dependencies: if you outsource a security-critical function to a third party on your critical path, you constrain both axes at once, because you are now trusting a system you cannot inspect.

### 8. Client performance + reach

How well the thing you ship actually runs on the user's own hardware, including old and low-end devices, and how its cost grows as data grows. This is separate from delivered latency on purpose. Latency is measured at the user, but it is usually measured on a decent device on a decent connection, so it can look excellent while the app stutters on a five-year-old phone with a weak CPU and little memory. A fast server does not save a bloated client. This axis grades the experience of the person on the worst hardware that still matters to you, not the best.

It climbs from "requires a high-end device and falls apart on anything old" up to "smooth on years-old low-end hardware, small footprint, no main-thread jank, and stays fast as data scales." A site that only feels good on a new flagship and lags hard on older devices is failing this axis no matter how clean the backend is.

#### Algorithmic complexity is part of this

How an operation scales with input size is graded here, because bad complexity is invisible on a fast machine with small data and brutal on a slow machine with real data. An O(n²) routine on a hot path looks fine in a demo and freezes a phone once the list gets long. The rule:

| Hot-path complexity (on work that grows with user data) | Effect on this axis |
|---|---|
| Linear or better, or linearithmic where unavoidable (sorting) | no penalty |
| Quadratic, O(n²), on a path that grows with user data | caps this axis at **C** |
| Worse than quadratic (cubic, exponential) on such a path | caps this axis at **D** |

The caps apply to work that actually scales with user input or data set size. A quadratic loop over a fixed list of three things is not the target, a quadratic loop over a user's growing collection is. The test: as a real user's data gets larger, does the cost explode? If yes, this axis is capped until it is fixed.

Footprint counts too: bundle size, memory use, and main-thread blocking. A multi-megabyte JavaScript bundle that takes seconds to parse on a low-end device is a real failure here even if every algorithm inside it is linear.

### 9. Modern stack + compatibility

Whether you use the current generation of protocols, standards, and runtimes, and crucially whether you do it without locking out older clients. This axis has two halves, and you need both to score well. Modern alone is not enough, and compatible alone is not enough.

The modern half: current transport and protocols where they earn their place. HTTP/3 and QUIC for lower-latency, head-of-line-blocking-free connections, WebTransport for low-latency bidirectional streams where the use case calls for it, modern TLS, current language runtimes and framework versions that still receive security patches. Sitting on HTTP/1.1 and an end-of-life runtime is leaving real performance and security on the table, and it grades low here.

The compatibility half: adopting that modern tech must not break users on older browsers, older devices, or weaker networks. The right pattern is progressive enhancement with graceful fallback. HTTP/3 negotiates down to HTTP/2 or HTTP/1.1 for clients that cannot speak it. A modern API has a path for the older client. Nobody gets a blank screen because they are one version behind.

#### Modern without compatibility is not AAA

This is the key rule of the axis, and it mirrors how you framed it. Shipping bleeding-edge tech that only works on the newest browsers, with no fallback, is not a top grade. You bought modernity by spending reach, and reach is exactly what this axis protects. So:

| Posture | Effect on this axis |
|---|---|
| Modern protocols and standards, with graceful fallback so older clients still work | **AAA** territory |
| Modern, but older clients get a degraded-yet-working experience | strong, around AA |
| Dated but universally compatible | mid, around B |
| Modern but breaks anything not on the latest browser, no fallback | caps at **C**, reach was sacrificed |
| Obsolete, end-of-life, or deprecated tech | **D** |

Note how this differs from client performance and reach (axis 8). That axis is about how fast the code runs on weak hardware. This axis is about which protocols and runtimes you speak and whether an older client can connect and function at all. A site can run fast on old hardware yet still be stuck on a dated transport, or use the newest transport yet lock out anyone a version behind. Both are graded, separately.

---

## Latency thresholds

The delivered p99 axis is derived from a measured number in milliseconds.

| Delivered p99 (end to end, under load) | Level |
|---|---|
| under 100ms | AAA |
| under 200ms | AA |
| under 500ms | A |
| under 1s | B |
| 1s to 3s | C |
| over 3s | D |

Measure at the user, not at the load balancer. The point of this axis is to capture everything between the user pressing a key and the result appearing, which is the only latency number that means anything.

---

## How to score

1. Assign each of the nine axes a level from 0 (D) to 5 (AAA), using the [grade table](#the-grade-table). Latency comes from a measured p99 via the [thresholds](#latency-thresholds).
2. The grade is the **minimum** of the nine levels.
3. Convert that level back to a letter: `5 -> AAA`, `4 -> AA`, `3 -> A`, `2 -> B`, `1 -> C`, `0 -> D`.
4. Record the [binding axis or axes](#the-binding-axis), the ones sitting at that minimum.
5. Attach the [stability modifier](#the-stability-modifier) from your guardrails.

In plain terms: take the nine axis levels, find the lowest one, and that is your grade. The lowest of topology, availability, data, latency, program, client performance, dependencies, security, and modern stack wins, and its letter is the grade.

There is no averaging anywhere. A system that is AAA on six axes and C on one is a **C**.

---

## The binding axis

A grade on its own tells you how good a system is. A grade with its binding axis also tells you what to fix. Append the axis or axes that sit at the minimum:

```
AA, dependency-bound
C, latency-bound
B, topology-bound, availability-bound, data-bound
```

This turns the grade into a to-do list. Fix the named axis, regrade, and you climb one level, until the next axis becomes the binder. When a system reaches AAA there is no binding axis, because nothing is holding it back.

---

## The stability modifier

Guardrails do not change your grade. They predict whether you keep it. So they are reported as a separate tag, never folded into the score.

| Guardrails | Tag | Meaning |
|---|---|---|
| Strict types, enforced perf budgets, regression gates in CI | **stable** | resists drifting down |
| Some guardrails, partial enforcement | **watch** | could regress without notice |
| None | **fragile** | your grade today is one careless merge from a lower one |

This is the honest resolution of a real tension. A framework that lets you write bad code should not be downgraded for merely permitting it, because the bad code already shows up in the latency and program axes, measurably, today. But a system with no guardrails is flagged **fragile**, because nothing stops it from regressing tomorrow. The result is what gets graded. The guardrails tell you how long that result will survive.

A full grade therefore reads:

```
RSG A, latency-bound, fragile
```

Three facts in one line: how good it is, what is holding it back, and whether it will stay that way.

---

## Worked examples

### Global but slow

Active/active multi-region, edge everywhere, distributed data, hardened security, but the app takes about one second to respond.

| Axis | Level |
|---|---|
| Topology | AAA |
| Availability | AAA |
| Data path | AAA |
| Delivered p99 (1000ms) | C |
| Program + architecture | AA |
| Dependencies | AA |
| Security | AAA |
| Client performance + reach | AA |
| Modern stack + compatibility | AAA |

Minimum is **C**, set by latency. Result: **`RSG C, latency-bound, watch`**. Every dollar spent on global topology is wasted while a one-second response time drags the whole system to C.

### Centralized but fast

A boring single-region web app on one host, tight code, 120ms p99, strong guardrails.

| Axis | Level |
|---|---|
| Topology | B |
| Availability | B |
| Data path | B |
| Delivered p99 (120ms) | AA |
| Program + architecture | AA |
| Dependencies | A |
| Security | A |
| Client performance + reach | A |
| Modern stack + compatibility | A |

Minimum is **B**, set by the single-region topology, availability, and data path together. Result: **`RSG B, topology-bound, availability-bound, data-bound, stable`**.

### Slick but heavy on old hardware

A polished single-page app, AAA backend, fast servers, great security, but the frontend ships a multi-megabyte bundle and renders a long list with an O(n²) routine. On a new laptop it feels instant. On a four-year-old phone it stutters and the list freezes once it grows.

| Axis | Level |
|---|---|
| Topology | AAA |
| Availability | AAA |
| Data path | AAA |
| Delivered p99 (measured on a fast device) | AAA |
| Program + architecture | AA |
| Dependencies | AA |
| Security | AAA |
| Client performance + reach | C |
| Modern stack + compatibility | AA |

Minimum is **C**, set by client performance, because the O(n²) hot path caps that axis at C on its own. Result: **`RSG C, client-performance-bound`**. The server latency measured AAA on a fast device and hid the problem entirely, which is exactly why this axis exists as its own column.

### The takeaway

The boring fast app (B) outranks the global slow one (C). That is the entire reason the latency and program axes exist. Being everywhere on earth is worth nothing if the thing you deliver everywhere is slow.

---

## Design decisions

**Why minimum instead of average.** An average lets a strong axis paper over a fatal weak one. A system that is perfect everywhere except it loses all data on a region failure is not a good system, it is a time bomb with good marketing. The minimum is the only function that tells the truth about a chain.

**Why program performance is a first-class axis.** Latency and distribution describe the pipes. Program performance describes what flows through them. A clean global pipe carrying slow code is a slow product. Making code quality its own required axis means you cannot buy your way to AAA with infrastructure alone.

**Why dependencies is so unforgiving.** Every third party on your critical path is a system you cannot inspect, cannot fix, and cannot fully secure. At the top tier, where the difference between AA and AAA is "everything works, always, and is fully owned," a critical-path dependency is a real cap, not a nitpick.

**Why client performance is separate from latency.** Delivered latency is usually measured on a capable device, so it can read AAA while the app is unusable on old or low-end hardware. The two axes fail independently: a fast server with a bloated, quadratic client is fast for some users and broken for the rest. Grading the worst hardware that still matters, rather than the best, is the only way to catch this.

**Why modern stack is paired with compatibility.** Modernity and reach pull against each other, and grading only one rewards the wrong behavior. Score modernity alone and you reward breaking older clients to chase the newest protocol. Score compatibility alone and you reward never upgrading. Requiring both, modern tech with graceful fallback, is the only posture that serves every user at once, so that is what the top grade demands.

**Why guardrails are a tag and not an axis.** Grading intent is subjective and gameable. Grading results is objective. Bad code already loses points on latency and program performance, today, measurably. Guardrails only predict the future, so they belong in a predictive tag, not in the present-tense score.

---

## Relationship to real standards

This is an invented rubric. Nothing external audits it, and no certificate comes from it. Its only value is forcing the weakest-link conversation inside a team, honestly.

When you need a grade you can show a customer, route back to the real standards:

- **Availability of the facility**: Uptime Institute Tier Classification (Tier I to IV), the most cited tier standard, or TIA-942.
- **Security**: SOC 2, or ISO/IEC 27001.

RSG is the internal mirror you hold up before any of those audits, the one that tells you which axis is the weakest link and therefore what to fix first.