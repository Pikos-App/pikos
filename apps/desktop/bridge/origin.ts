// 1422 is taken by Vite's HMR socket when the dev server binds a host. The
// server binds IPv4 only, and `localhost` can resolve to ::1 first.
export const BRIDGE_ORIGIN = "http://127.0.0.1:1423";
