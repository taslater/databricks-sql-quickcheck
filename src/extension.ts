// VS Code front end. Runs in the extension host, in-process: there is no
// child process and no Python start-up, so a check is a function call that
// takes well under a millisecond on a typical file and can run on every
// keystroke.

import * as vscode from "vscode";
import { check } from "./check";
import { LANGUAGE_ID, NotebookLanguage } from "./language";

const SECTION = "databricksSqlQuickcheck";
// Coalesce a burst of keystrokes into one check. Short enough to feel instant.
const DEBOUNCE_MS = 40;
const SCHEMES = new Set(["file", "untitled", "vscode-notebook-cell", "vscode-userdata"]);

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("databricks-sql-quickcheck");
  const timers = new Map<string, NodeJS.Timeout>();

  const settings = () => vscode.workspace.getConfiguration(SECTION);

  const applies = (doc: vscode.TextDocument): boolean => {
    const cfg = settings();
    if (!cfg.get<boolean>("enable", true)) return false;
    if (!SCHEMES.has(doc.uri.scheme)) return false;
    return cfg.get<string[]>("languages", ["sql", "databricks-sql"]).includes(doc.languageId);
  };

  const run = (doc: vscode.TextDocument): void => {
    if (!applies(doc)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    const cfg = settings();
    const found = check(text, {
      warnings: cfg.get<boolean>("warnings", true),
      explicitAliases: cfg.get<boolean>("explicitAliases", false),
    });
    diagnostics.set(
      doc.uri,
      found.map((d) => {
        const range = new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end));
        const severity = d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
        const diag = new vscode.Diagnostic(range, d.message, severity);
        diag.source = "quickcheck";
        diag.code = d.code;
        return diag;
      }),
    );
  };

  // Notebooks exported as source open as `sql`, like any other `.sql` file.
  const notebooks = new NotebookLanguage();
  const switchIfNotebook = (doc: vscode.TextDocument): void => {
    if (doc.uri.scheme === "vscode-notebook-cell") return;
    if (!settings().get<boolean>("detectNotebooks", true)) return;
    if (notebooks.opened(doc.uri.toString(), doc.languageId, doc.getText())) {
      vscode.languages.setTextDocumentLanguage(doc, LANGUAGE_ID).then(undefined, () => undefined);
    }
  };

  const schedule = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      run(doc);
    }, DEBOUNCE_MS));
  };

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(run),
    vscode.workspace.onDidOpenTextDocument(switchIfNotebook),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      notebooks.closed(doc.uri.toString(), doc.languageId);
      clearTimeout(timers.get(doc.uri.toString()));
      diagnostics.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) vscode.workspace.textDocuments.forEach(run);
    }),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  );
  vscode.workspace.textDocuments.forEach(run);
  vscode.workspace.textDocuments.forEach(switchIfNotebook);
}

export function deactivate(): void {}
