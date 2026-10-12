// backend/src/utils/compartments.js
// Compartment codes of a tanker from Tanker Master's free-text `compartments`
// ("2C", "3C", "2", "3"): 1 → FC, 2 → FC + BC, otherwise FC, MC, BC.
// Shared by QA dispatch entry and the plant acknowledgement (owner, 2026-10-12).
const ALL_COMPARTMENTS = ['FC', 'MC', 'BC'];
const compartmentCodes = txt => {
  const k = parseInt(String(txt ?? '').replace(/[^0-9]/g, ''), 10);
  return k === 2 ? ['FC', 'BC'] : k === 1 ? ['FC'] : ALL_COMPARTMENTS;
};
module.exports = { ALL_COMPARTMENTS, compartmentCodes };
