'use strict';

// Arrange editor groups into rows whose pane areas are equal, including odd counts.
function gridLayout(count) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new Error('Use between 1 and 9 editor groups.');
  const rows = Math.ceil(count / Math.ceil(Math.sqrt(count)));
  const base = Math.floor(count / rows);
  let extra = count % rows;
  const groups = Array.from({ length: rows }, () => {
    const columns = base + (extra-- > 0 ? 1 : 0);
    return { size: columns / count, groups: Array.from({ length: columns }, () => ({ size: 1 / columns })) };
  });
  return { orientation: 1, groups };
}
module.exports = { gridLayout };
