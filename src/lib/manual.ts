export const MANUAL_PAGE_PATHS = Array.from({ length: 14 }, (_, index) =>
  `/images/${String(index + 1).padStart(2, "0")}.png`,
);
