// Shared exit-code taxonomy across scuttlerun/pincenez/craboodle.
// README.md "Exit Codes" section is the canonical reference; pincenez
// and craboodle subset this for the codes they emit.
export const EXIT_SUCCESS = 0;
export const EXIT_CONFIG_ERROR = 1;
export const EXIT_RUNTIME_ERROR = 2;
export const EXIT_BUDGET_EXCEEDED = 5;
export const EXIT_TIMEOUT = 6;
export const EXIT_MAX_TURNS = 7;
export const EXIT_SIGINT = 130;
