export interface TitledPage {
  id: string;
  title: string;
}

/**
 * The page an imported `[[title]]` links to: the one imported page of that title, else the one
 * page already in the workspace, else none. A title two pages share links neither, rather than a
 * guess. Titles match ignoring case, as the CLI's lookup does.
 */
export function importLinkResolver(
  imported: TitledPage[],
  workspace: TitledPage[]
): (title: string) => string | null {
  const importedByTitle = idsByTitle(imported);
  const workspaceByTitle = idsByTitle(workspace);

  return (title) => {
    const key = title.toLowerCase();
    const ids = importedByTitle.get(key) ?? workspaceByTitle.get(key) ?? [];

    return ids.length === 1 ? ids[0]! : null;
  };
}

function idsByTitle(pages: TitledPage[]): Map<string, string[]> {
  const byTitle = new Map<string, string[]>();
  for (const { id, title } of pages) {
    const key = title.toLowerCase();
    const ids = byTitle.get(key);
    if (ids) ids.push(id);
    else byTitle.set(key, [id]);
  }

  return byTitle;
}
