// Compartment codes of a tanker from Tanker Master's `compartments` ("2C", "3C", "2", "3").
// Mirrors backend/src/utils/compartments.js: 1 → FC, 2 → FC + BC, otherwise FC, MC, BC.
export const ALL_COMPARTMENTS = ['FC', 'MC', 'BC'];
export const compartmentCodes = txt => {
  const k = parseInt(String(txt ?? '').replace(/[^0-9]/g, ''), 10);
  return k === 2 ? ['FC', 'BC'] : k === 1 ? ['FC'] : ALL_COMPARTMENTS;
};
