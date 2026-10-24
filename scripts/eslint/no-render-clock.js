/**
 * Flags `new Date()` and `Date.now()` read directly in a component or hook body, which the React
 * Compiler caches at the first render's time; `useNow` says why.
 *
 * Only the nearest enclosing function counts, so a read inside a handler, an effect or a lazy
 * `useState` initializer passes: those run when they're called, not once per cached render.
 */
const isComponentOrHookName = (name) => /^[A-Z]/.test(name) || /^use[A-Z0-9]/.test(name);

function functionName(fn) {
  if (fn.type === "FunctionDeclaration") return fn.id?.name ?? null;
  if (fn.parent?.type === "VariableDeclarator" && fn.parent.id.type === "Identifier") {
    return fn.parent.id.name;
  }
  return null;
}

function isClockRead(node) {
  if (node.type === "NewExpression") {
    return (
      node.callee.type === "Identifier" &&
      node.callee.name === "Date" &&
      node.arguments.length === 0
    );
  }
  const { callee } = node;
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Date" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "now"
  );
}

const rule = {
  meta: {
    messages: {
      renderClock:
        "A clock read in a component or hook body is cached by the React Compiler and never moves. Read `useNow()`, or move it into the handler or effect that needs it.",
    },
    schema: [],
    type: "problem",
  },
  create(context) {
    function check(node) {
      if (!isClockRead(node)) return;

      const fn = context.sourceCode
        .getAncestors(node)
        .findLast((a) =>
          /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(a.type)
        );
      const name = fn ? functionName(fn) : null;
      const isRenderBody = name !== null && isComponentOrHookName(name);

      if (isRenderBody) context.report({ messageId: "renderClock", node });
    }

    return { CallExpression: check, NewExpression: check };
  },
};

export default { rules: { "no-render-clock": rule } };
