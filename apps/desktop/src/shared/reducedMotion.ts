import { MotionGlobalConfig } from "framer-motion";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Makes every Motion animation instant while the system asks for reduced motion,
 * and follows the setting when it changes.
 *
 * app.css's reduced-motion rule reaches only CSS animations and transitions.
 * Motion animates from JavaScript and the Web Animations API, so the toast and
 * the panels moved regardless. `MotionConfig reducedMotion="user"` was not
 * enough: it keeps opacity fades and never reaches an imperative `animate()`,
 * which is how a panel springs open.
 */
export function followReducedMotion(): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);

  function apply() {
    MotionGlobalConfig.skipAnimations = query.matches;
  }

  apply();
  query.addEventListener("change", apply);

  return () => query.removeEventListener("change", apply);
}
