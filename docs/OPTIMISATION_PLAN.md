# Tanker Operations Optimisation — Plan (for review before build)

Status: DRAFT for approval · 25 Sep 2026 · target: QA first, then production after UAT.

Goal: cut transport cost per litre of milk moved from BMCUs to plants, using the
production data the portal now holds (about 1,300 trips a month since July 2026,
GPS trails since 7 Sep, Google round-trip km on every billed trip, per-km rates by
state and tanker size, BMCU-wise quantities per shift).

Three questions the system should answer every day, and one every quarter:

1. **Route optimisation** — given today's expected milk per BMCU and shift, which
   BMCUs go together on one trip, in which order, to which plant?
2. **Tanker optimisation** — which of the existing tankers should run which route,
   so that fill % is high and km × rate is low?
3. **Lifting optimisation** — which BMCUs can be lifted once a day instead of twice,
   or every other day, without breaching chilling limits, and which must be lifted
   more often?
4. **Fleet mix** (quarterly) — how many tankers of which capacity does Shreeja
   actually need, and which contracts to grow, shrink or drop?

## 1. What the data says today (research summary)

Facts from production, August to mid-September 2026:

| Measure | Value | Source |
|---|---|---|
| Vendor trips per fortnight | about 590 | billing runs 14/15 |
| Average fill (actual, litre-weighted) | 93.8 % | Analytics, Aug |
| Fill spread by planner | 93.0 % to 98.3 % | Planner leaderboard |
| Trips filled under 80 % | 11 % | Planner leaderboard |
| Cost per fortnight, vendor trips | ₹78.8 lakh | run 15 |
| Km per fortnight | 1.71 lakh | run 15 |
| Average cost per litre moved | about ₹0.72 | derived |
| Routes with fill under 70 % | Gowraram 34 %, Nulukunta Cross 65 %, Karapattu 68 % | Route utilisation |
| Tankers with zero trips in a month | 4 of 72 | Unused tankers |
| Km keyed by biller vs Google round trip | keyed within a few km on most trips; a few routes 10 % or more apart | run 14 recalculation |

What this means:

- **Fill is already high** on average. The remaining money is not in filling
  tankers fuller; it is in (a) the 11 % of trips that run light, (b) routes whose
  km are longer than the shortest feasible tour, (c) sending big tankers on small
  routes and paying the big-tanker rate, and (d) lifting BMCUs more often than
  their volume requires.
- **Rate structure drives the optimum.** Rates are per km by state and tanker
  capacity class, not per litre. A 30 KL tanker at ₹49.78/km costs 1.7× a 15 KL
  tanker at ₹29.16/km per km, but only 2× the capacity. So two 15 KL trips on
  short routes can be cheaper than one 30 KL trip that detours to fill up.
  The optimiser must minimise **Σ (km × rate of the tanker that drives it)**, not
  km alone, which is what the current Clarke-Wright run does.
- **The existing optimiser** (`services/optimizerCore.js`, Route Optimizer page)
  is a single-depot Clarke-Wright savings heuristic with nearest-neighbour
  ordering, one capacity for all routes, no time windows, no vendor or
  availability constraints, no cost-aware assignment, and no learning from what
  actually happened. It was built before the data existed. It is a fine seed,
  not the answer.

## 2. Research: methods considered

| Problem | Standard method | Fit for Shreeja | Decision |
|---|---|---|---|
| Daily routing with a heterogeneous fleet, several plants, capacity limits | Heterogeneous-fleet, multi-depot Capacitated VRP; solved with Clarke-Wright seed + local search (2-opt, or-opt, relocate, swap) under a cost function; or OR-Tools CP-SAT routing | 140 BMCUs, 70 tankers, 4 to 6 plants is small; a good local-search heuristic reaches within 2 to 3 % of optimal in seconds | Build a cost-aware heuristic in Node (no new runtime); keep an optional OR-Tools worker as a later step if results plateau |
| Pickup time limits (raw milk must reach a chiller or plant within hours) | VRP with time windows | BMCUs chill before pickup, so hard windows are loose; the real constraint is tanker turnaround per shift | Model as a per-trip max duration (km / avg speed + BMCU dwell time from GPS) and a max BMCUs per trip |
| Lifting frequency (once vs twice a day, alternate days) | Periodic VRP / inventory routing | Each BMCU has a chilling capacity and a daily inflow; skipping a lift is allowed while stored volume stays under capacity and age under the limit | Add a BMCU "lift policy" advisor: from history, propose frequency per BMCU; planner accepts |
| Fleet composition | Fleet-size-and-mix VRP; in practice, simulate a season with candidate fleets and compare cost | Quarterly decision, not daily | Simulator over 90 days of real demand with candidate fleets; output a one-page recommendation |
| Learning from GPS | Compare planned vs actual route, stop dwell, speed profile | Only 3 weeks of trails so far | Use GPS for dwell-time and speed calibration now; route-order corrections once 3 months exist |

Sources: Clarke and Wright (1964) savings; Toth and Vigo, *Vehicle Routing: Problems,
Methods, and Applications* (2014) for heterogeneous fleet and periodic variants;
Google OR-Tools routing library documentation; dairy milk-collection routing case
studies (Amul/GCMMF collection studies, Butler et al. 2005 milk collection in
Ireland) for the once-versus-twice daily lifting model.

## 3. Proposed solution

### 3.1 Demand model (the input everything else needs)

- Per BMCU × shift: expected litres = weighted forecast from the last 14 days of
  actual RMRD (same weekday weighted 2×, last 7 days 1×), plus the planner's
  override. Stored in a new table `bmcu_demand_forecast` (date, bmcu, shift,
  forecast, actual when known, error).
- Per BMCU: chilling capacity litres, max hours before pickup, lifting frequency
  policy (`twice_daily`, `daily`, `alternate_days`, `custom`), from a new
  BMCU master section. Missing values default to twice daily.
- Reporting: forecast error per BMCU so the planner sees where the model is weak.

### 3.2 Route + tanker optimiser v2 (daily)

Inputs: date, plants in play, BMCU demand per shift, available tankers (active,
not on a credible open maintenance gate pass, planner exclusions), rates per state
and capacity class, Distance Master with Google km (now complete for plant legs).

Objective: minimise Σ trip cost = km × rate(tanker, state) + optional per-trip
fixed cost, subject to: tanker capacity (with a fill floor, default 85 %),
max BMCUs per trip (default 8), max trip km (default 550) or hours, one tanker at
most N trips per day (default 2, from history), BMCU must be lifted in its policy window,
plant intake limits if configured.

Method:
1. Seed with Clarke-Wright per plant (existing code, reused).
2. Assign tankers cost-aware: for each route, the cheapest tanker whose capacity
   fits with the fill floor; re-seed with that tanker's capacity if it changes the
   feasible merges.
3. Local search for 5 to 10 seconds: relocate a BMCU between trips, swap two
   BMCUs, 2-opt inside a trip, merge two light trips, split an over-long trip;
   accept if total cost falls; a few random restarts.
4. Output: trips with order, tanker, fill %, km, cost, cost per litre, and the
   delta against (a) yesterday's actual plan and (b) the same weekday last week.

Where it lives: `services/optimizerCore.js` gains `costAwareAssign`,
`localSearch`; `routes/optimize.js` gains `/run-v2` and keeps `/run` for
comparison; sessions table gets `algorithm` and `constraints` JSON columns.

UI (Route Optimizer page): a "v2" toggle, constraint panel with defaults, side by
side comparison to the existing plan for that date, one-click "Adopt as plan"
(already exists as save-as-plans), and an explanation per trip of why that tanker
was chosen.

### 3.3 Lifting advisor

For each BMCU, from 8 weeks of RMRD history: average litres per shift, variance,
chilling capacity. Proposes: keep twice daily / move to once daily / alternate
days, with the savings in trips and km per month and the risk (days the stored
volume would have exceeded 90 % of chilling capacity). Planner accepts per BMCU;
the accepted policy feeds 3.1. Report: "Lifting policy review" with proposals
sorted by savings.

### 3.4 Fleet-mix simulator (quarterly)

Replay the last 90 days of actual demand through the v2 optimiser with candidate
fleets: current fleet; current minus the 4 idle tankers; swap N large for M
medium; add one 20 KL in a named district. Output per candidate: monthly cost,
km, average fill, trips that could not be served. Runs as a background job with
progress, results stored in `fleet_simulations`. One page report with the
recommended mix and the vendor contracts affected.

### 3.5 Measurement (so we know it worked)

Baseline: August and first half of September actuals, per plant and route: cost
per litre, km per litre, fill %, trips per day. New Analytics cards: "Optimiser
adoption" (share of plans created from v2), "Realised saving" (actual cost of
adopted plans vs the plan they replaced, at the same demand). Weekly summary
email to planners with the three biggest savings and three biggest misses.

Measurement note (2026-09-25): the Day Optimizer's "Comparison" card and the
Excel Summary compare the optimiser (whose litres are a *forecast* from RMRD
history) against the **actual executed** trips of the date, not against the
trip plans. Plans under-state lifted milk by roughly 19 % (prod 08-09-2026:
7,13,184 L planned vs 8,50,335 L forecast), so ₹/L and fill against plans were
misleading. Executed basis per live, non-sale execution: RMRD litres from
`trip_execution_bmcu_shifts` (dispatch litres as fallback), billed km / amount
where the trip is in a billing run, else `COALESCE(actual_km, calculated_km)`
× the Tanker Rate Master rate (same lookup as the optimiser). The planned
figures stay visible as a muted reference column.

## 4. Delivery plan (QA)

| Phase | Weeks | Deliverable | Depends on |
|---|---|---|---|
| 0. Data calibration | 1 | Extract 90 days of prod trips, BMCU quantities, km, rates; verify distance coverage; dwell and speed from GPS; baseline report | Prod extract (section 6) |
| 1. Demand model + BMCU policy master | 1 | Forecast table and job, BMCU chilling fields, forecast-error report | Phase 0 |
| 2. Optimiser v2 | 2 | Cost-aware assignment, local search, constraints, `/run-v2`, sessions columns | Phase 1 |
| 3. UI + comparison | 1 | v2 toggle, constraint panel, side-by-side vs actual plan, explanations | Phase 2 |
| 4. Lifting advisor | 1 | Policy proposals report, accept flow | Phase 1 |
| 5. Fleet simulator | 1 | Background replay job, candidates, report | Phase 2 |
| 6. Measurement | 0.5 | Analytics cards, weekly email | Phase 3 |
| 7. UAT and tuning | 2 | Planners run v2 in parallel with manual planning for 2 weeks; tune fill floor, max BMCUs, trip cap | Phases 3 to 6 |

About 9 to 10 weeks to production, with phases 2 and 4 in parallel. Every phase
lands on `qa` behind a feature flag `OPTIMIZER_V2_ENABLED` so production is
untouched until sign-off.

### Status (25 Sep 2026)

| Phase | Status | Where |
|---|---|---|
| 1. Demand model + BMCU policy master | Delivered on `qa` (forecast table `bmcu_demand_forecast`, weighted 14-day / 60-day / plan-qty cascade, planner override, `POST /api/optimize/forecast/backfill`; BMCU chilling capacity + lifting policy fields) | migration 044, `services/dayOptimizerData.js`, Masters → BMCUs |
| 2. Optimiser v2 | Delivered on `qa` as the **Day Optimizer (fleet v2)** — whole day, all plants, whole fleet, cost = Σ km × Tanker Rate Master rate; Clarke-Wright seed + cost-aware assignment + local search; `POST /api/optimize/day`, `/day/preview`, `/prefetch-distances`; sessions carry `algorithm`, `constraints`, `comparison`, `summary` | `services/optimizerV2.js`, `services/rates.js`, `routes/optimize.js`, `scripts/optimizer_v2_selftest.js` |
| 3. UI + comparison | Delivered on `qa`: Planning → Day Optimizer page (inputs, results by plant, comparison vs actual plans or same weekday last week, adopt as draft plans). The existing Route Optimizer page is untouched. | `frontend/src/pages/planning/DayOptimizer.jsx` |
| 4–7 | Not started | |

### First production run findings (plan date 09-09-2026, both shifts, 25 Sep 2026)

The first real run was worse than the planners: 41 trips, 13,216 km, 6.66 lakh L
served, ₹5,28,570, 27 BMCU pickups unserved, 16 tankers excluded, and the local
search accepted 0 of 150,000 moves. Root causes, reproduced offline with
`backend/scripts/optimizer_v2_replay.js` on a 90-day production extract (Haversine
distances for both sides, so the comparison is fair):

1. **Search vetoed itself.** The seed contained single-BMCU trips whose round trip
   alone exceeds the 450 km limit (far BMCUs such as 3654 / 3103). The feasibility
   check ran over the whole solution, so every candidate — even one that never
   touched those trips — was "infeasible" and rejected. Fix: a single-BMCU trip over
   the limit is allowed and flagged `over_max_km`; feasibility and tanker assignment
   are local to the trips a move touches; an explicit insert-unserved move runs first
   while anything is unserved; iterated local search kicks from the best solution
   when stale; per-move stats are reported.
2. **Seed capacity.** Clarke-Wright at the largest tanker (30 KL) built loads only
   three tankers could carry. Fix: seed at every capacity class (plus 22 KL and the
   median), keep the cheapest after assignment; a trip no tanker can take is split
   instead of reported unserved; demand above the largest tanker is split into parts.
3. **Stale gate passes.** 16 tankers were excluded on "Tankers without driver" /
   maintenance passes that were never returned although the tankers kept running.
   Decision (user, 25 Sep): only a `Maintainance` pass blocks a tanker, and it is
   ignored as stale once the tanker ran a non-cancelled trip after it was issued
   (note shown in the preview); other reasons are ignored; planners exclude by hand.
4. **Constraint defaults.** Planners run up to 8 BMCUs per trip and 4–6 trips a day
   above 450 km. At 6 / 450 the far BMCUs become forced solo trips and the optimiser
   cannot beat them; defaults are now 8 BMCUs / 550 km (operations to confirm, §6.1).

Replay results (same Haversine × 1.3 model for both; page defaults after the fix):

| Date | Planners: trips / km / cost / fill | Optimiser before fix | Optimiser after fix |
|---|---|---|---|
| 09-09-2026 | 41 / 11,705 / ₹5,47,596 / 97.4 % | 33 trips, 45 unserved, 0 accepted | 41 / 11,332 / ₹5,12,589 / 96.1 %, 0 unserved, 550 accepted |
| 20-08-2026 | 39 / 11,401 / ₹5,28,357 / 95.8 % | 33 trips, 45 unserved, 0 accepted | 39 / 10,659 / ₹4,82,729 / 95.1 %, 0 unserved, 784 accepted |
| 02-09-2026 | 40 / 11,098 / ₹5,10,123 / 93.3 % | 40 trips, 29 unserved, 0 accepted | 39 / 11,504 / ₹5,04,637 / 93.0 %, 0 unserved, 1,004 accepted |

Fleet in the replay = the tankers that actually ran that day (≤ 2 trips each), rates
learned from the extract. Run it: `node backend/scripts/optimizer_v2_replay.js
backend/scripts/fixtures/cal.csv 2026-09-09 [--max-bmcus=6 --max-km=450 --trips]`.

Differences from the plan text above: v2 lives in its own page and service
instead of a "v2" toggle on the Route Optimizer page; a BMCU is one node per
run (shift scope AM, PM or BOTH = AM + PM lifted together), matching how trips
actually run; the per-trip fixed cost and plant intake limits are not modelled.

## 5. Risks and how they are handled

- **Forecast error on a rainy day or festival.** Planner override always wins;
  the fill floor stops the optimiser from packing to 100 %.
- **Rates or capacities wrong in masters.** Phase 0 validates every active tanker
  has a capacity class and a current rate per state; gaps block v2 for that tanker.
- **Distance gaps.** Plant coordinates are now filled; Phase 0 confirms every
  plant to BMCU pair used in 90 days has a Google km.
- **Vendor contracts with minimum trips or km.** Not in the data. Ask (section 6);
  if they exist they become a constraint, not a suggestion.
- **Planner trust.** v2 runs beside manual planning for two weeks, and the
  comparison shows the saving per day before anyone is asked to adopt it.

## 6. Needed from Shreeja before Phase 0

Data extract from production (one command, output attached to the session):
90 days of trips with plan date, shift, tanker, capacity, vendor, state, plant,
BMCU sequence with RMRD litres per BMCU, ack litres, billed km, Google km, rate,
amount; plus BMCU master with chilling capacity if held anywhere; plus tanker
availability history (maintenance and without-driver gate passes).

Decisions:
1. Max BMCUs per trip and max trip duration the operations team accepts.
2. Chilling capacity and max hours before pickup per BMCU: is this recorded
   anywhere, or should the BMCU master get these fields with defaults?
3. Vendor contract constraints: guaranteed minimum trips, km or days per tanker?
4. Which plants can accept which milk (any BMCU to any plant, or fixed catchments)?
5. Is "one tanker, two trips a day" acceptable in general, or only on short routes?
6. Weighting: pure cost, or cost with a penalty for changing a BMCU's usual tanker
   and driver (continuity matters at the BMCU gate)?
