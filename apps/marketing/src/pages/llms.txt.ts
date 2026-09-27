import template from "../content/llms.txt?raw";
import { checkedMonth, comparisonMarkdown, features, legend } from "../content/comparison";

const slots: Record<string, () => string> = {
  "{{comparison-table}}": comparisonMarkdown,
  "{{legend}}": () => legend(features),
  "{{checked}}": checkedMonth,
};

export function GET() {
  let body = template;
  for (const [slot, fill] of Object.entries(slots)) {
    if (!body.includes(slot)) throw new Error(`llms.txt template lost its ${slot} slot`);
    body = body.replace(slot, fill());
  }
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
