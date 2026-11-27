// Run by `pnpm verify` (node --test). RuleTester registers a case per entry with node:test's
// describe/it, so a case that stops flagging or starts flagging fails by name.

import { after, describe, it } from "node:test";

import { RuleTester } from "eslint";

import rule from "./no-silent-catch.js";

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });
const silentCatch = [{ messageId: "silentCatch" }];

tester.run("no-silent-catch", rule, {
  invalid: [
    { code: "try { f(); } catch {}", errors: silentCatch },
    { code: "try { f(); } catch (e) {}", errors: silentCatch },
    { code: "function g() { try { f(); } catch { return null; } }", errors: silentCatch },
    { code: "try { f(); } catch { setError('Failed'); }", errors: silentCatch },
    { code: "p.catch(() => {});", errors: silentCatch },
    { code: "p.catch(() => undefined);", errors: silentCatch },
    { code: "p.catch(() => null);", errors: silentCatch },
    { code: "p.catch((e) => {});", errors: silentCatch },
    { code: "p.catch(function () { return false; });", errors: silentCatch },
    { code: "p.catch(() => void 0);", errors: silentCatch },
  ],
  valid: [
    "try { f(); } catch (e) { log.warn('f failed', e); }",
    "try { f(); } catch { log.warn('f failed'); }",
    "try { f(); } catch { console.error('f failed'); }",
    "try { f(); } catch { this.log.error('f failed'); }",
    "try { f(); } catch { quietLog.warn('f failed'); }",
    "try { f(); } catch (e) { throw new Error('wrapped', { cause: e }); }",
    "try { f(); } catch { throw new Error('f failed'); }",
    "try { f(); } catch (e) { setError(messageFor(e)); }",
    "try { f(); } catch (e) { lastError = e; }",
    "try { f(); } catch ({ message }) { show(message); }",
    "p.catch((e) => log.warn('p failed', e));",
    "p.catch((e) => setError(messageFor(e)));",
    "p.catch(() => { postNotice('Saved, but reminders may not fire.'); });",
    "p.catch(handle);",
    "p.then(ok, () => {});",
  ],
});
