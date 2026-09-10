// Shared "Sale Tanker" detection rule (single source of truth).
// A sale tanker is a trip plan whose milk is SOLD (e.g. at the BMCU / to a
// third party) rather than delivered to a Shreeja plant. Two signals, either
// is enough — identical to the rule billing has always used:
//   1. the planner flag trip_plans.is_sale_tanker (migration 030), or
//   2. the placeholder tanker whose number starts with "SALE".
//
// saleTankerSql(tpAlias, tAlias) returns a boolean SQL expression for use in
// SELECT lists / WHERE clauses; the aliases are the trip_plans and tankers
// table aliases of the surrounding query.
//
// saleTankerNumberSql(tAlias) is the tanker-master-only half — for queries
// that list fleet vehicles (no trip plan in scope) and must skip the
// "SALE…" placeholder because it is not a real vehicle.
function saleTankerSql(tpAlias = 'tp', tAlias = 't') {
  return `(COALESCE(${tpAlias}.is_sale_tanker, FALSE) OR COALESCE(${tAlias}.tanker_number, '') ILIKE 'SALE%')`;
}

function saleTankerNumberSql(tAlias = 't') {
  return `(COALESCE(${tAlias}.tanker_number, '') ILIKE 'SALE%')`;
}

module.exports = { saleTankerSql, saleTankerNumberSql };
