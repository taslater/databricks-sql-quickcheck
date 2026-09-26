// Statement-level checks: the shape of a statement, without its grammar.
//
// These know a little more than check.ts -- which words can start a
// statement, the order clauses come in, what a CASE needs, what a column
// definition looks like -- but still nothing about any one statement's full
// syntax. Each check fires only on a shape no valid statement has:
//
//   keyword-typo       `SELECT a FORM t`, `GROPU BY`, `CRATE TABLE`, `IS NUL`.
//                      Only where the position rules out a name: `FORM` above
//                      sits after a complete expression and before another,
//                      where nothing but a keyword can go. A column that
//                      happens to be called `form` never fires.
//   missing-semicolon  a line that starts a new statement while the last one
//                      is still open: `CREATE CATALOG c` then `CREATE SCHEMA s`.
//   missing-comma      between column definitions: `a STRING COMMENT 'x'` then
//                      `b INT` on the next line.
//   clause-order       `GROUP BY a WHERE b`, or a second WHERE.
//   case-structure     THEN without WHEN, WHEN without THEN, a second ELSE.
//   dangling-keyword   `WHERE a > 1 AND`, `WHERE GROUP BY`, `SELECT FROM t`,
//                      and a statement that stops on a keyword still owing an
//                      operand: `ALTER VIEW v RENAME TO`, `DROP SCHEMA`.
//   empty-list         a clause's bracket with nothing in it: `SET TAGS ()`.

import { Ctx, isNameContext, isPunct, isWild, report } from "./common";
import { KEYWORDS } from "./keywords";
import { Token } from "./lexer";

// Words that can begin a statement (including the scripting words that begin
// a fragment inside a BEGIN ... END block, after a `;`).
const STARTERS = new Set([
  "SELECT", "WITH", "FROM", "VALUES", "TABLE", "CREATE", "ALTER", "DROP", "INSERT", "MERGE",
  "UPDATE", "DELETE", "TRUNCATE", "USE", "SET", "RESET", "SHOW", "DESCRIBE", "DESC", "EXPLAIN",
  "GRANT", "REVOKE", "DENY", "OPTIMIZE", "VACUUM", "ANALYZE", "REFRESH", "CACHE", "UNCACHE",
  "CLEAR", "MSCK", "REPAIR", "RESTORE", "CONVERT", "COPY", "COMMENT", "DECLARE", "BEGIN", "END",
  "IF", "ELSE", "ELSEIF", "WHEN", "CASE", "WHILE", "LOOP", "REPEAT", "UNTIL", "FOR", "LEAVE",
  "ITERATE", "SIGNAL", "RESIGNAL", "GET", "RETURN", "CALL", "EXECUTE", "ADD", "LIST", "APPLY",
  "SYNC", "UNDROP", "FSCK", "REORG", "LOAD", "DFS", "OPEN", "FETCH", "CLOSE", "GENERATE",
  "REPLACE", "COMMIT", "ROLLBACK", "PUT", "REMOVE", "KILL",
]);

// Column and parameter types, for recognising a column definition.
const TYPES = new Set([
  "STRING", "VARCHAR", "CHAR", "BIGINT", "INT", "INTEGER", "SMALLINT", "TINYINT", "LONG", "SHORT",
  "BYTE", "DOUBLE", "FLOAT", "REAL", "DECIMAL", "DEC", "NUMERIC", "BOOLEAN", "DATE", "TIMESTAMP",
  "TIMESTAMP_NTZ", "TIMESTAMP_LTZ", "BINARY", "ARRAY", "MAP", "STRUCT", "VARIANT", "VOID",
  "INTERVAL", "GEOGRAPHY", "GEOMETRY", "OBJECT",
]);
const GENERIC = new Set(["ARRAY", "MAP", "STRUCT"]);

const OBJECTS = [
  "TABLE", "VIEW", "SCHEMA", "DATABASE", "CATALOG", "FUNCTION", "VOLUME", "CONNECTION", "SHARE",
  "RECIPIENT", "PROVIDER", "CREDENTIAL", "PROCEDURE", "LOCATION", "VARIABLE",
];
const OBJECT_MODIFIERS = ["TEMPORARY", "EXTERNAL", "STREAMING", "MATERIALIZED", "LIVE", "GLOBAL", "PRIVATE"];

// Keywords that cannot end an expression: a word after one of these is its
// argument, not an alias. Every other word -- including the many keywords
// Databricks code uses as names (`target`, `name`, `date`, `DELTA`) -- can.
const CONTINUES = new Set([
  "AS", "THEN", "ELSE", "WHEN", "CASE", "DO", "BEGIN", "LOOP", "REPEAT", "ON", "WITH", "SELECT",
  "FROM", "WHERE", "AND", "OR", "NOT", "BY", "IN", "IS", "INTO", "OF", "TO", "FOR", "USING", "SET",
  "BETWEEN", "LIKE", "ILIKE", "RLIKE", "JOIN", "HAVING", "QUALIFY", "LIMIT", "OFFSET", "UNION",
  "INTERSECT", "EXCEPT", "MINUS", "VALUES", "CREATE", "DROP", "ALTER", "INSERT", "UPDATE", "MERGE",
  "OVERWRITE", "PARTITION", "PARTITIONED", "CLUSTER", "CLUSTERED", "COMMENT", "LOCATION",
  "TBLPROPERTIES", "OPTIONS", "ADD", "RENAME", "DEFAULT", "CONSTRAINT", "REFERENCES", "GRANT",
  "REVOKE", "RETURNS", "RETURN", "LANGUAGE", "OUTER", "INNER", "LEFT", "RIGHT", "FULL", "CROSS",
  "NATURAL", "SEMI", "ANTI", "LATERAL", "TABLE", "VIEW", "SCHEMA", "DATABASE", "CATALOG", "FUNCTION",
  "VOLUME", "COLUMN", "COLUMNS", "DISTINCT", "ALL", "EXISTS", "IF", "TEMPORARY", "EXTERNAL",
  "STREAMING", "MATERIALIZED", "LIVE", "GLOBAL", "REPLACE", "REFRESH", "IDENTIFIER", "CAST",
  "INTERVAL", "EXPLAIN", "DESCRIBE", "SHOW", "USE", "QUERY", "TRUNCATE", "ANALYZE", "OPTIMIZE",
  "CACHE", "UNCACHE", "MSCK", "REPAIR", "RESTORE", "CONVERT", "COPY", "DECLARE", "CALL", "EXECUTE",
  "IMMEDIATE", "APPLY", "CHANGES", "SEQUENCE", "STORED", "TRACK", "HISTORY", "EXPECT", "VIOLATION",
  "OVER", "FILTER", "WITHIN", "WINDOW", "PIVOT", "UNPIVOT", "TABLESAMPLE", "ESCAPE", "COLLATE",
  "NULLS", "ROWS", "RANGE", "UNBOUNDED", "CURRENT", "GROUPING", "SETS", "TERMINATED", "FIELDS",
  "LINES", "DELIMITED", "FORMAT", "SERDE", "OWNER", "TAGS", "ZORDER", "KEYS", "AUTO", "CDC", "DETAIL",
  // EXPLAIN modes: a statement follows
  "EXTENDED", "FORMATTED", "CODEGEN", "COST", "LOGICAL",
]);

// Keywords that cannot begin an operand. Every other word can, again because
// Databricks lets most keywords be names.
const STRUCTURAL = new Set([
  "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "QUALIFY", "LIMIT", "OFFSET", "UNION", "INTERSECT",
  "EXCEPT", "MINUS", "JOIN", "ON", "USING", "AND", "OR", "AS", "SELECT", "WHEN", "THEN", "ELSE",
  "END", "BY", "IN", "IS", "BETWEEN", "LIKE", "ILIKE", "RLIKE", "INTO", "VALUES", "SET", "OVER",
  "PARTITION", "ASC", "DESC", "NULLS", "ROWS", "RANGE", "LATERAL", "PIVOT", "UNPIVOT", "CROSS",
  "FULL", "OUTER", "NATURAL", "SEMI", "ANTI", "INNER", "WITH", "TABLESAMPLE", "FOR", "DO", "TO", "OF",
  "WINDOW",
]);

// After keyword X (in a statement led by `lead`, if given), the next word must be one of these.
interface Follow {
  after: string;
  prev?: string[]; // the keyword before X
  lead?: string[];
  first?: boolean; // X starts the statement (or follows EXPLAIN)
  evidence?: Evidence;
  next: string[];
}
type Evidence = (s: Stmt, i: number) => boolean;
const nameNext: Evidence = (s, i) => s.isName(i + 1);
const SHOWABLE = [
  "TABLES", "TABLE", "VIEWS", "SCHEMAS", "DATABASES", "CATALOGS", "FUNCTIONS", "COLUMNS",
  "PARTITIONS", "GRANTS", "CREATE", "TBLPROPERTIES", "VOLUMES", "USER", "SYSTEM", "ALL", "CURRENT",
  "SHARES", "RECIPIENTS", "PROVIDERS", "CONNECTIONS", "CREDENTIALS", "EXTERNAL", "LOCATIONS",
  "GROUPS", "USERS", "PROCEDURES",
];
const FOLLOWERS: Follow[] = [
  { after: "IS", next: ["NULL", "NOT", "TRUE", "FALSE", "UNKNOWN", "DISTINCT"] },
  { after: "NOT", prev: ["IS"], next: ["NULL", "TRUE", "FALSE", "UNKNOWN", "DISTINCT"] },
  { after: "NOT", prev: ["IF"], next: ["EXISTS"] },
  { after: "NOT", lead: ["CREATE", "ALTER", "REPLACE", "DECLARE"], next: ["NULL", "EXISTS"] },
  { after: "IF", next: ["NOT", "EXISTS"] },
  { after: "CREATE", next: ["OR", ...OBJECTS, ...OBJECT_MODIFIERS, "FLOW"] },
  { after: "OR", prev: ["CREATE", "DECLARE"], next: ["REPLACE", "REFRESH"] },
  { after: "REPLACE", prev: ["OR"], next: [...OBJECTS, ...OBJECT_MODIFIERS] },
  { after: "REFRESH", prev: ["OR"], next: [...OBJECTS, ...OBJECT_MODIFIERS] },
  { after: "DROP", first: true, next: [...OBJECTS, ...OBJECT_MODIFIERS] },
  { after: "ALTER", first: true, next: [...OBJECTS, ...OBJECT_MODIFIERS] },
  { after: "TEMPORARY", next: ["TABLE", "VIEW", "FUNCTION", "VARIABLE", "LIVE", "STREAMING"] },
  { after: "STREAMING", next: ["TABLE", "LIVE"] },
  { after: "MATERIALIZED", next: ["VIEW"] },
  { after: "LIVE", next: ["TABLE", "VIEW"] },
  { after: "INSERT", next: ["INTO", "OVERWRITE"] },
  { after: "INTO", prev: ["INSERT", "OVERWRITE"], evidence: nameNext, next: ["TABLE"] },
  { after: "MERGE", next: ["INTO"] },
  { after: "DELETE", first: true, next: ["FROM"] },
  { after: "TRUNCATE", next: ["TABLE"] },
  { after: "CACHE", next: ["TABLE", "LAZY"] },
  { after: "UNCACHE", next: ["TABLE"] },
  { after: "ANALYZE", next: ["TABLE", "TABLES"] },
  { after: "REPAIR", next: ["TABLE"] },
  { after: "RESTORE", next: ["TABLE"] },
  { after: "SHOW", next: SHOWABLE },
  { after: "USE", evidence: (s, i) => s.startsOperand(i + 1) || s.isKw(i + 1, "ON"), next: ["CATALOG", "SCHEMA", "DATABASE"] },
  { after: "ON", prev: ["COMMENT"], next: OBJECTS },
  { after: "RETURNS", next: ["TABLE"] },
  { after: "SET", lead: ["ALTER"], next: ["TBLPROPERTIES", "DBPROPERTIES", "LOCATION", "OWNER", "TAGS", "SERDEPROPERTIES", "DEFAULT"] },
  { after: "UNSET", next: ["TBLPROPERTIES", "TAGS"] },
  ...["LEFT", "RIGHT", "FULL"].map((k): Follow => ({ after: k, next: ["OUTER", "JOIN", "SEMI", "ANTI"] })),
  ...["INNER", "CROSS", "NATURAL", "OUTER", "SEMI", "ANTI"].map((k): Follow => ({ after: k, next: ["JOIN"] })),
  { after: "LATERAL", next: ["VIEW"] },
  { after: "VIEW", prev: ["LATERAL"], next: ["OUTER"] },
  { after: "VIOLATION", next: ["DROP", "FAIL"] },
  { after: "CHANGES", next: ["INTO"] },
  { after: "MATCHED", next: ["THEN"] },
  { after: "THEN", lead: ["MERGE"], next: ["UPDATE", "DELETE", "INSERT"] },
];

// Typos proven by the next word alone, wherever they sit: only a keyword is
// ever followed by BY, only CASE by WHEN (outside MERGE), only EXISTS by a
// bracketed query.
const byNext: Evidence = (s, i) => s.isKw(i + 1, "BY");
const ANYWHERE_TARGETS: [string, Evidence][] = [
  ...["GROUP", "ORDER", "PARTITION", "CLUSTER", "SORT", "DISTRIBUTE", "ZORDER", "PARTITIONED", "CLUSTERED"].map(
    (k): [string, Evidence] => [k, byNext],
  ),
  ["CASE", (s, i) => s.isKw(i + 1, "WHEN") && s.lead !== "MERGE"],
  ["EXISTS", (s, i) => s.isPunctAt(i + 1, "(") && s.isKw(i + 2, "SELECT", "WITH")],
  ["WHEN", (s, i) => s.isKw(i + 1, "MATCHED") || (s.isKw(i + 1, "NOT") && s.isKw(i + 2, "MATCHED"))],
  ["THEN", (s, i) => s.lead === "MERGE" && s.isKw(i + 1, "INSERT", "UPDATE", "DELETE")],
];

// Keywords a mistyped word can be when it sits between two operands, where no
// name can go, and the evidence the next tokens have to give. Only targets of
// 4+ letters: at 2-3 letters (AS, ON, IN, AND) too many real names are one
// edit away.
const ALIAS_POSITION_TARGETS: [string, Evidence][] = [
  ["FROM", (s, i) => (s.startsOperand(i + 1) || s.isKw(i + 1, "VALUES")) && !s.laterAtDepth(i, "FROM")],
  ["SELECT", (s, i) => s.startsOperand(i + 1) || s.isOpAt(i + 1, "*") || s.isKw(i + 1, "DISTINCT", "ALL")],
  ["VALUES", (s, i) => (s.lead === "INSERT" || s.lead === "MERGE") && s.isPunctAt(i + 1, "(")],
  ["TABLE", (s, i) => s.lead === "INSERT" && s.isName(i + 1)],
  ["WHERE", (s, i) => s.startsCondition(i + 1) && !s.laterAtDepth(i, "WHERE")],
  ["HAVING", (s, i) => s.startsCondition(i + 1) && !s.laterAtDepth(i, "HAVING")],
  ["QUALIFY", (s, i) => s.startsCondition(i + 1) && !s.laterAtDepth(i, "QUALIFY")],
  ["LIMIT", (s, i) => s.toks[i + 1]?.kind === "number" || s.isKw(i + 1, "ALL")],
  ["OFFSET", (s, i) => s.toks[i + 1]?.kind === "number"],
  ["JOIN", (s, i) => s.startsOperand(i + 1) && s.soonAtDepth(i, ["ON", "USING"], 12)],
  ...["INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "NATURAL"].map(
    (k): [string, Evidence] => [k, (s, i) => s.isKw(i + 1, "JOIN", "OUTER", "SEMI", "ANTI")],
  ),
  ...["UNION", "INTERSECT", "MINUS", "EXCEPT"].map(
    (k): [string, Evidence] => [k, (s, i) => s.isKw(i + 1, "SELECT", "ALL", "DISTINCT", "VALUES")],
  ),
  ["WHEN", (s, i) => s.insideCase(i) && s.startsCondition(i + 1)],
  ["THEN", (s, i) => s.insideCase(i) && s.startsOperand(i + 1)],
  ["ELSE", (s, i) => s.insideCase(i) && s.startsOperand(i + 1)],
  ["LIKE", (s, i) => s.toks[i + 1]?.kind === "string"],
  ["ILIKE", (s, i) => s.toks[i + 1]?.kind === "string"],
  ["RLIKE", (s, i) => s.toks[i + 1]?.kind === "string"],
  ["BETWEEN", (s, i) => s.startsOperand(i + 1) && s.soonAtDepth(i, ["AND"], 20)],
  // ALTER TABLE t <action>
  ["ALTER", (s, i) => s.lead === "ALTER" && s.isKw(i + 1, "COLUMN")],
  ["ADD", (s, i) => s.lead === "ALTER" && s.isKw(i + 1, "COLUMN", "COLUMNS", "CONSTRAINT", "PARTITION")],
  ["DROP", (s, i) => s.lead === "ALTER" && s.isKw(i + 1, "NOT", "COLUMN", "COLUMNS", "CONSTRAINT", "PARTITION", "MASK", "ROW", "FEATURE", "DEFAULT")],
  ["RENAME", (s, i) => s.lead === "ALTER" && s.isKw(i + 1, "TO", "COLUMN")],
  ["CHANGE", (s, i) => s.lead === "ALTER" && s.isKw(i + 1, "COLUMN")],
  // DDL clauses
  ["COMMENT", (s, i) => s.ddl && s.toks[i + 1]?.kind === "string"],
  ["LOCATION", (s, i) => s.ddl && s.toks[i + 1]?.kind === "string"],
  ["TBLPROPERTIES", (s, i) => s.ddl && s.isPunctAt(i + 1, "(")],
  ["DBPROPERTIES", (s, i) => s.ddl && s.isPunctAt(i + 1, "(")],
  ["OPTIONS", (s, i) => s.ddl && s.isPunctAt(i + 1, "(")],
  ["USING", (s, i) => s.ddl && s.toks[i + 1]?.kind === "word"],
  ["DEFAULT", (s, i) => s.ddl && s.startsOperand(i + 1)],
  ["COLLATE", (s, i) => s.ddl && s.toks[i + 1]?.kind === "word"],
];

// A mistyped SELECT/VALUES where a query must start: after `(`, AS or a set operator.
const QUERY_POSITION_TARGETS: [string, Evidence][] = [
  ["SELECT", (s, i) => s.startsOperand(i + 1) || s.isOpAt(i + 1, "*") || s.isKw(i + 1, "DISTINCT", "ALL")],
  ["VALUES", (s, i) => s.isPunctAt(i + 1, "(")],
];
const QUERY_POSITION_PREV = new Set(["AS", "UNION", "INTERSECT", "EXCEPT", "MINUS", "ALL", "DISTINCT"]);

// A line that starts with one of these begins a new statement, when the next word agrees.
const NEW_STATEMENT: Record<string, string[] | null> = {
  CREATE: null,
  REPLACE: ["TABLE"], REPAIR: ["TABLE"],
  DESC: ["DATABASE", "TABLE", "SCHEMA", "FUNCTION", "HISTORY", "DETAIL", "QUERY", "CATALOG", "VOLUME", "EXTENDED", "FORMATTED"],
  DROP: [...OBJECTS, ...OBJECT_MODIFIERS],
  ALTER: [...OBJECTS, ...OBJECT_MODIFIERS],
  USE: null, GRANT: null, REVOKE: null, OPTIMIZE: null, VACUUM: null, MSCK: null,
  SHOW: null, DESCRIBE: null, EXPLAIN: null, DECLARE: null, CALL: null, UNCACHE: null,
  RESTORE: null,
  TRUNCATE: ["TABLE"], ANALYZE: ["TABLE", "TABLES"], MERGE: ["INTO", "WITH"],
  INSERT: ["INTO", "OVERWRITE"], DELETE: ["FROM"], COMMENT: ["ON"], CACHE: ["TABLE", "LAZY"],
  CLEAR: ["CACHE"], CONVERT: ["TO"], COPY: ["INTO"], EXECUTE: ["IMMEDIATE"], APPLY: ["CHANGES"],
  REFRESH: ["TABLE", "MATERIALIZED", "STREAMING", "FUNCTION", "FOREIGN"],
};

// Clause order within one query block. WINDOW is left out: it has two legal places.
const CLAUSE_RANK: Record<string, number> = {
  WHERE: 1, "GROUP BY": 2, HAVING: 3, QUALIFY: 4, "ORDER BY": 5, "CLUSTER BY": 5,
  "DISTRIBUTE BY": 5, "SORT BY": 6, LIMIT: 7, OFFSET: 8,
};

// Keywords that need something after them, and what may not directly follow.
const CLAUSE_STARTS = ["FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "QUALIFY", "UNION", "INTERSECT", "MINUS"];
const CONDITION = ["AND", "OR", "THEN"];
const DANGLING: Record<string, string[]> = {
  WHERE: [...CLAUSE_STARTS, ...CONDITION], HAVING: [...CLAUSE_STARTS, ...CONDITION],
  QUALIFY: [...CLAUSE_STARTS, ...CONDITION], ON: [...CLAUSE_STARTS, ...CONDITION],
  AND: [...CLAUSE_STARTS, ...CONDITION], OR: [...CLAUSE_STARTS, ...CONDITION],
  NOT: [...CLAUSE_STARTS, ...CONDITION], WHEN: [...CLAUSE_STARTS, ...CONDITION],
  BETWEEN: CLAUSE_STARTS, IN: CLAUSE_STARTS, LIKE: CLAUSE_STARTS, ILIKE: CLAUSE_STARTS,
  RLIKE: CLAUSE_STARTS, IS: CLAUSE_STARTS,
  THEN: [...CLAUSE_STARTS, "WHEN", "ELSE", "END"], ELSE: [...CLAUSE_STARTS, "WHEN", "END"],
  SELECT: CLAUSE_STARTS, FROM: [...CLAUSE_STARTS, "JOIN", "ON"], JOIN: [...CLAUSE_STARTS, "ON", "USING", "JOIN"],
  BY: CLAUSE_STARTS, UNION: CLAUSE_STARTS, INTERSECT: CLAUSE_STARTS, MINUS: CLAUSE_STARTS,
};

// Keywords that cannot be the last token of a statement, whatever precedes
// them: syntax glue that always owes something after it. A statement ending
// here is truncated (`CREATE VIEW v AS`, `ALTER CONNECTION c RENAME TO`).
//
// Membership is the opposite trade from KEYWORDS: an extra word here is a
// false positive, not a lost catch, so a word goes in only if no valid
// statement anywhere ends with it. `scripts/derive_shape_sets.py` checks that
// against the 866 corpus files, the reference must-parse cases and
// spark-sql-tests, and fails if one of these ever ends a valid statement.
// That is why `STATISTICS`, `PARTITIONS`, `DELTA`, `LITE`, `CSV` and `END` are
// absent: `ANALYZE TABLE t COMPUTE STATISTICS` and `VACUUM t LITE` are real.
const NEEDS_FOLLOWER = new Set([
  "AS", "CLONE", "COLLATION", "DECLARE", "EXPLAIN", "FROM", "GROUP", "INTO", "LIMIT", "NO", "OF",
  "OFFSET", "OPTIMIZE", "PARTITIONED", "SET", "TBLPROPERTIES", "TO", "USING", "VACUUM", "VALUES",
  "WITH",
]);

// The same, but only where a name has just been given, so the word cannot be
// the name itself. `CREATE SCHEMA s COMMENT` owes a string; `SELECT id,
// comment` and `ALTER TABLE t DROP COLUMN location` are a column called
// `comment` and one called `location`, and must stay quiet. The discriminator
// is the token before: a name or `)` means the clause keyword is structural,
// while a keyword before it (`COLUMN`, `TO`) means a name is what is expected.
const NEEDS_FOLLOWER_AFTER_NAME = new Set(["COMMENT", "LOCATION", "ENABLE", "URL"]);

// Object types that a statement must name. `DROP SCHEMA` has lost its name --
// but only when the statement names nothing at all, which is the guard that
// makes this safe: `ALTER TABLE t DROP COLUMN query` mentions `t`, so it is a
// column called `query` and never fires. Every real statement names its
// object, so "ends in an object type and contains no identifier" is truncated.
//
// `CATALOG` is deliberately absent. Its name is optional wherever it appears
// -- `{ USE | SET } CATALOG [ catalog_name ]` and the securable production's
// `CATALOG [ catalog_name ]` -- so `USE CATALOG` and `SHOW GRANTS ON CATALOG`
// both parse, and both are must-parse cases in the reference corpus. Adding
// it costs `DROP CATALOG` and `DESCRIBE CATALOG`; that is the right trade.
const OBJECT_TYPES = new Set([
  "TABLE", "VIEW", "SCHEMA", "DATABASE", "FUNCTION", "VOLUME", "CONNECTION", "SHARE",
  "RECIPIENT", "PROVIDER", "CREDENTIAL", "PROCEDURE", "VARIABLE", "INDEX", "QUERY", "LOCATION",
  "STREAMING", "MATERIALIZED", "PIPELINE",
]);

// Verbs whose statement is about a named object. A query (`SELECT`) is not
// here: its tail is a select list, where keywords are routinely column names.
const OBJECT_VERBS = new Set([
  "DROP", "DESCRIBE", "DESC", "CACHE", "UNCACHE", "TRUNCATE", "UNDROP", "REPAIR", "FSCK", "USE",
  "CREATE", "ALTER", "SHOW", "COMMENT", "GENERATE", "LOAD", "GRANT", "REVOKE", "DENY", "CONVERT",
  "MSCK", "REFRESH", "ANALYZE", "OPTIMIZE", "VACUUM", "RESTORE", "SYNC",
]);

// Words that may sit between the verb and the object type. The object type
// must follow one of these or the verb itself, because the alternative is
// that the word IS the name: Spark's own suite writes `DROP VIEW view` and
// `SHOW TBLPROPERTIES view`, and `SHOW CURRENT SCHEMA` is a real statement.
// Each of those has something else directly before the final word, so the
// allowlist is what separates a truncated statement from a named one.
//
// `ON`, `IN` and `TO` are deliberately absent, even though they would add
// `SHOW GRANTS ON VIEW` and `GRANT ... TO RECIPIENT`: they also precede a
// name, so `GRANT SELECT ON view` and `RENAME COLUMN a TO view` would fire.
const OBJECT_MODIFIER_WORDS = new Set([
  "EXTERNAL", "MANAGED", "MATERIALIZED", "TEMPORARY", "GLOBAL", "LIVE", "PRIVATE", "BLOOMFILTER",
  "STORAGE", "SERVICE", "STREAMING", "CREATE", "REPLACE", "REFRESH", "ADD",
]);

// Clause keywords whose bracket is a list the reference requires to be
// non-empty. Keyed on the keyword before the `(` rather than on `()` itself,
// because `array()`, `map()` and `current_timestamp()` are valid calls.
// `TABLE`, `AS`, `BY`, `EXCEPT`, `TABLESAMPLE` and `CURRENT_TIMESTAMP` are
// left out: valid SQL writes each with an empty bracket somewhere.
/**
 * Keyword pairs that cannot sit next to each other, because the docs put a
 * mandatory slot between them or make them exclusive alternatives.
 *
 * This is the general form of `NEEDS_FOLLOWER`, which is the case where the
 * second word is the end of the statement. It is an explicit deny-list and
 * must stay one: a table of "adjacencies not seen in the corpus" would fire on
 * 21.8% of valid statements, because one valid statement in five contains a
 * keyword pair found nowhere else (measured; `docs/design-notes.md`). New
 * Databricks syntax must not be able to make this fire -- only editing the
 * list can.
 *
 * Every entry names the reference case that proves it. A pair was admitted
 * only after the page's verbatim `syntax:` block confirmed that the case's
 * `omits:` sits *between* these two words, or its `conflicts:` names them
 * both. `scripts/derive_shape_sets.py` generates candidates; it never admits
 * one.
 *
 * `lead` is the statement's first keyword, and is the positional evidence that
 * keeps a pair from firing on a name. `FULL LITE` is wrong in `VACUUM` and
 * says nothing anywhere else, where `full` could be a column.
 */
interface Adjacency {
  /** The statement lead this holds under. Absent means any statement. */
  lead?: string;
  /** What the docs require between the two words. */
  why: string;
  /** The reference case that proves it. */
  case: string;
}

const FORBIDDEN_PAIRS = new Map<string, Adjacency>([
  // --- exclusive alternatives: both alternatives written -------------------
  ["ALL DISTINCT", { lead: "SELECT", case: "select-clause.all-and-distinct",
    why: "SELECT takes ALL or DISTINCT, not both" }],
  ["EXTENDED CODEGEN", { lead: "EXPLAIN", case: "explain.extended-and-codegen",
    why: "EXPLAIN takes one mode, not EXTENDED and CODEGEN both" }],
  ["FULL LITE", { lead: "VACUUM", case: "vacuum.full-and-lite",
    why: "VACUUM is FULL or LITE, not both" }],
  ["RUN FULL", { lead: "VACUUM", case: "vacuum.dry-run-and-full",
    why: "VACUUM is DRY RUN or FULL, not both" }],
  ["DELETE UPDATE", { lead: "MERGE", case: "merge-into.mixed-matched-action",
    why: "a matched action is DELETE or UPDATE, not both" }],
  ["SQL READS", { lead: "CREATE", case: "create-function.contains-sql-and-reads-sql-data",
    why: "a function declares CONTAINS SQL or READS SQL DATA, not both" }],
  ["TEMP EXTERNAL", { lead: "CREATE", case: "create-table.external-temp",
    why: "a table is TEMPORARY or EXTERNAL, not both" }],
  ["NULLS EXCLUDE", { lead: "SELECT", case: "unpivot.include-and-exclude",
    why: "UNPIVOT is INCLUDE NULLS or EXCLUDE NULLS, not both" }],

  // --- a mandatory slot with nothing in it ---------------------------------
  // No lead: `BETWEEN AND` has no start value in any statement that can write it.
  ["BETWEEN AND", { case: "fsck-repair-table.between-without-start",
    why: "BETWEEN has no start value before its AND" }],
  ["BY INTO", { lead: "CREATE", case: "create-table.clustered-without-columns",
    why: "CLUSTERED BY needs its column list before INTO" }],
  ["FROM FILEFORMAT", { lead: "COPY", case: "copy-into.from-without-source",
    why: "FROM needs a source before FILEFORMAT" }],
  ["VALIDATE ROWS", { lead: "COPY", case: "copy-into.validate-without-number",
    why: "VALIDATE needs a number of rows" }],
  ["FOR DAYS", { lead: "CREATE", case: "create-schema.retain-dropped-without-number",
    why: "RETAIN DROPPED FOR needs a number of days" }],
  ["INPATH INTO", { lead: "LOAD", case: "load-data.without-path",
    why: "INPATH needs a path" }],
  ["GRANT ON", { lead: "GRANT", case: "grant.without-privilege-types",
    why: "GRANT needs privileges before ON" }],
  ["REVOKE ON", { lead: "REVOKE", case: "revoke.without-privilege-types",
    why: "REVOKE needs privileges before ON" }],
  ["SHARE FROM", { lead: "REVOKE", case: "revoke-share.without-share",
    why: "SHARE needs a name" }],
  ["WHERE SELECT", { lead: "INSERT", case: "insert.replace-where-without-predicate",
    why: "REPLACE WHERE needs a predicate" }],
  ["ON SELECT", { lead: "INSERT", case: "insert.replace-on-without-expression",
    why: "REPLACE ON needs an expression" }],
  ["FORMAT SELECT", { lead: "INSERT", case: "insert-overwrite-directory-hive.row-format-without-value",
    why: "ROW FORMAT needs a format" }],
  ["INSERT SELECT", { lead: "CREATE", case: "create-streaming-table.flow-insert-without-by-name",
    why: "a FLOW INSERT needs BY NAME before its query" }],
  ["WHERE APPLY", { lead: "REORG", case: "reorg-table.where-without-predicate",
    why: "WHERE needs a predicate" }],
  ["COLLATION RETURN", { lead: "CREATE", case: "create-function.default-collation-without-name",
    why: "DEFAULT COLLATION needs a collation name" }],
  ["VIEW AS", { lead: "SELECT", case: "lateral-view.without-generator-function",
    why: "LATERAL VIEW needs a generator function" }],
  ["OUTER AS", { lead: "SELECT", case: "lateral-view.outer-without-generator-function",
    why: "LATERAL VIEW OUTER needs a generator function" }],
  ["WITH AS", { lead: "CREATE", case: "create-view.with-without-clause",
    why: "WITH needs a clause: SCHEMA BINDING, SCHEMA EVOLUTION or METRICS" }],
  ["GENERATE FOR", { lead: "GENERATE", case: "generate.without-mode",
    why: "GENERATE needs a mode before FOR" }],
  ["TABLE RENAME", { lead: "ALTER", case: "alter-table.no-table-name",
    why: "ALTER TABLE needs a table name" }],
  ["GROUP ADD", { lead: "ALTER", case: "alter-group.without-principal",
    why: "ALTER GROUP needs a group name" }],
  ["RESTORE TO", { lead: "RESTORE", case: "restore.without-table-name",
    why: "RESTORE needs a table name" }],

  // --- a required modifier missing -----------------------------------------
  ["OR VIEW", { lead: "CREATE", case: "create-view.or-without-replace",
    why: "CREATE OR needs REPLACE" }],
  ["REFRESH VIEW", { lead: "CREATE", case: "create-view.or-refresh",
    why: "a view is CREATE OR REPLACE; OR REFRESH is for streaming tables and materialized views" }],
  ["GLOBAL VIEW", { lead: "CREATE", case: "create-view.global-without-temporary",
    why: "GLOBAL needs TEMPORARY" }],

  // --- compound statements --------------------------------------------------
  ["ATOMIC END", { case: "compound-stmt.without-body",
    why: "a BEGIN ATOMIC block has no statements in it" }],
  ["IF THEN", { case: "if-stmt.without-condition",
    why: "IF needs a condition before THEN" }],
]);

/**
 * Two-token tails that owe a follower, where one token is not evidence enough.
 * `LOCATION` alone cannot go in `NEEDS_FOLLOWER` -- `ALTER TABLE t DROP COLUMN
 * location` is a column -- but `MANAGED LOCATION` is never a name.
 */
const NEEDS_FOLLOWER_PAIRS = new Set([
  "MANAGED LOCATION", "ADD TABLE", "FOR TABLE", "INTO TABLE", "IN PROVIDER", "TO RECIPIENT",
]);

/**
 * Keywords whose bracket must hold a query: `FROM (`, `JOIN (`, `EXISTS (`,
 * `IN (`, a CTE's `AS (`, a set operand. A `FROM` inside one, not first and
 * with no `SELECT` before it, means the `SELECT` was lost -- `FROM (a, b FROM
 * t)`. A word that is not one of these owns a function call, where `FROM` is
 * ordinary syntax: `extract(YEAR FROM d)`, `substring(s FROM 2)`.
 */
const QUERY_BRACKET_OWNERS = new Set([
  "FROM", "JOIN", "EXISTS", "IN", "AS", "LATERAL", "UNION", "INTERSECT", "EXCEPT", "MINUS",
  "ALL", "DISTINCT", "WHERE", "HAVING", "ON", "AND", "OR", "NOT", "THEN", "ELSE", "WHEN",
  "SELECT", "RETURN",
]);
/** Set operators: what follows one is a query. `EXCEPT` after `*` is not one. */
const SET_OPERATORS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);
/**
 * Statement verbs that can follow a CTE list or open a set operand without a
 * `SELECT`: `WITH c AS (...) INSERT INTO t ...`. The segment scan stops at one,
 * because a `FROM` after it belongs to that statement, not to a lost `SELECT`.
 */
const NOT_A_SELECT_LIST = new Set([
  "INSERT", "DELETE", "UPDATE", "MERGE", "VALUES", "TABLE", "COPY", "APPLY", "AUTO", "CACHE",
  "CREATE", "REFRESH", "OPTIMIZE",
]);

/**
 * What a FROM clause may contain at its own depth, besides names, dots and
 * commas. The scan for a stray comparison stops at the first keyword not
 * listed, which is how it knows the clause has ended -- so leaving a word out
 * only ever makes the check quieter. `TIMESTAMP` and `VERSION` are left out on
 * purpose: `TIMESTAMP AS OF <expr>` takes an expression, and that is the one
 * place a table reference can hold an operator.
 */
const IN_FROM_CLAUSE = new Set([
  "AS", "LATERAL", "VIEW", "OUTER", "TABLESAMPLE", "REPEATABLE", "STREAM", "TABLE", "VALUES",
  "PIVOT", "UNPIVOT", "INCLUDE", "EXCLUDE", "NULLS", "JOIN", "ON", "USING", "NATURAL", "CROSS",
  "INNER", "LEFT", "RIGHT", "FULL", "ANTI", "SEMI",
]);
/** Once any of these appears, a comparison may be a join condition. */
const FROM_JOINS = new Set([
  "JOIN", "ON", "USING", "NATURAL", "CROSS", "INNER", "LEFT", "RIGHT", "FULL", "ANTI", "SEMI",
  "LATERAL", "PIVOT", "UNPIVOT", "TABLESAMPLE",
]);
const COMPARISONS = new Set(["=", "==", "<", ">", "<=", ">=", "<>", "!=", "<=>"]);

// Words that own a bracketed list only through a following `BY`. Kept apart
// from EMPTY_LIST_OWNERS because the token adjacent to `(` is `BY`, and `BY`
// by itself is not evidence of anything.
const EMPTY_LIST_OWNER_PAIRS = ["ZORDER", "SORTED", "CLUSTERED", "DISTRIBUTE"];
const EMPTY_LIST_OWNERS = new Set([
  "APPLY", "COLUMNS", "COPY_OPTIONS", "DBPROPERTIES", "ENCRYPTION", "ENVIRONMENT",
  "EXCEPT", "FORMAT_OPTIONS", "IDENTIFIER", "IN", "OPTIONS", "PARTITION", "PIVOT", "PROPERTIES",
  "REPEATABLE", "SETS", "TABLESAMPLE", "TAGS", "TBLPROPERTIES", "UNIFORM", "UNPIVOT", "USING",
  "VALUES", "ZORDER",
]);

/** Optimal string alignment distance of exactly 1 (one edit or one adjacent swap). */
export function oneEditAway(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let i = 0;
    while (a[i] === b[i]) i++;
    let j = a.length - 1;
    while (a[j] === b[j]) j--;
    return i === j || (j === i + 1 && a[i] === b[j] && a[j] === b[i]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

export function checkStatements(toks: Token[], depth: number[], ctx: Ctx): void {
  const s = new Stmt(toks, depth, ctx);
  s.statementStart();
  s.keywordTypos();
  s.missingSemicolons();
  // Privilege lists (`GRANT SELECT, MODIFY ON ...`) read as broken queries to
  // the comma and clause-order heuristics, so those are skipped. The shape
  // checks below are safe on them and are what catches `GRANT ... ON TABLE t TO`.
  const privilege = s.lead === "GRANT" || s.lead === "REVOKE" || s.lead === "DENY";
  if (!privilege) {
    s.columnDefinitions();
    s.clauseOrder();
    s.caseStructure();
    s.danglingKeywords();
    s.namedArgumentArrows();
    s.queryWithoutSelect();
    s.comparisonInFromList();
  }
  // These two are safe on a privilege list -- they look at the last token and
  // at empty brackets, neither of which a comma-separated privilege list has --
  // and they are what catches `GRANT SELECT ON TABLE t TO`.
  s.truncatedStatement();
  s.forbiddenAdjacency();
  s.emptyLists();
}

export class Stmt {
  readonly lead: string;
  readonly ddl: boolean;
  private caseSpans: [number, number][] | undefined;

  constructor(readonly toks: Token[], readonly depth: number[], readonly ctx: Ctx) {
    const first = toks[0];
    this.lead = first.kind === "word" ? first.upper! : "";
    // EXPLAIN [mode] CREATE ... is DDL too.
    let k = 0;
    while (toks[k]?.kind === "word" && ["EXPLAIN", "EXTENDED", "FORMATTED", "CODEGEN", "COST", "LOGICAL"].includes(toks[k].upper!)) k++;
    this.ddl = toks[k]?.kind === "word" && ["CREATE", "ALTER", "REPLACE", "DECLARE", "CONVERT"].includes(toks[k].upper!);
  }

  // --- token predicates ------------------------------------------------------

  /** toks[i] is one of these keywords, used as a keyword. */
  isKw(i: number, ...words: string[]): boolean {
    const t = this.toks[i];
    if (t?.kind !== "word" || !words.includes(t.upper!)) return false;
    // `AS OF` is a fixed pair (`VERSION AS OF 3`), not `AS` introducing an
    // alias, so the name-context rule must not swallow the `OF`.
    if (t.upper === "OF" && this.isKw(i - 1, "AS")) return true;
    return !isNameContext(this.toks[i - 1]);
  }

  isPunctAt(i: number, ch: string): boolean {
    const t = this.toks[i];
    return t !== undefined && isPunct(t, ch);
  }

  isOpAt(i: number, op: string): boolean {
    const t = this.toks[i];
    return t?.kind === "op" && t.text === op;
  }

  /** A word that is a name here: not a keyword, in name position, or qualifying one (`DELTA.`). */
  isName(i: number): boolean {
    const t = this.toks[i];
    if (!t) return false;
    if (t.kind === "qident") return true;
    if (t.kind !== "word") return false;
    return !KEYWORDS.has(t.upper!) || isNameContext(this.toks[i - 1]) || this.isPunctAt(i + 1, ".");
  }

  /** toks[i] could end an expression, so a word after it could only be an alias. */
  endsOperand(i: number): boolean {
    const t = this.toks[i];
    if (!t) return false;
    switch (t.kind) {
      case "qident": case "number": case "string": case "dollar":
        return true;
      case "template":
        return !t.text.startsWith("{%") && !t.text.startsWith("{#"); // a value, not a Jinja tag
      case "word":
        return this.isName(i) || !CONTINUES.has(t.upper!);
      case "punct":
        return t.text === ")" || t.text === "]";
      case "op": {
        // `SELECT *`, `t.*`, `INSERT *` -- a star, where a multiplication could not be.
        if (t.text !== "*") return false;
        const p = this.toks[i - 1];
        return !p || !(p.kind === "qident" || p.kind === "number" || p.kind === "string" || isPunct(p, ")") || (p.kind === "word" && !CONTINUES.has(p.upper!)));
      }
      default:
        return false;
    }
  }

  /** toks[i] begins an operand. */
  startsOperand(i: number): boolean {
    const t = this.toks[i];
    if (!t) return false;
    if (t.kind === "word") return this.isName(i) || !STRUCTURAL.has(t.upper!) || this.isPunctAt(i + 1, "(");
    return t.kind === "qident" || t.kind === "number" || t.kind === "string" || t.kind === "template" || isPunct(t, "(");
  }

  /** One of `words` at toks[i]'s depth within the next `limit` tokens, before any clause starts. */
  soonAtDepth(i: number, words: string[], limit: number): boolean {
    const d = this.depth[i];
    for (let k = i + 1; k < this.toks.length && k <= i + limit; k++) {
      if (this.depth[k] < d) return false;
      if (this.depth[k] > d) continue;
      if (this.isKw(k, ...words)) return true;
      if (this.isKw(k, "WHERE", "GROUP", "ORDER", "HAVING", "SELECT", "UNION", "LIMIT")) return false;
    }
    return false;
  }

  startsCondition(i: number): boolean {
    return this.startsOperand(i) || this.isOpAt(i, "-") || this.isOpAt(i, "!");
  }

  /** A real `word` keyword at the depth of toks[i], later in this query block. */
  laterAtDepth(i: number, word: string): boolean {
    const d = this.depth[i];
    for (let k = i + 1; k < this.toks.length; k++) {
      if (this.depth[k] < d) return false;
      if (this.depth[k] > d) continue;
      if (this.isKw(k, word)) return true;
      if (this.isKw(k, "SELECT", "UNION", "INTERSECT", "EXCEPT", "MINUS") || this.isOpAt(k, "|>")) return false;
    }
    return false;
  }

  /** toks[i] sits directly inside a CASE ... END (not a nested bracket). */
  insideCase(i: number): boolean {
    return this.cases().some(([c, e]) => c < i && i < e && this.depth[c] === this.depth[i]);
  }

  /** CASE ... END pairs at the same depth, within this fragment. */
  cases(): [number, number][] {
    if (this.caseSpans) return this.caseSpans;
    const spans: [number, number][] = [];
    const open: number[] = [];
    for (let i = 0; i < this.toks.length; i++) {
      if (this.isKw(i, "CASE") && !this.isKw(i - 1, "END")) open.push(i);
      else if (this.isKw(i, "END") && !this.isKw(i + 1, "IF", "LOOP", "WHILE", "FOR", "REPEAT", "CASE")) {
        for (let k = open.length - 1; k >= 0; k--) {
          if (this.depth[open[k]] === this.depth[i]) {
            spans.push([open[k], i]);
            open.splice(k, 1);
            break;
          }
        }
      }
    }
    return (this.caseSpans = spans);
  }

  private flag(t: Token): void {
    (this.ctx.flagged ??= new Set()).add(t.start);
  }

  private flaggedBetween(a: number, b: number): boolean {
    const f = this.ctx.flagged;
    if (!f) return false;
    for (let k = a; k <= b; k++) if (f.has(this.toks[k].start)) return true;
    return false;
  }

  private typo(t: Token, kw: string): void {
    report(this.ctx, "keyword-typo", "error", t, `\`${t.text}\` is not valid here. Did you mean ${kw}?`);
    this.flag(t);
  }

  // --- checks ------------------------------------------------------------------

  /** The first word of a statement must be a statement keyword. */
  statementStart(): void {
    const t = this.toks[0];
    if (t.kind !== "word" || KEYWORDS.has(t.upper!) || STARTERS.has(t.upper!)) return;
    const n = this.toks[1];
    if (n && n.kind === "op" && n.text === ":") return; // a scripting label
    const guess = [...STARTERS].find((k) => k.length >= 4 && oneEditAway(t.upper!, k));
    if (guess) {
      this.typo(t, guess);
    } else if (this.ctx.warnings && t.text.length >= 2) {
      report(this.ctx, "unknown-statement", "warning", t, `\`${t.text}\` does not start any Databricks SQL statement`);
    }
  }

  keywordTypos(): void {
    const { toks } = this;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind !== "word" || t.text.length < 3 || KEYWORDS.has(t.upper!)) continue;
      const p = toks[i - 1];
      if (isPunct(p, ".") || (p.kind === "op" && (p.text === ":" || p.text === "::"))) continue; // a qualified name
      const n = toks[i + 1];
      if (n && (isPunct(n, ".") || (n.kind === "op" && (n.text === ":" || n.text === "::")))) continue;
      const w = t.upper!;
      const guess = (targets: [string, Evidence][]): string | undefined =>
        targets.find(([k, ev]) => oneEditAway(w, k) && ev(this, i))?.[0];

      const pu = p.kind === "word" && !isNameContext(toks[i - 2]) ? p.upper! : "";
      const pp = toks[i - 2]?.kind === "word" ? toks[i - 2].upper! : "";
      // After AS only a query can be mistyped (`AS SELCT a`); anything else is an alias.
      if (pu === "AS") {
        const hit = guess(QUERY_POSITION_TARGETS);
        if (hit) this.typo(t, hit);
        continue;
      }
      let hit = guess(ANYWHERE_TARGETS);
      // After a keyword whose next word is fixed: `IS NUL`, `CRATE TABEL`, `LEFT JION`.
      if (!hit) {
        const first = i === 1 || (i === 2 && this.isKw(0, "EXPLAIN"));
        for (const f of FOLLOWERS) {
          if (f.after !== pu || (f.prev && !f.prev.includes(pp)) || (f.lead && !f.lead.includes(this.lead))) continue;
          if (f.first && !first) continue;
          if (f.evidence && !f.evidence(this, i)) continue;
          hit = f.next.find((k) => k.length >= 4 && oneEditAway(w, k));
          if (hit) break;
        }
      }
      // `CASE WEHN a = 1`: a simple CASE takes one expression, then WHEN.
      if (!hit && pu === "CASE" && oneEditAway(w, "WHEN") && this.startsOperand(i + 1)) hit = "WHEN";
      // Where a query starts: `(SELEC a`, `UNION SELET`.
      if (!hit && (isPunct(p, "(") || QUERY_POSITION_PREV.has(pu) || (p.kind === "op" && p.text === "|>"))) {
        hit = guess(QUERY_POSITION_TARGETS);
      }
      // Between two operands, where only a keyword can go: `b FORM t`, `t WHRE x`.
      if (!hit && this.endsOperand(i - 1)) hit = guess(ALIAS_POSITION_TARGETS);
      if (hit) this.typo(t, hit);
    }
  }

  /** A line starting a new statement while the previous one is unterminated. */
  missingSemicolons(): void {
    const { toks, depth, ctx } = this;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (depth[i] !== 0 || t.kind !== "word" || isNameContext(toks[i - 1])) continue;
      const multiInsert = this.isKw(0, "FROM") || this.isKw(1, "FROM");
      if (t.upper === "SELECT" || t.upper === "VALUES") {
        // A second top-level query with nothing joining it to the first.
        if (multiInsert || !toks.slice(0, i).some((_, k) => depth[k] === 0 && this.isKw(k, "SELECT", "VALUES"))) continue;
      } else {
        const rule = NEW_STATEMENT[t.upper!];
        if (rule === undefined) continue;
        if (rule && !this.isKw(i + 1, ...rule)) continue;
      }
      // WITH ... INSERT, and Hive multi-insert: [DESCRIBE] FROM t INSERT ... INSERT ...
      if (t.upper === "INSERT" && (this.lead === "WITH" || multiInsert)) continue;
      if ((t.upper === "DELETE" || t.upper === "INSERT") && this.lead === "MERGE") continue;
      // First on its line, after something that ends a statement.
      const lineStart = ctx.text.lastIndexOf("\n", t.start - 1) + 1;
      if (ctx.text.slice(lineStart, t.start).trim() !== "") continue;
      if (!this.endsOperand(i - 1)) continue;
      if (this.isKw(i - 1, "END") && ctx.scripting) continue;
      report(ctx, "missing-semicolon", "error", t, `Missing \`;\` before this ${t.upper}? The statement above has not ended.`);
      return;
    }
  }

  /** `CREATE TABLE t (a STRING COMMENT 'x' b INT)`: a column definition begins mid-item. */
  columnDefinitions(): void {
    if (!this.ddl) return;
    const { toks, depth } = this;
    for (let o = 0; o < toks.length; o++) {
      // `(a INT, ...)` at the top level, or an unbracketed `ADD COLUMNS a INT, ...`.
      if (this.isPunctAt(o, "(") && depth[o] === 0 && this.startsColumn(o + 1)) {
        this.columnItems(o + 1, 1);
      } else if (this.isKw(o, "COLUMN", "COLUMNS") && this.isKw(o - 1, "ADD") && this.startsColumn(o + 1)) {
        this.columnItems(o + 1, depth[o]);
      }
    }
  }

  /** toks[i] and toks[i+1] read as `name TYPE`. */
  private startsColumn(i: number): boolean {
    const t = this.toks[i + 1];
    return this.isName(i) && t?.kind === "word" && TYPES.has(t.upper!);
  }

  /** Walk comma-separated column items at depth d, keeping commas inside ARRAY<...> in their item. */
  private columnItems(from: number, d: number): void {
    const { toks, depth } = this;
    let angle = 0;
    let itemStart = from;
    for (let k = from; k < toks.length && depth[k] >= d; k++) {
      if (depth[k] > d) continue;
      const t = toks[k];
      if (t.kind === "op" && t.text === "<" && GENERIC.has(toks[k - 1]?.upper ?? "")) angle++;
      else if (t.kind === "op" && t.text === ">" && angle > 0) angle--;
      else if (isPunct(t, ",") && angle === 0) itemStart = k + 1;
      else if (
        angle === 0 && k >= itemStart + 2 &&
        // A column may be named with a keyword (`type STRING`), but not with one that takes an argument.
        (this.isName(k) || (t.kind === "word" && !CONTINUES.has(t.upper!) && !TYPES.has(t.upper!))) &&
        toks[k + 1]?.kind === "word" && TYPES.has(toks[k + 1].upper!) && depth[k + 1] === d &&
        this.endsOperand(k - 1) && !this.ctx.flagged?.has(t.start)
      ) {
        report(this.ctx, "missing-comma", "error", t, `Missing comma before \`${t.text}\`? It starts a new column definition.`);
        itemStart = k;
      }
    }
  }

  /** WHERE before GROUP BY before HAVING ..., each at most once per query block. */
  clauseOrder(): void {
    const { toks, depth } = this;
    for (let s = 0; s < toks.length; s++) {
      if (!this.isKw(s, "SELECT")) continue;
      const d = depth[s];
      const seen = new Map<string, number>(); // clause -> index
      let top = 0;
      let topName = "";
      for (let k = s + 1; k < toks.length; k++) {
        if (depth[k] < d) break;
        if (depth[k] > d) continue;
        if (this.isKw(k, "SELECT", "UNION", "INTERSECT", "EXCEPT", "MINUS") || this.isOpAt(k, "|>")) break;
        let name = "";
        if (this.isKw(k, "WHERE", "HAVING", "QUALIFY", "LIMIT", "OFFSET")) name = toks[k].upper!;
        else if (this.isKw(k, "GROUP", "ORDER", "CLUSTER", "DISTRIBUTE", "SORT") && this.isKw(k + 1, "BY")) name = `${toks[k].upper} BY`;
        if (!name) continue;
        const rank = CLAUSE_RANK[name];
        if (seen.has(name)) {
          const hint = name === "WHERE" || name === "HAVING" ? ": combine the conditions with AND" : "";
          report(this.ctx, "clause-order", "error", toks[k], `A second ${name} in the same query${hint}`);
        } else if (rank < top) {
          report(this.ctx, "clause-order", "error", toks[k], `${name} must come before ${topName}`);
        }
        seen.set(name, k);
        if (rank > top) {
          top = rank;
          topName = name;
        }
      }
    }
  }

  /** CASE [x] WHEN ... THEN ... [WHEN ... THEN ...] [ELSE ...] END */
  caseStructure(): void {
    for (const [c, e] of this.cases()) {
      if (this.flaggedBetween(c, e)) continue;
      const d = this.depth[c];
      let state: "start" | "when" | "then" | "else" = "start";
      let lastWhen = c;
      let nested = 0;
      const bad = (k: number, msg: string): void => report(this.ctx, "case-structure", "error", this.toks[k], msg);
      for (let k = c + 1; k < e; k++) {
        if (this.depth[k] !== d) continue;
        if (this.isKw(k, "CASE") && !this.isKw(k - 1, "END")) nested++;
        else if (this.isKw(k, "END") && nested > 0) nested--;
        if (nested > 0 || this.isKw(k, "CASE")) continue;
        if (this.isKw(k, "WHEN")) {
          if (state === "when") return bad(lastWhen, "WHEN has no THEN");
          if (state === "else") return bad(k, "WHEN after ELSE: ELSE must be the last branch");
          state = "when";
          lastWhen = k;
        } else if (this.isKw(k, "THEN")) {
          if (state !== "when") return bad(k, "THEN without a WHEN before it");
          state = "then";
        } else if (this.isKw(k, "ELSE")) {
          if (state === "when") return bad(lastWhen, "WHEN has no THEN");
          if (state === "start") return bad(k, "ELSE before any WHEN");
          if (state === "else") return bad(k, "A second ELSE in the same CASE");
          state = "else";
        }
      }
      if (state === "when") bad(lastWhen, "WHEN has no THEN");
      else if (state === "start") bad(c, "CASE has no WHEN");
    }
  }

  /** `WHERE a > 1 AND` / `WHERE GROUP BY` / `SELECT FROM t`: a keyword with nothing after it. */
  danglingKeywords(): void {
    const { toks, ctx } = this;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind !== "word" || !this.isKw(i, t.upper!)) continue;
      const forbidden = DANGLING[t.upper!];
      if (!forbidden) continue;
      if (t.upper === "BY" && !this.isKw(i - 1, "GROUP", "ORDER", "PARTITION", "CLUSTER", "SORT", "DISTRIBUTE", "PARTITIONED", "CLUSTERED", "ZORDER")) continue;
      if (t.upper === "FROM" && this.isKw(i - 1, "DISTINCT")) continue;
      const p = toks[i - 1];
      // After `,` or `(`, Spark lets most keywords be column names.
      if (p && (isPunct(p, ",") || isPunct(p, "("))) continue;
      if (this.ctx.flagged?.has(t.start)) continue;
      const n = toks[i + 1];
      if (!n) {
        if (!ctx.openEnded) report(ctx, "dangling-keyword", "error", t, `${t.upper} has nothing after it`);
        continue;
      }
      if (isWild(n)) continue;
      if (isPunct(n, ")") || isPunct(n, ",")) {
        report(ctx, "dangling-keyword", "error", t, `${t.upper} has nothing after it before \`${n.text}\``);
        continue;
      }
      if (n.kind !== "word" || !this.isKw(i + 1, n.upper!)) continue;
      const nextName = this.isKw(i + 2, "BY") && ["GROUP", "ORDER"].includes(n.upper!) ? `${n.upper} BY` : n.upper!;
      if (!forbidden.includes(nextName)) continue;
      if ((nextName === "GROUP" || nextName === "ORDER")) continue; // GROUP / ORDER without BY
      report(ctx, "dangling-keyword", "error", t, `${t.upper} is followed directly by ${nextName}: something is missing between them`);
    }
  }

  /**
   * A statement that stops on a keyword still owing an operand:
   * `ALTER VIEW v RENAME TO`, `CREATE SCHEMA s COMMENT`, `DROP SCHEMA`.
   *
   * Only the last token is judged, and only when the lexer reached a real end
   * (`openEnded` means an unterminated token already truncated the input, so
   * the statement is cut off for a reason already reported).
   */
  truncatedStatement(): void {
    const { toks, ctx } = this;
    if (ctx.openEnded) return;
    const i = toks.length - 1;
    const t = toks[i];
    if (t.kind !== "word" || !this.isKw(i, t.upper!)) return;
    if (ctx.flagged?.has(t.start)) return;
    const u = t.upper!;
    const p = toks[i - 1];
    // After `,` or `(` Spark reads most keywords as a column name.
    if (p && (isPunct(p, ",") || isPunct(p, "("))) return;
    const say = (why: string): void => report(ctx, "dangling-keyword", "error", t, why);

    if (NEEDS_FOLLOWER.has(u)) {
      return say(`${u} has nothing after it: the statement is incomplete`);
    }
    // A two-word tail, where neither word alone is evidence: `LOCATION` cannot
    // go in NEEDS_FOLLOWER because a column may be called `location`, but
    // `MANAGED LOCATION` is never a name.
    if (p?.kind === "word" && this.isKw(i - 1, p.upper!) &&
        NEEDS_FOLLOWER_PAIRS.has(`${p.upper} ${u}`)) {
      return say(`${p.text} ${t.text} has nothing after it: the statement is incomplete`);
    }
    // A clause keyword directly after the name it applies to.
    if (NEEDS_FOLLOWER_AFTER_NAME.has(u) && this.ddl && p !== undefined &&
        (this.isName(i - 1) || isPunct(p, ")"))) {
      return say(`${u} has nothing after it: the statement is incomplete`);
    }
    // `DROP SCHEMA`, `SHOW CREATE TABLE`: an object type and no object named.
    if (OBJECT_TYPES.has(u) && OBJECT_VERBS.has(this.lead) && p?.kind === "word" &&
        (OBJECT_VERBS.has(p.upper!) || OBJECT_MODIFIER_WORDS.has(p.upper!)) &&
        !this.namesSomething()) {
      return say(`${u} needs a name: nothing in this statement names the ${u.toLowerCase()}`);
    }
  }

  /**
   * `ANALYZE TABLE COMPUTE STATISTICS`: every token is a keyword, the brackets
   * balance and nothing dangles -- what is missing is the name between two
   * words. Only pairs in FORBIDDEN_PAIRS fire, and only under their statement
   * lead, so syntax this does not know produces no finding.
   */
  forbiddenAdjacency(): void {
    const { toks, depth, ctx } = this;
    for (let i = 1; i < toks.length; i++) {
      if (depth[i] !== 0 || depth[i - 1] !== 0) continue;
      const a = toks[i - 1];
      const b = toks[i];
      if (a.kind !== "word" || b.kind !== "word") continue;
      const rule = FORBIDDEN_PAIRS.get(`${a.upper} ${b.upper}`);
      if (rule === undefined) continue;
      if (rule.lead !== undefined && rule.lead !== this.lead) continue;
      // Both must be keywords here, not names: Spark lets almost any keyword be
      // an identifier, and `AS`/`.` context is what tells them apart.
      if (!this.isKw(i - 1, a.upper!) || !this.isKw(i, b.upper!)) continue;
      if (ctx.flagged?.has(a.start) || ctx.flagged?.has(b.start)) continue;
      report(ctx, "statement-shape", "error", b, `${rule.why}: \`${a.text} ${b.text}\``);
      return; // one shape complaint per statement is enough
    }
  }

  /**
   * `FROM (a, b FROM t)`: a query that has lost its `SELECT`. Checked only where
   * something says a query must begin -- a positive signal, never an unknown
   * statement lead:
   *
   *  - inside a bracket whose owner says so: `FROM (`, `EXISTS (`, `IN (`, a
   *    CTE's `AS (`, `= (`, `> (`. A word not in QUERY_BRACKET_OWNERS owns a
   *    function call, where `FROM` is ordinary syntax: `extract(YEAR FROM d)`;
   *  - after a set operator: `UNION ALL a, b FROM t`;
   *  - after a `WITH` statement's CTE list: `WITH c AS (...) a, b FROM c`.
   *
   * A `FROM` that opens the segment is a FROM-first query -- Hive's
   * `(FROM t SELECT a)`, or pipe syntax `(FROM t |> WHERE x)` -- and is fine.
   *
   * Not done after `CREATE ... AS`: `CREATE FLOW f AS AUTO CDC INTO t FROM s`
   * is valid, and nothing at this depth tells it from a lost `SELECT`. Not done
   * at statement level either: `a, b FROM t` already warns as an unknown
   * statement, and an unknown lead is not evidence of anything.
   */
  queryWithoutSelect(): void {
    const { toks, depth } = this;
    const open: number[] = [];
    let cteHeader = this.lead === "WITH";
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (isPunct(t, "(")) {
        open.push(i);
        if (this.ownsQuery(i - 1)) this.querySegment(i + 1, depth[i] + 1);
      } else if (isPunct(t, ")")) {
        const o = open.pop();
        // The end of a CTE body, while still in the WITH clause's header.
        if (cteHeader && o !== undefined && depth[i] === 0 && this.isKw(o - 1, "AS")) {
          this.querySegment(i + 1, 0);
        }
      } else if (t.kind === "word" && this.isKw(i, t.upper!)) {
        if (depth[i] === 0 && t.upper === "SELECT") cteHeader = false;
        if (SET_OPERATORS.has(t.upper!) && !(t.upper === "EXCEPT" && toks[i - 1]?.text === "*")) {
          let k = i + 1;
          while (toks[k]?.kind === "word" && ["ALL", "DISTINCT", "BY", "NAME"].includes(toks[k].upper!)) k++;
          this.querySegment(k, depth[i]);
        }
      }
    }
  }

  /** Does the token at `j` say the bracket after it holds a query? */
  private ownsQuery(j: number): boolean {
    const owner = this.toks[j];
    if (owner === undefined) return true;
    if (isPunct(owner, "(") || isPunct(owner, ",")) return true;
    if (owner.kind === "op") return owner.text !== "|>";
    return owner.kind === "word" && QUERY_BRACKET_OWNERS.has(owner.upper!) && this.isKw(j, owner.upper!);
  }

  /** From `s` at depth `d`: a `FROM` that does not open the query and has no `SELECT` before it. */
  private querySegment(s: number, d: number): void {
    const { toks, depth, ctx } = this;
    for (let k = s; k < toks.length && depth[k] >= d; k++) {
      if (depth[k] > d) continue;
      const t = toks[k];
      if (t.kind !== "word" || !KEYWORDS.has(t.upper!) || !this.isKw(k, t.upper!)) continue;
      const u = t.upper!;
      if (u === "SELECT" || u === "WITH" || SET_OPERATORS.has(u) || NOT_A_SELECT_LIST.has(u)) return;
      if (u !== "FROM") continue;
      if (k > s && !ctx.flagged?.has(t.start)) {
        report(ctx, "missing-keyword", "error", t,
          "`FROM` with nothing selected: a query starts here, and no `SELECT` comes before its `FROM`");
      }
      return;
    }
  }

  /**
   * `FROM a, b x = y`: a comparison in a FROM list that has no join. A table
   * reference never holds a bare comparison at the clause's own depth, so one
   * here means the `WHERE` in front of it is gone. Any join keyword turns the
   * check off for the rest of the clause, because from there `=` may be an
   * `ON` condition.
   */
  comparisonInFromList(): void {
    const { toks, depth, ctx } = this;
    for (let f = 0; f < toks.length; f++) {
      if (!this.isKw(f, "FROM")) continue;
      const d = depth[f];
      let joined = false;
      for (let k = f + 1; k < toks.length && depth[k] >= d; k++) {
        if (depth[k] > d) continue;
        const t = toks[k];
        if (t.kind === "op") {
          if (t.text === "|>") break; // a pipe operator starts a new clause
          if (!COMPARISONS.has(t.text)) continue;
          if (!joined && !ctx.flagged?.has(t.start)) {
            report(ctx, "missing-keyword", "error", t,
              `\`${t.text}\` inside the FROM list: is a \`WHERE\` missing before this comparison?`);
          }
          break;
        }
        // A table name or alias is not a keyword and does not end the clause.
        if (t.kind !== "word" || !KEYWORDS.has(t.upper!) || !this.isKw(k, t.upper!)) continue;
        if (FROM_JOINS.has(t.upper!)) joined = true;
        if (!IN_FROM_CLAUSE.has(t.upper!)) break; // the FROM clause has ended
      }
    }
  }

  /** True when any token could be the object's name, or part of its value. */
  private namesSomething(): boolean {
    for (let k = 1; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.kind === "qident" || t.kind === "number" || t.kind === "string" ||
          t.kind === "dollar" || t.kind === "template") return true;
      if (t.kind === "word" && k < this.toks.length - 1 && this.isName(k)) return true;
    }
    return false;
  }

  /** `ALTER SCHEMA s SET DBPROPERTIES ()`: a required list with nothing in it. */
  emptyLists(): void {
    const { toks } = this;
    for (let i = 1; i + 1 < toks.length; i++) {
      if (!isPunct(toks[i], "(") || !isPunct(toks[i + 1], ")")) continue;
      const owner = toks[i - 1];
      if (owner.kind !== "word" || !this.isKw(i - 1, owner.upper!)) continue;
      let name = owner.text;
      let known = EMPTY_LIST_OWNERS.has(owner.upper!);
      // `BY` alone owns far too much (`GROUP BY`, `PARTITION BY`, and Spark's
      // own suite writes `group by ()`), so it is not an owner on its own. The
      // pair is: `OPTIMIZE e ZORDER BY ()` and `SORTED BY ()` are both empty
      // lists, and the word before `BY` is what says so.
      if (!known && owner.upper === "BY" && toks[i - 2]?.kind === "word" &&
          this.isKw(i - 2, ...EMPTY_LIST_OWNER_PAIRS)) {
        known = true;
        name = `${toks[i - 2].text} ${owner.text}`;
      }
      if (!known) continue;
      report(this.ctx, "empty-list", "error", toks[i],
        `\`${name} ()\` is empty: this list needs at least one entry`);
    }
  }

  /** `=>` names a function argument; anywhere else it is a mistyped `>=`. */
  namedArgumentArrows(): void {
    const { toks, depth } = this;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind !== "op") continue;
      if (t.text === "=" && toks[i + 1]?.kind === "op" && toks[i + 1].start === t.end && ["<", ">"].includes(toks[i + 1].text)) {
        report(this.ctx, "operator-typo", "error", t, `\`=${toks[i + 1].text}\` is not an operator. Did you mean \`${toks[i + 1].text}=\`?`);
        continue;
      }
      if (t.text !== "=>") continue;
      // Find the enclosing bracket: named arguments live in a call's parentheses.
      let k = i - 1;
      while (k >= 0 && !(depth[k] === depth[i] - 1 && isPunct(toks[k], "("))) k--;
      if (k >= 0 && toks[k - 1]?.kind === "word") continue;
      report(this.ctx, "operator-typo", "error", t, "`=>` only names a function argument. Did you mean `>=`?");
    }
  }
}

/**
 * `SET k = v` takes the rest of the statement as raw text, so a missing `;`
 * after it makes Spark read the next statement as part of the value -- a
 * silent misconfiguration rather than an error. Flag a line that starts a
 * statement inside one.
 */
export function checkRawTail(toks: Token[], ctx: Ctx): void {
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "word") continue;
    const u = t.upper!;
    const rule = NEW_STATEMENT[u];
    const next = toks[i + 1]?.kind === "word" ? toks[i + 1].upper! : "";
    const starts =
      ["SELECT", "WITH", "SET", "RESET"].includes(u) || (rule !== undefined && (rule === null || rule.includes(next)));
    if (!starts) continue;
    const lineStart = ctx.text.lastIndexOf("\n", t.start - 1) + 1;
    if (ctx.text.slice(lineStart, t.start).trim() !== "") continue;
    report(ctx, "missing-semicolon", "error", t, `Missing \`;\` before this ${u}? Without it, ${toks[0].upper} reads this line as part of its value.`);
    return;
  }
}
