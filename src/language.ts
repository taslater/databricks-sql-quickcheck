// When to move a document from VS Code's generic `sql` mode to `databricks-sql`.
//
// A notebook exported as source and a plain script share the `.sql`
// extension, and VS Code ranks a file association above a manifest's
// `firstLine` pattern, so the `.sql` association always wins and the extension
// has to look at the text itself. It also has to tell its own switch from the
// user's: choosing "SQL" in the language picker must stick.

import { isNotebookSource } from "./lexer";

export const LANGUAGE_ID = "databricks-sql";

export class NotebookLanguage {
  /** Documents the user moved back to `sql` after they were switched. */
  private readonly kept = new Set<string>();
  /** Documents closed in the current tick, with the language they had. */
  private readonly justClosed = new Map<string, string>();

  /**
   * VS Code reports a language change as a close and an open of the same
   * document, back to back in one tick, so a close is remembered only until
   * the tick ends. `defer` is that boundary; tests pass their own.
   */
  constructor(private readonly defer: (f: () => void) => void = queueMicrotask) {}

  closed(uri: string, languageId: string): void {
    this.justClosed.set(uri, languageId);
    this.defer(() => this.justClosed.delete(uri));
  }

  /** Whether a document that just opened should be switched to `databricks-sql`. */
  opened(uri: string, languageId: string, text: string): boolean {
    if (languageId === LANGUAGE_ID) {
      this.kept.delete(uri);
      return false;
    }
    if (languageId !== "sql") return false;
    if (this.justClosed.get(uri) === LANGUAGE_ID) this.kept.add(uri);
    return !this.kept.has(uri) && isNotebookSource(text);
  }
}
