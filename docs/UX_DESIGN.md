# UX design

## Product intent

Policy Assignment is a focused reviewer product for understanding one causal loop: policies define what can be assigned, rules define who receives them, employee facts determine matches, the resolver selects winners, reconciliation keeps those winners current, and Why explains every decision. The interface prioritizes that model over internal infrastructure. It deliberately avoids decorative analytics, evaluation telemetry, queue dashboards, marketing copy, oversized cards, ornamental charts, broad gradients, and effects that reduce information density.

The visual system uses neutral surfaces, one evergreen accent, subtle borders, a 4/8-pixel spacing rhythm, compact tables, and a single line-icon language. Status never relies on color alone. Desktop is primary, while tables become labelled structured rows and navigation becomes an accessible overlay on narrow screens.

## References studied

Only interaction and information-architecture patterns were studied. No proprietary assets, copy, layouts, or product identity were copied, and this project has no affiliation with the referenced companies.

- [Rippling company overview](https://go.rippling.com/rs/345-FHM-674/images/Rippling-Memo-Metrics-Redacted.pdf): the employee record acts as the source of truth for downstream systems, and lifecycle changes propagate across connected operations. That model informed employee-first navigation, onboarding, and change impact.
- [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) and [display options](https://linear.app/docs/display-options): lower visual noise, aligned sidebars/headers/panels, compact density, contextual peek views, and keyboard-oriented navigation informed the shell, command menu, filters, and side panels.
- [Stripe Dashboard basics](https://docs.stripe.com/dashboard/basics) and [search](https://docs.stripe.com/dashboard/search): resource-centred pages, global search, filterable tables, and URL-friendly navigation informed the information architecture and table treatment.
- [Ramp approval policy configuration](https://support.ramp.com/setting-up-spend-request-approvals) and [Policy Agent activity](https://support.ramp.com/use-policy-agent-for-approvals/): policy drawers, explicit conditions/outcomes, rationale, policy versions, overrides, and activity history informed rule preview, manual-override treatment, and explanations.
- [Vercel dashboard navigation redesign](https://vercel.com/changelog/dashboard-navigation-redesign-rollout): clear hierarchy, consistent page tabs, responsive navigation, and prioritised resource structure informed the grouped sidebar and mobile behavior.
- [shadcn/ui application blocks](https://ui.shadcn.com/blocks), [Tailwind application UI](https://tailwindcss.com/plus/ui-blocks/application-ui), and [Catalyst](https://tailwindcss.com/plus/ui-kit): accessible dialog, sidebar, table, form, command-palette, and responsive patterns were reviewed as ecosystem references. The implementation remains dependency-light and uses semantic native controls rather than copying template markup.

## Chosen interaction model

The persistent shell groups resources by the administrator's mental model:

```text
Overview
People       Employees · Groups
Policies     Policies · Rules
Audit
```

The Overview is a four-step walkthrough with real actions: create a policy, create a rule, add an employee, and review assignments. It has a small activity feed, but no employee totals, queue sizes, evaluation-tenant statistics, or generic KPI grid.

Categories are presented inside Policies in plain language: “one policy per employee” or “employees may receive multiple policies.” Manual overrides are exceptional employee-specific actions on Employee detail. Reconciliation is a product behavior, not a navigation destination; its job records are available only under Audit's “Technical reconciliation details” disclosure. Settings add no value to the challenge journey and are omitted.

Employee and configuration lists use compact tables because comparison matters. Employee search, facets, sort, and pagination are server-backed for large populations. Selecting an employee opens a side panel so table filters and scroll context remain intact. The panel separates current assignments, employment facts, and dated history.

## Explainability and change safety

“Why?” opens a dedicated inspector built from the stored assignment decision. It shows the winning source, matched employee values, expected condition values, priority, specificity, rule version, competing policy names, rejection reasons, employee snapshot version, effective date, and next temporal reevaluation. Decision JSON is never the primary presentation.

Employee create/edit follows four steps:

```text
Identity → Employment context → Assignment preview → Review and save
```

The preview calls `POST /employees/preview`, which uses the production evaluator and resolver. Added, removed, replaced, and unchanged policy categories are visually distinct with symbols and labels, not color alone. Saving an edit uses the normal effective-dated API plus group membership APIs, which enqueue the normal transactional reconciliation path.

Rule creation uses a recursive, structured builder for comparison, group, AND, OR, and NOT nodes. Administrators see a human sentence and must run the real rule preview before publish is enabled. Preview counts and representative employees come from the same evaluator/resolver used by reconciliation.

Manual overrides are visually exceptional, always require a reason, state that they override automatic rules, and use a confirmation before removal. Membership removal also requires explicit confirmation. Destructive operations explain the resulting automatic behavior before they run.

## Feedback, accessibility, and responsive behavior

- Native dialogs provide focus trapping and consistent Escape behavior.
- Every form control has a visible or accessible label; error responses are converted to safe user-facing messages.
- Focus rings, hover, selected, loading, disabled, success, warning, and failure states are consistent.
- Loading skeletons reserve table space and avoid layout jumps.
- Toasts announce mutations through an `aria-live` region; optimistic mutation is avoided where source versioning or reconciliation must first succeed.
- `Cmd/Ctrl+K` opens a keyboard-navigable command menu for pages and common actions.
- On narrow screens the sidebar becomes an overlay, page actions wrap, forms become single-column, and tables turn into labelled rows without dropping important values.

## Why this fits policy administration

The engine's differentiator is not CRUD volume; it is trustworthy consequences. The interface keeps employee facts, rule intent, conflict semantics, materialized state, and audit evidence connected without making job machinery a primary concept. A reviewer can understand what a policy is, who receives it, why it won, what an edit will change, and how to reconstruct a historical decision without reading the architecture document or inspecting raw records.

## Product workspace and journey

`npm run seed:product` creates **NYC Open Data Policy Workspace** from the 50,000 normalized source facts already persisted by the NYC importer. It never calls the NYC API. The copy has product-owned employee identities, versions, import provenance, assignments, and jobs, while the source evaluation tenant and certified results remain isolated. Imported identities remain anonymized and are presented through job title, agency/location context, and a stable record label.

The policies, groups, and rules are visibly labelled **Evaluation / demonstration policy configuration** because they are not official NYC policies. They are the exact 6-category, 48-policy, 300-rule starting configuration used by the certified evaluation; the product does not substitute a smaller rule universe.

The intended walkthrough is:

```text
Policies → understand assignable outcomes and category behavior
Rules → inspect English-like conditions and preview impact
Employees → open an imported NYC record and inspect current policies
Why → inspect matching facts, competitors, and precedence
Edit employee → preview a fact or membership change before saving a new product-tenant version
Add employee → preview resolved policies before creation
Audit → see the employee and assignment changes, with technical work collapsed
```
