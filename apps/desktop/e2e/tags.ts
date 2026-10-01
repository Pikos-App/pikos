/** Tests that run under a config of their own (perf, the prod-build checks, the
 *  screen tour, the recording), which the everyday suite leaves out. */
export const OWN_CONFIG_TAGS = /@perf|@csp-prod|@recording|@tour/;

/** Tests that can't run against the real writer: they fake the clock, set a zone
 *  of their own, or connect an account. Everything else runs there. */
export const MOCK_ONLY = /@mock-only/;
