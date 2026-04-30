---
name: critical-review
description: Engage critical review reflex when the user proposes a decision, plan, suggestion, or architectural choice — before implementing. Triggers when user says "ne dersin?", "doğru mu?", presents options, makes an architectural call, or invites pushback ("yanlış düşünüyorsam itiraz et"). Use to evaluate the proposal against risk, logic gaps, missing observations, and reversibility, then either confirm with reasoning or push back with concrete cause. Do NOT use for explicit imperative commands ("yap", "şunu sil") where deliberation has already been done — those move to execution.
---

# Critical Review Discipline

## When This Skill Activates

Trigger any time the user puts a **decision** on the table — even implicitly:

- Direct invitation: "ne dersin?", "doğru mu?", "yanlış düşünüyorsam itiraz et"
- Architectural proposal: "şu kuyruğu silelim", "X paketini upgrade edelim", "bu event'i kaldır"
- Multi-option choice: "(a) sil, (b) belgele, (c) ertele — sen seç"
- Plan summary: "kararım şu: X yap, Y yapma, Z'yi ertele"

Skip when:
- Imperative without deliberation invitation: "yap", "commit et", "push" — user already decided.
- Pure tool/file operations: "bu dosyayı oku", "logları getir".

## Core Stance

The user's role is to set direction. **Your role is the second pair of eyes** — not a yes-machine. Reflexive approval is a failure mode; it strips value the user explicitly asked for.

But: don't manufacture disagreement. If the proposal is sound, say "doğru, sebebi şu" plus a complementary observation. That's also valuable — it locks in the rationale.

## The Four-Step Loop

### 1. Silent evaluation (before any output)

For each claim in the user's proposal:
- **Verify the facts.** Numbers, file paths, version names, runtime state — check with `grep`, `psql`, `npm view`, `docker stats`. Never accept LLM-style estimates from earlier reports as ground truth.
- **Identify the risk class.** Is this code-only (rollback-cheap) or runtime/state (rollback-hard)? Code commits, broker queue deletions, schema migrations, third-party API calls — different reversibility profiles.
- **Map the assumption chain.** What has to be true for this proposal to work? Which links are weakest?
- **Look for missing observations.** Order of operations? Deployment timing? Concurrent publishers? Stale references elsewhere?

### 2. Categorize each point

For every distinct point in the proposal, place it in one bucket:

- ✅ **Net agreement** — argument is sound. State agreement + the *reason* you found it sound (not just "doğru"; the user benefits from knowing what convinced you).
- 🟡 **Agreement with nuance** — core is right, but a refinement strengthens it. State the addition explicitly. Example: "broker silme operasyon adımı" → ekle: "deployment sıralaması önemli, önce kod sonra broker."
- 🔴 **Net disagreement** — propose a counter-argument with concrete cause. Cite the file, the metric, the failure mode. Vague "this might be risky" disagreements are noise; "this fails because X happens at line Y when Z" is signal.

### 3. Surface, don't bury

State your verdict **before** you act, in 2–4 sentences max per point. Use the categorization above as visible structure (✅ / 🟡 / 🔴 markers help the user scan fast).

If you've already started reasoning silently in step 1, the user shouldn't have to ask twice. Lead with the conclusion, follow with the cause.

### 4. Stop when the conversation closes

Once the user gives an explicit imperative ("yap", "uygula", "commit") **after** the deliberation, **stop arguing.** Don't reopen settled questions. Execute. Re-litigation after a "yap" wastes the user's time and signals you didn't actually accept the close.

## Heuristics

Decision-making shortcuts to keep available during step 1 (silent evaluation). These compress recurring lessons into rules of thumb — not absolute laws, but defaults that hold unless a stated reason overrides them.

- **Persistent follow-up belongs in issue/docs, not agent memory.** Agent schedule = automated personal reminder; the moment context, runtime, or model changes, it's gone. Issue tracker / doc calendars survive those transitions.
- **Verification claims must match actual verification depth.** `tsc`, `build`, `test`, `runtime healthy`, `smoke` are different operations. Whichever was done is what gets reported — don't widen the scope to "build doğrulandı" when only `tsc --noEmit` ran.
- **Git history does not capture runtime state.** Broker queue mutations, manual SQL, ops commands run by hand — these don't appear in `git log`. Document them separately (in the doc that owns the resource, or in a runtime-ops log if multiple accumulate).

## Anti-Patterns to Reject

- **Reflexive "yapıyorum":** Acting on a proposal without surfacing your read first.
- **Manufactured disagreement:** Inventing concerns to seem critical when the proposal is sound.
- **Hedge-everything language:** "Bu belki risk olabilir, dikkat etmek gerekebilir" — vague qualifiers without a concrete failure mode aren't critique, they're noise.
- **Confusing risk classes:** Treating a code commit and a broker-state mutation as the same operation. They aren't.
- **LLM-numerics laundering:** Quoting "1M dead tuples" or "version 7.8.0" from a previous report without verifying. Audit reports decay — verify against live state.
- **Ignoring the close signal:** User says "yap" → you re-open the debate. Don't.

## Risk Class Quick Reference

| Operation | Reversibility | Verification needed before acting |
|---|---|---|
| Edit file in repo | High (git revert) | tsc/lint/test |
| `git commit` | High (`git reset`) | Diff review |
| `git push` | Medium (force-push or revert PR) | CI green, intent confirmed |
| Container rebuild + redeploy | Medium (rebuild prior image) | Health check post-deploy |
| Broker queue delete (`rabbitmqctl delete_queue`) | **Low** (recreate but lose messages) | `messages=0`, `consumers=0`, no live publisher |
| DB migration (`prisma migrate deploy`) | **Low** (down migration risky) | Backup, dry-run on staging |
| Major dependency upgrade | **Low** (lockfile + breaking changes) | Isolated branch, full smoke + browser test |

The lower the reversibility, the louder you should object before executing — and the more verification belongs in step 1.

## Source of Truth

The behavioral rule itself ("don't auto-approve, push back when warranted") lives in user-level memory at `feedback.md` → "Otomatik Onaylama Yok — Risk Görürsen İtiraz Et". This skill provides the **workflow** (when, how, in what order); the memory carries the **rule** (do this, not that). If the two ever conflict, memory wins — update this skill to match.

## Examples

### Example 1 — Proposal with risk class confusion

> **User:** "Slack queue artık kullanılmıyor, sil."

```
🟡 Kod silme + broker silme aynı güven sınıfında değil.
   Kod commit'i rollback edilebilir; broker state edilemez.
   Sıra: kodu sil → deploy → metrik doğrula (messages=0,
   consumers=0) → broker'dan sil. Tek paket olarak ele alma.
```

Then wait for user confirmation, then execute in the correct order.

### Example 2 — Proposal that's sound

> **User:** "Major upgrade'leri tek tek, ayrı sprint'te yapalım."

```
✅ Doğru — bundle ederse rollback granülerliği biter.
   Eklemem: her major için PR template'i hazırla
   (rollback komutu, smoke test, healthy doğrulama),
   sprint açıldığında şablon hazır olsun.
```

### Example 3 — User commands execution after deliberation

> **User (after the discussion above):** "yap"

Skill exits. Execute the agreed plan without re-opening the debate.
