/**
 * Flags a caught error that leaves no trace. Pikos has no telemetry, so pikos.log and what the
 * person is shown are the only evidence a failure happened; a catch that drops the error makes the
 * failure invisible to both.
 *
 * A `catch` clause passes when its body logs (a `log.*`, `logger.*` or `console.*` call), throws,
 * or uses the caught value, which covers handing it to a function that shows or records it. A
 * `.catch()` callback is flagged when it neither uses its parameter nor does anything but return
 * nothing or a constant: `() => {}`, `() => null`, `() => undefined`.
 *
 * Silence on purpose takes `// eslint-disable-next-line pikos/no-silent-catch -- <why>`.
 */

const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

function isLoggerObject(node) {
  if (node.type === "Identifier")
    return node.name === "console" || /^(log|logger)$|Log$/.test(node.name);
  if (node.type === "MemberExpression" && node.property.type === "Identifier") {
    return /^(log|logger)$/.test(node.property.name);
  }
  return false;
}

/** Calls `visit` on every node under `root`, stopping early once it returns true. */
function some(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (visit(node)) return true;
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") stack.push(child);
      } else if (value && typeof value.type === "string") {
        stack.push(value);
      }
    }
  }
  return false;
}

function names(pattern) {
  const found = new Set();
  if (!pattern) return found;
  some(pattern, (node) => {
    if (node.type === "Identifier") found.add(node.name);
    return false;
  });
  return found;
}

function usesAny(root, bound) {
  if (bound.size === 0) return false;
  return some(root, (node) => node.type === "Identifier" && bound.has(node.name));
}

function leavesATrace(body, param) {
  const bound = names(param);
  return some(body, (node) => {
    if (node.type === "ThrowStatement") return true;
    if (node.type === "Identifier" && bound.has(node.name)) return true;
    return (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      isLoggerObject(node.callee.object)
    );
  });
}

function isNothing(node) {
  if (!node) return true;
  if (node.type === "Literal") return true;
  if (node.type === "Identifier" && node.name === "undefined") return true;
  return (
    node.type === "UnaryExpression" && node.operator === "void" && node.argument.type === "Literal"
  );
}

/** A callback whose whole effect is to return nothing, or a constant. */
function doesNothing(fn) {
  if (fn.body.type !== "BlockStatement") return isNothing(fn.body);
  const statements = fn.body.body;
  if (statements.length === 0) return true;
  return (
    statements.length === 1 &&
    statements[0].type === "ReturnStatement" &&
    isNothing(statements[0].argument)
  );
}

const rule = {
  meta: {
    messages: {
      silentCatch:
        'This catch drops the error with no trace. Log it (`log.warn("<what failed>", err)`), show it, or rethrow. If silence is right, say why: `// eslint-disable-next-line pikos/no-silent-catch -- <reason>`.',
    },
    schema: [],
    type: "problem",
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        const isCatchCall =
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "catch";
        const handler = node.arguments[0];
        if (!isCatchCall || !handler || !FUNCTION_TYPES.has(handler.type)) return;

        const bound = new Set(handler.params.flatMap((p) => [...names(p)]));
        if (!usesAny(handler.body, bound) && doesNothing(handler)) {
          context.report({ messageId: "silentCatch", node: handler });
        }
      },
      CatchClause(node) {
        if (!leavesATrace(node.body, node.param)) {
          context.report({ messageId: "silentCatch", node });
        }
      },
    };
  },
};

export default rule;
