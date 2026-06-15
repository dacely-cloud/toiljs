# Resilience and Scale Grade (RSG)

> One grade for an application across seven axes, where your grade is your weakest axis, never the average and never the best.

![status](https://img.shields.io/badge/status-spec-2dd4bf)
![type](https://img.shields.io/badge/type-rubric-84cc16)
![authority](https://img.shields.io/badge/external%20authority-none-8aa0a4)

RSG is an internal rubric for grading how resilient, distributed, fast, lean, and secure an application actually is, as a single letter from **AAA** down to **D**. It exists to force one honest conversation: a system is only as good as its weakest link, and a good network must never be allowed to flatter bad code.

This document is the canonical spec. It supersedes any earlier draft that used fewer axes.

---

## Table of contents

- [The core rule](#the-core-rule)
- [The grade table](#the-grade-table)
- [The seven axes](#the-seven-axes)
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

| Grade | Topology + distribution | Availability | Data path | Delivered p99 | Program performance + architecture | Dependencies | Security |
|---|---|---|---|---|---|---|---|
| **AAA** | Active/active multi-region plus real edge compute, logic runs next to the user | 99.99%+, automated cross-region failover, no single point of failure | Globally distributed writes, sub-50ms reads almost everywhere | under 100ms | Edge-native, clean separation of requests, tasks, and compute, no blocking work on the hot path, near-optimal per request | Zero third party on the critical path, you own the stack | Zero trust, TLS everywhere, data encrypted at rest, passwords hashed never plaintext, pen-tested, audited compliance |
| **AA** | Primary region plus standby regions, geo read replicas, partial edge | 99.95 to 99.99%, automated regional failover | Cross-region reads, single-region writes | under 200ms | Good architecture, mostly clean separation, minor hot-path waste | Few trusted dependencies, none critical | WAF plus DDoS, encryption, compliance underway |
| **A** | One region, multi-AZ, autoscaling stateless tier | 99.9%, survives an AZ failure | Single region, read replicas plus cache | under 500ms | Reasonable structure, some coupling, acceptable efficiency | Several third-party deps, managed | TLS, auth, secrets management, basic WAF |
| **B** | Single region, serverless or one small group (Vercel-style) | ~99.5%, DB is effectively a single point of failure | One primary DB, latency equals distance to it | under 1s | Works but coupled, blocking work on the request path | Leans on third-party platforms and services | TLS plus auth, platform defaults |
| **C** | One server, one database | best effort, no real SLA | Single DB, no redundancy | 1 to 3s | Monolithic, tangled, no separation | Glued together from third-party pieces | Hand-rolled, minimal |
| **D** | Localhost, single process | none | Local | over 3s | Whatever compiles | Anything | None |

Each axis maps to a numeric level for scoring: `AAA = 5`, `AA = 4`, `A = 3`, `B = 2`, `C = 1`, `D = 0`.

Security has hard caps on top of these levels. Some failures, like a plaintext password or no TLS, disqualify a system from a high grade outright, see [hard security disqualifiers](#hard-security-disqualifiers).

---

## The seven axes

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

**AAA security.** All traffic encrypted in transit with modern TLS. All sensitive data encrypted at rest. Passwords and secrets are never transmitted or stored in readable form, passwords are salted and hashed with a slow algorithm built for it (argon2, bcrypt, or scrypt), and secrets live in a managed vault with rotation, never in code or in a committed config file. Every request is authenticated and authorized with no implicit trust between services (zero trust). The system actively defends against the standard attack classes: injection, cross-site scripting, request forgery, server-side request forgery, and broken access control. There is a WAF and DDoS protection in front, auth events are logged and monitored, and there is a written incident-response plan. And it is independently verified: a third-party penetration test plus the formal compliance certification appropriate to the data (see below on what compliance means).

**AA security.** Encryption in transit and at rest, properly hashed passwords, secrets management, a WAF and DDoS protection, the common attack classes covered, and monitoring. The gap from AAA is the absence of independent verification: no recent third-party pen test, or compliance work started but not certified. Secure in practice, not yet audited.

**A security.** TLS everywhere, authentication and authorization in place, secrets kept out of the codebase, passwords hashed, and a basic WAF. The standard attack classes are mostly handled but not formally tested. Reasonable for a product handling normal user data, short of regulated or high-value data.

**B security.** TLS plus authentication, relying on the defaults a hosting platform gives you. Encryption and hashing happen because the platform does them, not because you designed for them. Fine for low-stakes data, thin if you hold anything sensitive.

**C security.** Hand-rolled, minimal. Auth exists but is improvised, encryption is partial, and the common attack classes are not systematically addressed. Holds personal or valuable data at real risk.

**D security.** Effectively none. No meaningful auth, no encryption, or worse.

#### Hard security disqualifiers

These are not point deductions, they are caps. If any are true, the security axis cannot exceed the listed grade no matter what else is in place, which under the weakest-link rule caps the whole system.

| If this is true | Security axis caps at |
|---|---|
| Passwords or secrets sent or stored in plaintext (your auth example) | **D** |
| Any sensitive data travels unencrypted (no TLS) | **D** |
| No authentication on an endpoint that exposes sensitive data | **D** |
| Secrets committed into the repository | **C** |
| Known unpatched critical vulnerabilities (CVEs) in the stack | **C** |
| No protection against the standard attack classes (injection, XSS, CSRF, access control) | **C** |

So an auth system that sends a plaintext password to a server is a **D** on security, which makes the entire application a **D**, regardless of how global, fast, or clean it is. That is exactly the result you wanted, and the disqualifier table makes it automatic rather than a judgment call.

#### What "compliance" actually means

Compliance is independent, audited proof that you meet a defined security standard. It is never a standalone word, it is always compliance *with a specific framework*, and which framework depends on the data you hold:

- **SOC 2**: an audit of how a service handles customer data across security, availability, and confidentiality. The usual baseline for B2B SaaS.
- **ISO/IEC 27001**: international certification that you run a real information-security management system, not just controls.
- **PCI DSS**: required if you store, process, or transmit payment-card numbers.
- **HIPAA**: required in the US if you handle protected health information.
- **GDPR / CCPA**: legal obligations for handling personal data of EU or California residents, covering consent, access, deletion, and breach notification.

For AAA you need whichever of these your data actually triggers, certified by an outside auditor. "We take security seriously" is not compliance. A signed SOC 2 Type II report is.

This axis also interacts with dependencies: if you outsource a security-critical function to a third party on your critical path, you constrain both axes at once, because you are now trusting a system you cannot inspect.

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

1. Assign each of the seven axes a level from 0 (D) to 5 (AAA), using the [grade table](#the-grade-table). Latency comes from a measured p99 via the [thresholds](#latency-thresholds).
2. The grade is the **minimum** of the seven levels.
3. Convert that level back to a letter: `5 -> AAA`, `4 -> AA`, `3 -> A`, `2 -> B`, `1 -> C`, `0 -> D`.
4. Record the [binding axis or axes](#the-binding-axis), the ones sitting at that minimum.
5. Attach the [stability modifier](#the-stability-modifier) from your guardrails.

In plain terms: take the seven axis levels, find the lowest one, and that is your grade. The lowest of topology, availability, data, latency, program, dependencies, and security wins, and its letter is the grade.

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

Minimum is **B**, set by the single-region topology, availability, and data path together. Result: **`RSG B, topology-bound, availability-bound, data-bound, stable`**.

### The takeaway

The boring fast app (B) outranks the global slow one (C). That is the entire reason the latency and program axes exist. Being everywhere on earth is worth nothing if the thing you deliver everywhere is slow.

---

## Design decisions

**Why minimum instead of average.** An average lets a strong axis paper over a fatal weak one. A system that is perfect everywhere except it loses all data on a region failure is not a good system, it is a time bomb with good marketing. The minimum is the only function that tells the truth about a chain.

**Why program performance is a first-class axis.** Latency and distribution describe the pipes. Program performance describes what flows through them. A clean global pipe carrying slow code is a slow product. Making code quality its own required axis means you cannot buy your way to AAA with infrastructure alone.

**Why dependencies is so unforgiving.** Every third party on your critical path is a system you cannot inspect, cannot fix, and cannot fully secure. At the top tier, where the difference between AA and AAA is "everything works, always, and is fully owned," a critical-path dependency is a real cap, not a nitpick.

**Why guardrails are a tag and not an axis.** Grading intent is subjective and gameable. Grading results is objective. Bad code already loses points on latency and program performance, today, measurably. Guardrails only predict the future, so they belong in a predictive tag, not in the present-tense score.

---

## Relationship to real standards

This is an invented rubric. Nothing external audits it, and no certificate comes from it. Its only value is forcing the weakest-link conversation inside a team, honestly.

When you need a grade you can show a customer, route back to the real standards:

- **Availability of the facility**: Uptime Institute Tier Classification (Tier I to IV), the most cited tier standard, or TIA-942.
- **Security**: SOC 2, or ISO/IEC 27001.

RSG is the internal mirror you hold up before any of those audits, the one that tells you which axis is the weakest link and therefore what to fix first.